"""Outbound HTTP to LiveATC."""

from __future__ import annotations

import urllib.request

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.liveatc.net/",
    "Accept": "*/*",
}


def open_url(url: str, timeout: float):
    """Open a LiveATC URL with headers that get past their CDN."""
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout)


def parse_retry_after(value: str | None, default: float) -> float:
    """Seconds from a Retry-After header; HTTP-date and junk fall back to `default`."""
    try:
        seconds = float(value) if value is not None else default
    except ValueError:
        return default
    return seconds if seconds > 0 else default
