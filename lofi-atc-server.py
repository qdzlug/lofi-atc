#!/usr/bin/env python3
"""
lofi + atc — a tiny server that serves the UI and proxies LiveATC streams.

Usage:
    python3 lofi-atc-server.py

Then open http://localhost:7331 in your browser.
Requires: Python 3.9+ (uses only stdlib — no pip installs needed).
"""

import http.server
import socketserver
import urllib.request
import threading
import time
import os
import sys
import signal

PORT = 7331

# ── HTML served at / ──
HTML_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lofi-atc.html")

# ── Rate-limit protection ──
# Track last request time globally so we don't hammer LiveATC
_last_request_time = 0
_request_lock = threading.Lock()
MIN_REQUEST_GAP = 1.5  # seconds between requests to LiveATC


def rate_limited_fetch(url, timeout=10):
    """Fetch a URL with global rate limiting to avoid 429s."""
    global _last_request_time
    with _request_lock:
        now = time.time()
        wait = MIN_REQUEST_GAP - (now - _last_request_time)
        if wait > 0:
            time.sleep(wait)
        _last_request_time = time.time()

    req = urllib.request.Request(url, headers={
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.liveatc.net/",
        "Accept": "*/*",
    })
    return urllib.request.urlopen(req, timeout=timeout)


class ATCProxyHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the UI at / and proxies ATC streams at /atc/<mount>."""

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.serve_ui()
        elif self.path.startswith("/atc/"):
            self.proxy_atc()
        else:
            self.send_error(404)

    def serve_ui(self):
        try:
            with open(HTML_FILE, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", len(content))
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_error(500, "lofi-atc.html not found next to server script")

    def proxy_atc(self):
        mount = self.path[5:]  # strip "/atc/"
        if not mount or "/" in mount or ".." in mount:
            self.send_error(400, "Bad mount point")
            return

        url = f"https://d.liveatc.net/{mount}"
        try:
            print(f"  [proxy] connecting to {mount}...")
            resp = rate_limited_fetch(url)

            self.send_response(200)
            self.send_header("Content-Type", resp.headers.get("Content-Type", "audio/mpeg"))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            print(f"  [proxy] streaming {mount}")
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
            return
        except urllib.error.HTTPError as e:
            print(f"  [proxy] {mount} failed: HTTP {e.code} {e.reason}")
            if e.code == 429:
                # Tell the client to back off
                self.send_response(429)
                self.send_header("Retry-After", "5")
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Rate limited by LiveATC - wait a few seconds and try again")
                return
        except Exception as e:
            print(f"  [proxy] {mount} failed: {e}")

        self.send_error(502, f"LiveATC stream unavailable: {mount}")

    def log_message(self, format, *args):
        msg = format % args
        if "200" not in msg and "proxy" not in msg:
            print(f"  {msg}")


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    if not os.path.exists(HTML_FILE):
        print(f"ERROR: {HTML_FILE} not found.")
        print("Make sure lofi-atc.html is in the same folder as this script.")
        sys.exit(1)

    server = ThreadedServer(("0.0.0.0", PORT), ATCProxyHandler)

    def shutdown(sig, frame):
        print("\nShutting down...")
        os._exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f"""
  ╔═══════════════════════════════════════╗
  ║         lofi + atc                    ║
  ║  ───────────────────────────────────  ║
  ║  Open http://localhost:{PORT}          ║
  ║  Press Ctrl+C to stop                 ║
  ╚═══════════════════════════════════════╝
""")

    if sys.platform == "darwin":
        os.system(f"open http://localhost:{PORT}")

    server.serve_forever()


if __name__ == "__main__":
    main()
