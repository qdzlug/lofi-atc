"""HTTP server: serves the UI and proxies LiveATC streams."""

from __future__ import annotations

import http.client
import json
import logging
import math
import threading
import urllib.error
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .config import MOUNT_RE, Stations
from .liveatc import ICAO_RE, FeedDirectory, SearchError
from .ratelimit import RateLimited, RateLimiter
from .upstream import open_url, parse_retry_after

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).with_name("static")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}


@dataclass(frozen=True)
class ProxySettings:
    upstream_base: str = "https://d.liveatc.net/"
    upstream_timeout: float = 10.0
    chunk_size: int = 8192
    max_streams: int = 4
    # Cooldown applied after LiveATC answers 429 without a usable Retry-After.
    default_retry_after: float = 10.0


class LofiATCServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        stations: Stations,
        limiter: RateLimiter,
        settings: ProxySettings | None = None,
        directory: FeedDirectory | None = None,
        static_dir: Path = STATIC_DIR,
    ):
        self.stations = stations
        self.directory = directory or FeedDirectory(limiter)
        self.stations_json = json.dumps(stations.to_dict()).encode()
        self.limiter = limiter
        self.settings = settings = settings or ProxySettings()
        self.static_files = {
            p.name: p for p in static_dir.iterdir() if p.is_file() and p.suffix in CONTENT_TYPES
        }
        self._stream_slots = threading.BoundedSemaphore(settings.max_streams)
        self._active_lock = threading.Lock()
        self.active_streams = 0
        super().__init__(address, RequestHandler)

    def try_open_stream_slot(self) -> bool:
        if not self._stream_slots.acquire(blocking=False):
            return False
        with self._active_lock:
            self.active_streams += 1
        return True

    def release_stream_slot(self) -> None:
        with self._active_lock:
            self.active_streams -= 1
        self._stream_slots.release()


class RequestHandler(BaseHTTPRequestHandler):
    server: LofiATCServer
    server_version = f"lofi-atc/{__version__}"

    # ── routing ──

    def do_GET(self) -> None:
        self._route(head=False)

    def do_HEAD(self) -> None:
        self._route(head=True)

    def _route(self, head: bool) -> None:
        url = urlsplit(self.path)
        path = url.path
        if path.startswith("/atc/"):
            if head:
                self._send_text(405, "Method not allowed", {"Allow": "GET"})
            else:
                self._proxy_atc(path[len("/atc/") :])
        elif path == "/api/stations":
            self._send_bytes(200, self.server.stations_json, "application/json", head)
        elif path == "/api/search":
            self._search(parse_qs(url.query).get("icao", [""])[0], head)
        elif path == "/healthz":
            body = json.dumps(
                {"status": "ok", "version": __version__, "active_streams": self.server.active_streams}
            ).encode()
            self._send_bytes(200, body, "application/json", head)
        else:
            self._serve_static("index.html" if path == "/" else path.lstrip("/"), head)

    # ── responses ──

    def _send_bytes(
        self, code: int, body: bytes, content_type: str, head: bool = False, headers: dict | None = None
    ) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _send_text(self, code: int, message: str, headers: dict | None = None) -> None:
        self._send_bytes(code, message.encode() + b"\n", "text/plain; charset=utf-8", headers=headers)

    def _serve_static(self, name: str, head: bool) -> None:
        path = self.server.static_files.get(name)
        if path is None:
            self._send_text(404, "Not found")
            return
        try:
            body = path.read_bytes()
        except OSError as e:
            log.error("cannot read static file %s: %s", path, e)
            self._send_text(500, "Internal server error")
            return
        self._send_bytes(200, body, CONTENT_TYPES[path.suffix], head)

    def _send_json(self, code: int, obj, head: bool = False, headers: dict | None = None) -> None:
        self._send_bytes(code, json.dumps(obj).encode(), "application/json", head, headers)

    # ── feed search ──

    def _search(self, icao: str, head: bool) -> None:
        icao = icao.strip().upper()
        if not ICAO_RE.match(icao):
            self._send_json(400, {"error": "expected a 3-4 character airport code like KBOS"}, head)
            return
        try:
            feeds = self.server.directory.search(icao)
        except RateLimited as e:
            retry = str(math.ceil(e.retry_after))
            self._send_json(429, {"error": "rate limited by LiveATC"}, head, {"Retry-After": retry})
            return
        except SearchError as e:
            log.warning("search %s failed: %s", icao, e)
            self._send_json(502, {"error": str(e)}, head)
            return
        log.info("search %s: %d feeds", icao, len(feeds))
        self._send_json(200, {"icao": icao, "feeds": feeds}, head)

    # ── ATC proxy ──

    def _proxy_atc(self, mount: str) -> None:
        if not MOUNT_RE.match(mount):
            self._send_text(400, "Invalid feed name")
            return
        if not self.server.try_open_stream_slot():
            log.warning("rejecting %s: %d streams already open", mount, self.server.settings.max_streams)
            self._send_text(503, "Too many open streams", {"Retry-After": "5"})
            return
        try:
            self._stream_upstream(mount)
        finally:
            self.server.release_stream_slot()

    def _stream_upstream(self, mount: str) -> None:
        settings = self.server.settings
        try:
            self.server.limiter.acquire()
        except RateLimited as e:
            log.info("%s: still cooling down from upstream 429 (%.0fs left)", mount, e.retry_after)
            self._send_text(429, "Rate limited by LiveATC", {"Retry-After": str(math.ceil(e.retry_after))})
            return

        url = settings.upstream_base.rstrip("/") + "/" + mount
        log.info("%s: connecting upstream", mount)
        try:
            resp = open_url(url, settings.upstream_timeout)
        except urllib.error.HTTPError as e:
            e.close()
            log.warning("%s: upstream HTTP %d %s", mount, e.code, e.reason)
            if e.code == 429:
                retry = parse_retry_after(e.headers.get("Retry-After"), settings.default_retry_after)
                self.server.limiter.penalize(retry)
                self._send_text(429, "Rate limited by LiveATC", {"Retry-After": str(math.ceil(retry))})
            elif e.code == 404:
                self._send_text(404, f"Feed offline: {mount}")
            else:
                self._send_text(502, f"LiveATC returned HTTP {e.code}")
            return
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            log.warning("%s: upstream connection failed: %s", mount, e)
            self._send_text(502, "LiveATC unreachable")
            return

        with resp:
            # Headers are committed from here on: errors can only end the stream.
            self.send_response(200)
            self.send_header("Content-Type", resp.headers.get("Content-Type", "audio/mpeg"))
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            log.info("%s: streaming", mount)
            sent = self._pump(resp, mount)
            log.info("%s: stream ended after %d bytes", mount, sent)

    def _pump(self, resp, mount: str) -> int:
        sent = 0
        chunk_size = self.server.settings.chunk_size
        while True:
            try:
                chunk = resp.read1(chunk_size)
            except (OSError, http.client.HTTPException) as e:
                log.warning("%s: upstream read failed: %s", mount, e)
                return sent
            if not chunk:
                return sent
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except OSError:  # client went away (BrokenPipe, ConnectionReset, ...)
                return sent
            sent += len(chunk)

    # ── logging ──

    def log_message(self, format: str, *args) -> None:
        log.debug("%s %s", self.address_string(), format % args)

    def log_error(self, format: str, *args) -> None:
        log.warning("%s %s", self.address_string(), format % args)
