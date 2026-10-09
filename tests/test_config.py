import json
import re

import pytest

from lofi_atc.config import ConfigError, load_stations, parse_stations


def valid():
    return {
        "lofi": [
            {
                "type": "stream",
                "label": "Example",
                "url": "https://example.com/stream",
                "credit": "Example FM",
                "credit_url": "https://example.com/",
            }
        ],
        "airports": [
            {
                "icao": "KSFO",
                "label": "SFO",
                "name": "San Francisco",
                "feeds": [{"mount": "ksfo_twr", "label": "Tower"}],
            }
        ],
    }


def test_bundled_stations_are_valid():
    stations = load_stations()
    assert stations.lofi
    assert all(m.credit for m in stations.lofi)
    assert {a.icao for a in stations.airports} >= {"KSFO", "KJFK", "KORD", "KDEN", "KEWR"}


def test_round_trips_to_dict():
    data = valid()
    assert parse_stations(data).to_dict() == data


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda d: d.update(lofi=[]), "'lofi'"),
        (lambda d: d.update(lofi=["ftp://nope"]), "lofi[0]"),
        (lambda d: d.update(lofi=[42]), "lofi[0]: must be a URL or an object"),
        (lambda d: d["lofi"][0].update(type="youtube"), "unknown type 'youtube'"),
        (
            lambda d: d["lofi"][0].update(
                type="spotify", url="https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
            ),
            "spotify 'url'",
        ),
        (
            lambda d: d["lofi"][0].update(
                type="spotify", url="https://evil.example/playlist/0vvXsWCC9xrXsKd4FyS8kM"
            ),
            "spotify 'url'",
        ),
        (
            lambda d: d["lofi"][0].update(type="soundcloud", url="https://example.com/x"),
            "soundcloud 'url' must be an https://soundcloud.com/... link",
        ),
        (
            lambda d: d["lofi"][0].update(type="soundcloud", url="https://soundcloud.com.evil.example/x"),
            "soundcloud 'url'",
        ),
        (
            lambda d: d["lofi"][0].update(type="soundcloud", url="http://soundcloud.com/x"),
            "soundcloud 'url'",
        ),
        (lambda d: d["lofi"][0].update(url="nope"), "'url'"),
        (lambda d: d["lofi"][0].pop("label"), "'label'"),
        (lambda d: d["lofi"][0].update(credit_url="javascript:alert(1)"), "'credit_url'"),
        (lambda d: d["lofi"][0].update(credit=5), "'credit'"),
        (lambda d: d["lofi"].append(dict(d["lofi"][0])), "same URL twice"),
        (lambda d: d.update(airports=[]), "'airports'"),
        (lambda d: d["airports"][0].update(icao=""), "'icao'"),
        (lambda d: d["airports"][0].update(feeds=[]), "'feeds'"),
        (lambda d: d["airports"][0]["feeds"][0].update(mount="../etc"), "invalid mount"),
        (lambda d: d["airports"][0]["feeds"][0].update(mount="KSFO_TWR"), "invalid mount"),
        (lambda d: d["airports"][0]["feeds"][0].pop("label"), "'label'"),
        (lambda d: d["airports"].append(dict(d["airports"][0])), "duplicate icao"),
        (
            lambda d: d["airports"].append({**d["airports"][0], "icao": "KOAK"}),
            "duplicate mount",
        ),
    ],
)
def test_rejects_invalid(mutate, message):
    data = valid()
    mutate(data)
    with pytest.raises(ConfigError, match=re.escape(message)):
        parse_stations(data)


def test_load_reports_path_on_bad_json(tmp_path):
    bad = tmp_path / "stations.json"
    bad.write_text("{nope")
    with pytest.raises(ConfigError, match="invalid JSON"):
        load_stations(bad)


def test_load_missing_file(tmp_path):
    with pytest.raises(ConfigError, match="cannot read"):
        load_stations(tmp_path / "missing.json")


def test_load_custom_file(tmp_path):
    path = tmp_path / "s.json"
    path.write_text(json.dumps(valid()))
    assert load_stations(path).airports[0].icao == "KSFO"


def test_bare_url_lofi_entries_still_work():
    """Older stations.json files listed lofi streams as plain URLs."""
    data = valid()
    data["lofi"] = ["https://radio.example.com/lofi.mp3"]
    (station,) = parse_stations(data).lofi
    assert station.url == "https://radio.example.com/lofi.mp3"
    assert station.label == "radio.example.com"
    assert station.to_dict() == {
        "type": "stream",
        "label": "radio.example.com",
        "url": "https://radio.example.com/lofi.mp3",
    }


def test_soundcloud_station():
    data = valid()
    data["lofi"].append(
        {"type": "soundcloud", "label": "Chillhop", "url": "https://soundcloud.com/chillhopdotcom"}
    )
    station = parse_stations(data).lofi[-1]
    assert (station.type, station.url) == ("soundcloud", "https://soundcloud.com/chillhopdotcom")


def test_bundled_stations_include_a_soundcloud_backup():
    types = [m.type for m in load_stations().lofi]
    assert types[0] == "stream"
    assert "soundcloud" in types


@pytest.mark.parametrize(
    "url",
    [
        "https://open.spotify.com/playlist/0vvXsWCC9xrXsKd4FyS8kM",
        "https://open.spotify.com/playlist/0vvXsWCC9xrXsKd4FyS8kM?si=abc123",
        "https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc",
        "https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF",
    ],
)
def test_spotify_station(url):
    data = valid()
    data["lofi"].append({"type": "spotify", "label": "Lofi Girl", "url": url})
    assert parse_stations(data).lofi[-1].type == "spotify"
