import io
import urllib.error
from email.message import Message
from pathlib import Path

import pytest

from lofi_atc.liveatc import BrowserCheckRequired, FeedDirectory, SearchError, parse_search_results
from lofi_atc.ratelimit import RateLimited, RateLimiter

FIXTURE = (Path(__file__).parent / "fixtures" / "liveatc_search_kbos.html").read_text()


def test_parses_feeds_labels_and_status():
    assert parse_search_results(FIXTURE) == [
        {"mount": "kbos_twr", "label": "KBOS Del/Gnd/Twr", "status": "UP"},
        {"mount": "kbos_app", "label": "KBOS Final Approach & Departure", "status": "DOWN"},
        # A link with no title of its own inherits the nearest preceding one.
        {"mount": "kbos_misc", "label": "KBOS Final Approach & Departure", "status": "DOWN"},
    ]


def test_unknown_markup_still_yields_mounts():
    page = '<div><a href="https://www.liveatc.net/play/cyyz_twr.pls">x</a></div>'
    assert parse_search_results(page) == [{"mount": "cyyz_twr", "label": "cyyz_twr", "status": None}]


def test_no_results():
    assert parse_search_results("<html>No results found</html>") == []


def http_error(code, retry_after=None, **extra_headers):
    headers = Message()
    if retry_after:
        headers["Retry-After"] = retry_after
    for k, v in extra_headers.items():
        headers[k.replace("_", "-")] = v
    return urllib.error.HTTPError("http://x", code, "err", headers, io.BytesIO())


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


def test_search_caches_results():
    calls = []
    clock = Clock()

    def fetch(url, timeout):
        calls.append(url)
        return FIXTURE

    d = FeedDirectory(RateLimiter(0), ttl=60, fetch=fetch, clock=clock)
    assert len(d.search("KBOS")) == 3
    d.search("KBOS")
    assert calls == ["https://www.liveatc.net/search/?icao=KBOS"]
    clock.now = 61
    d.search("KBOS")
    assert len(calls) == 2


def test_search_429_starts_cooldown():
    limiter = RateLimiter(0)

    def fetch(url, timeout):
        raise http_error(429, "20")

    d = FeedDirectory(limiter, fetch=fetch)
    with pytest.raises(RateLimited):
        d.search("KBOS")
    with pytest.raises(RateLimited) as exc:
        limiter.acquire()
    assert exc.value.retry_after > 19


@pytest.mark.parametrize("error", [http_error(503), urllib.error.URLError("dns"), TimeoutError()])
def test_search_errors(error):
    def fetch(url, timeout):
        raise error

    with pytest.raises(SearchError):
        FeedDirectory(RateLimiter(0), fetch=fetch).search("KBOS")


def test_search_detects_cloudflare_challenge():
    def fetch(url, timeout):
        raise http_error(403, cf_mitigated="challenge")

    with pytest.raises(BrowserCheckRequired):
        FeedDirectory(RateLimiter(0), fetch=fetch).search("KBOS")
