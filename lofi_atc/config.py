"""Station configuration: loading and validation of stations.json."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_STATIONS_PATH = Path(__file__).with_name("stations.json")

# LiveATC mount names are short lowercase identifiers like "kord1n1_app_133625".
MOUNT_RE = re.compile(r"^[a-z0-9_]{1,64}$")


class ConfigError(ValueError):
    """Raised when stations.json is missing or malformed."""


@dataclass(frozen=True)
class Feed:
    mount: str
    label: str


@dataclass(frozen=True)
class Airport:
    icao: str
    label: str
    name: str
    feeds: tuple[Feed, ...]


@dataclass(frozen=True)
class Stations:
    lofi: tuple[str, ...]
    airports: tuple[Airport, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "lofi": list(self.lofi),
            "airports": [
                {
                    "icao": a.icao,
                    "label": a.label,
                    "name": a.name,
                    "feeds": [{"mount": f.mount, "label": f.label} for f in a.feeds],
                }
                for a in self.airports
            ],
        }


def _require_str(obj: dict, key: str, where: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{where}: '{key}' must be a non-empty string")
    return value


def parse_stations(data: Any) -> Stations:
    """Validate raw JSON data and return a Stations object."""
    if not isinstance(data, dict):
        raise ConfigError("top level must be an object")

    lofi = data.get("lofi")
    if not isinstance(lofi, list) or not lofi:
        raise ConfigError("'lofi' must be a non-empty list of URLs")
    for i, url in enumerate(lofi):
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            raise ConfigError(f"lofi[{i}]: must be an http(s) URL, got {url!r}")

    raw_airports = data.get("airports")
    if not isinstance(raw_airports, list) or not raw_airports:
        raise ConfigError("'airports' must be a non-empty list")

    airports = []
    seen_icao: set[str] = set()
    seen_mounts: set[str] = set()
    for i, ap in enumerate(raw_airports):
        where = f"airports[{i}]"
        if not isinstance(ap, dict):
            raise ConfigError(f"{where}: must be an object")
        icao = _require_str(ap, "icao", where)
        if icao in seen_icao:
            raise ConfigError(f"{where}: duplicate icao {icao!r}")
        seen_icao.add(icao)

        raw_feeds = ap.get("feeds")
        if not isinstance(raw_feeds, list) or not raw_feeds:
            raise ConfigError(f"{where} ({icao}): 'feeds' must be a non-empty list")
        feeds = []
        for j, feed in enumerate(raw_feeds):
            fwhere = f"{where}.feeds[{j}]"
            if not isinstance(feed, dict):
                raise ConfigError(f"{fwhere}: must be an object")
            mount = _require_str(feed, "mount", fwhere)
            if not MOUNT_RE.match(mount):
                raise ConfigError(f"{fwhere}: invalid mount {mount!r} (expected [a-z0-9_]+)")
            if mount in seen_mounts:
                raise ConfigError(f"{fwhere}: duplicate mount {mount!r}")
            seen_mounts.add(mount)
            feeds.append(Feed(mount=mount, label=_require_str(feed, "label", fwhere)))

        airports.append(
            Airport(
                icao=icao,
                label=_require_str(ap, "label", where),
                name=_require_str(ap, "name", where),
                feeds=tuple(feeds),
            )
        )

    return Stations(lofi=tuple(lofi), airports=tuple(airports))


def load_stations(path: Path | str = DEFAULT_STATIONS_PATH) -> Stations:
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise ConfigError(f"cannot read {path}: {e}") from e
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ConfigError(f"{path}: invalid JSON: {e}") from e
    try:
        return parse_stations(data)
    except ConfigError as e:
        raise ConfigError(f"{path}: {e}") from e
