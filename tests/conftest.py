from __future__ import annotations

import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from lofi_atc.config import load_stations
from lofi_atc.liveatc import FeedDirectory
from lofi_atc.ratelimit import RateLimiter
from lofi_atc.server import LofiATCServer, ProxySettings

STREAM_BODY = b"ID3" + bytes(range(256)) * 64


class FakeLiveATC(BaseHTTPRequestHandler):
    """Stands in for d.liveatc.net. Behaviour is chosen by mount name."""

    hits: list[str] = []
    release = threading.Event()

    def do_GET(self):
        mount = self.path.lstrip("/")
        FakeLiveATC.hits.append(mount)
        if mount.startswith("ok"):
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.end_headers()
            self.wfile.write(STREAM_BODY)
        elif mount.startswith("ratelimited"):
            self.send_response(429)
            self.send_header("Retry-After", "7")
            self.end_headers()
        elif mount.startswith("hang"):
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.end_headers()
            self.wfile.write(b"x" * 16)
            self.wfile.flush()
            FakeLiveATC.release.wait(10)
        elif mount.startswith("broken"):
            self.send_response(500)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


def _serve(server):
    t = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    t.start()
    return server


@pytest.fixture
def upstream():
    FakeLiveATC.hits = []
    FakeLiveATC.release = threading.Event()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeLiveATC)
    srv.daemon_threads = True
    _serve(srv)
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    FakeLiveATC.release.set()
    srv.shutdown()
    srv.server_close()


class FakeSearch:
    def __init__(self):
        self.pages: dict[str, str] = {}
        self.error: Exception | None = None
        self.calls: list[str] = []

    def __call__(self, url, timeout):
        self.calls.append(url)
        if self.error:
            raise self.error
        icao = url.rsplit("=", 1)[1]
        return self.pages.get(icao, "<html>no results</html>")


@pytest.fixture
def search():
    return FakeSearch()


@pytest.fixture
def make_app(upstream, search):
    servers = []

    def make(max_streams=4, spotify_client_id=None):
        limiter = RateLimiter(0)
        app = LofiATCServer(
            ("127.0.0.1", 0),
            load_stations(),
            limiter,
            ProxySettings(upstream_base=upstream, upstream_timeout=5, max_streams=max_streams),
            directory=FeedDirectory(limiter, fetch=search),
            spotify_client_id=spotify_client_id,
        )
        servers.append(_serve(app))
        return app

    yield make
    for s in servers:
        s.shutdown()
        s.server_close()


@pytest.fixture
def app(make_app):
    return make_app()


class Client:
    def __init__(self, base):
        self.base = base

    def request(self, path, method="GET"):
        """Return (status, headers, body) without raising on HTTP errors."""
        req = urllib.request.Request(self.base + path, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.headers, e.read()


@pytest.fixture
def client(app):
    return Client(f"http://127.0.0.1:{app.server_address[1]}")


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False
