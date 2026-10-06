import json
import re

import pytest

from lofi_atc.config import ConfigError, load_stations, parse_stations


def valid():
    return {
        "lofi": ["https://example.com/stream"],
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
    assert {a.icao for a in stations.airports} >= {"KSFO", "KJFK", "KORD", "KDEN", "KEWR"}


def test_round_trips_to_dict():
    data = valid()
    assert parse_stations(data).to_dict() == data


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda d: d.update(lofi=[]), "'lofi'"),
        (lambda d: d.update(lofi=["ftp://nope"]), "lofi[0]"),
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
