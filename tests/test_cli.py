import json
import re
import signal
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest

from lofi_atc.cli import build_parser, main

ROOT = Path(__file__).resolve().parent.parent


def test_defaults_bind_localhost():
    args = build_parser().parse_args([])
    assert args.host == "127.0.0.1"
    assert args.port == 7331


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("LOFI_ATC_PORT", "9000")
    monkeypatch.setenv("LOFI_ATC_HOST", "0.0.0.0")
    args = build_parser().parse_args([])
    assert (args.host, args.port) == ("0.0.0.0", 9000)


def test_bad_stations_file_exits_2(tmp_path):
    bad = tmp_path / "s.json"
    bad.write_text("[]")
    assert main(["--stations", str(bad), "--port", "0"]) == 2


def test_port_in_use_exits_1():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        assert main(["--port", str(s.getsockname()[1])]) == 1


def start(*args):
    proc = subprocess.Popen(
        [sys.executable, *args, "--port", "0"],
        cwd=ROOT,
        stderr=subprocess.PIPE,
        text=True,
    )
    line = proc.stderr.readline()
    m = re.search(r"listening on (http://\S+)", line)
    assert m, line
    return proc, m.group(1)


@pytest.mark.parametrize("entry", [["-m", "lofi_atc"], ["lofi-atc-server.py"]])
@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM])
def test_starts_serves_and_shuts_down_cleanly(entry, sig):
    proc, url = start(*entry)
    try:
        with urllib.request.urlopen(url + "/healthz", timeout=5) as r:
            assert json.load(r)["status"] == "ok"
        proc.send_signal(sig)
        assert proc.wait(timeout=5) == 0
        assert "shutting down" in proc.stderr.read()
    finally:
        proc.kill()
        proc.stderr.close()


def test_spotify_client_id_from_env(monkeypatch):
    monkeypatch.setenv("LOFI_ATC_SPOTIFY_CLIENT_ID", "0123456789abcdef0123456789abcdef")
    assert build_parser().parse_args([]).spotify_client_id == "0123456789abcdef0123456789abcdef"


@pytest.mark.parametrize("bad", ["nope", "0123456789abcdef", "zz23456789abcdef0123456789abcdef"])
def test_invalid_spotify_client_id_exits_2(bad):
    assert main(["--port", "0", "--spotify-client-id", bad]) == 2


def test_banner_uses_127_0_0_1_for_spotify():
    proc, url = start("-m", "lofi_atc")
    try:
        assert url.startswith("http://127.0.0.1:")
    finally:
        proc.kill()
        proc.wait()
        proc.stderr.close()
