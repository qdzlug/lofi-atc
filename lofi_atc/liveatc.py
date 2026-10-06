"""Feed discovery: look up any airport's feeds on LiveATC's search page."""

from __future__ import annotations

import html
import re
import threading
import time
import urllib.error
from typing import Callable
from urllib.parse import quote

from .ratelimit import RateLimited, RateLimiter
from .upstream import open_url, parse_retry_after

ICAO_RE = re.compile(r"^[A-Z0-9]{3,4}$")
MAX_PAGE_BYTES = 2 * 1024 * 1024

# LiveATC has no API, so we scan the search page for three kinds of token, in
# document order: a feed's bold title, its UP/DOWN status, and its
# "/play/<mount>.pls" listen link. Each link becomes a feed labelled with the
# most recent title and status seen before it. Anything we can't label falls
# back to the mount name, so markup changes degrade rather than break.
_TOKEN_RE = re.compile(
    r"<strong>(?P<label>.*?)</strong>|>\s*(?P<status>UP|DOWN)\s*<|/play/(?P<mount>[A-Za-z0-9_]+)\.pls",
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")


class SearchError(Exception):
    """LiveATC could not be reached or answered with an error."""


def _clean(fragment: str) -> str:
    return " ".join(html.unescape(_TAG_RE.sub(" ", fragment)).split())


def parse_search_results(page: str) -> list[dict]:
    """Extract [{mount, label, status}] from a LiveATC search results page."""
    feeds: list[dict] = []
    seen: set[str] = set()
    label: str | None = None
    status: str | None = None
    for m in _TOKEN_RE.finditer(page):
        if m.group("mount"):
            mount = m.group("mount").lower()
            if mount not in seen:
                seen.add(mount)
                feeds.append({"mount": mount, "label": label or mount, "status": status})
            continue
        text = _clean(m.group("label") or m.group("status") or "")
        if text.upper() in ("UP", "DOWN"):
            status = text.upper()
        elif text and not text.endswith(":"):  # skip field captions like "Listeners:"
            label, status = text, None
    return feeds


def _fetch_page(url: str, timeout: float) -> str:
    with open_url(url, timeout) as resp:
        return resp.read(MAX_PAGE_BYTES).decode("utf-8", errors="replace")


class FeedDirectory:
    """Cached, rate-limited airport → feeds lookups against LiveATC."""

    def __init__(
        self,
        limiter: RateLimiter,
        base_url: str = "https://www.liveatc.net",
        ttl: float = 15 * 60,
        timeout: float = 10.0,
        default_retry_after: float = 10.0,
        fetch: Callable[[str, float], str] = _fetch_page,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.limiter = limiter
        self.base_url = base_url.rstrip("/")
        self.ttl = ttl
        self.timeout = timeout
        self.default_retry_after = default_retry_after
        self._fetch = fetch
        self._clock = clock
        self._cache: dict[str, tuple[float, list[dict]]] = {}
        self._lock = threading.Lock()

    def search(self, icao: str) -> list[dict]:
        """Return feeds for `icao` (already validated with ICAO_RE).

        Raises RateLimited while cooling down from a 429, SearchError otherwise.
        """
        with self._lock:
            hit = self._cache.get(icao)
            if hit and self._clock() - hit[0] < self.ttl:
                return hit[1]

        self.limiter.acquire()
        url = f"{self.base_url}/search/?icao={quote(icao)}"
        try:
            page = self._fetch(url, self.timeout)
        except urllib.error.HTTPError as e:
            e.close()
            if e.code == 429:
                retry = parse_retry_after(e.headers.get("Retry-After"), self.default_retry_after)
                self.limiter.penalize(retry)
                raise RateLimited(retry) from e
            raise SearchError(f"LiveATC returned HTTP {e.code}") from e
        except OSError as e:  # URLError, timeouts, connection resets
            raise SearchError(f"LiveATC unreachable: {e}") from e

        feeds = parse_search_results(page)
        with self._lock:
            self._cache[icao] = (self._clock(), feeds)
        return feeds
