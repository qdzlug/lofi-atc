import json
import socket
import threading
import urllib.request
from pathlib import Path

import pytest

from tests.conftest import STREAM_BODY, Client, FakeLiveATC, wait_for
from tests.test_liveatc import http_error

FIXTURE = (Path(__file__).parent / "fixtures" / "liveatc_search_kbos.html").read_text()


# ── static files & API ──


@pytest.mark.parametrize("path", ["/", "/index.html", "/?utm=1"])
def test_serves_ui(client, path):
    status, headers, body = client.request(path)
    assert status == 200
    assert headers["Content-Type"].startswith("text/html")
    assert b"lofi" in body


@pytest.mark.parametrize(
    "path, ctype",
    [("/app.js", "text/javascript"), ("/player.js", "text/javascript"), ("/style.css", "text/css")],
)
def test_serves_assets(client, path, ctype):
    status, headers, _ = client.request(path)
    assert status == 200
    assert headers["Content-Type"].startswith(ctype)


@pytest.mark.parametrize(
    "path", ["/nope", "/../server.py", "/stations.json", "/static/app.js", "/%2e%2e/cli.py"]
)
def test_unknown_paths_404(client, path):
    assert client.request(path)[0] == 404


def test_head_returns_headers_only(client):
    status, headers, body = client.request("/", method="HEAD")
    assert status == 200
    assert int(headers["Content-Length"]) > 0
    assert body == b""


def test_stations_api(client):
    status, _, body = client.request("/api/stations")
    assert status == 200
    data = json.loads(body)
    assert data["lofi"][0]["type"] == "stream"
    assert data["lofi"][0]["url"].startswith("https://")
    assert data["airports"][0]["feeds"][0]["mount"]


def test_healthz(client):
    status, _, body = client.request("/healthz")
    assert status == 200
    assert json.loads(body)["status"] == "ok"


# ── ATC proxy ──


def test_proxies_any_valid_mount(client):
    status, headers, body = client.request("/atc/ok_kbos_twr")
    assert status == 200
    assert headers["Content-Type"] == "audio/mpeg"
    assert "Transfer-Encoding" not in headers
    assert body == STREAM_BODY
    assert FakeLiveATC.hits == ["ok_kbos_twr"]


@pytest.mark.parametrize("mount", ["", "KBOS", "a.b", "a%2Fb", "x" * 65])
def test_rejects_bad_mounts_without_calling_upstream(client, mount):
    assert client.request(f"/atc/{mount}")[0] == 400
    assert FakeLiveATC.hits == []


def test_head_on_stream_not_allowed(client):
    assert client.request("/atc/ok_1", method="HEAD")[0] == 405


def test_upstream_404_is_feed_offline(client):
    status, _, body = client.request("/atc/gone")
    assert status == 404
    assert b"offline" in body


def test_upstream_error_is_502(client):
    assert client.request("/atc/broken")[0] == 502


def test_upstream_unreachable_is_502(make_app, upstream):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead_port = s.getsockname()[1]
    app = make_app()
    app.settings = type(app.settings)(upstream_base=f"http://127.0.0.1:{dead_port}", upstream_timeout=2)
    url = f"http://127.0.0.1:{app.server_address[1]}"
    assert Client(url).request("/atc/ok_1")[0] == 502


def test_upstream_429_starts_cooldown(client):
    status, headers, _ = client.request("/atc/ratelimited")
    assert status == 429
    assert headers["Retry-After"] == "7"
    # During the cooldown we answer 429 ourselves instead of hitting LiveATC again.
    status, headers, _ = client.request("/atc/ok_1")
    assert status == 429
    assert 0 < int(headers["Retry-After"]) <= 7
    assert FakeLiveATC.hits == ["ratelimited"]


def test_max_streams_enforced_and_released(make_app):
    app = make_app(max_streams=1)
    base = f"http://127.0.0.1:{app.server_address[1]}"
    client = Client(base)
    resp = urllib.request.urlopen(base + "/atc/hang_1", timeout=10)
    try:
        assert resp.read(16) == b"x" * 16
        assert app.active_streams == 1
        assert client.request("/atc/ok_1")[0] == 503
    finally:
        FakeLiveATC.release.set()
        resp.close()
    assert wait_for(lambda: app.active_streams == 0)
    assert client.request("/atc/ok_1")[0] == 200


def test_client_disconnect_frees_slot(make_app):
    app = make_app(max_streams=1)
    resp = urllib.request.urlopen(f"http://127.0.0.1:{app.server_address[1]}/atc/hang_1", timeout=10)
    resp.read(16)
    resp.close()
    FakeLiveATC.release.set()
    assert wait_for(lambda: app.active_streams == 0)


def test_concurrent_streams(client):
    results = []

    def fetch():
        results.append(client.request("/atc/ok_1"))

    threads = [threading.Thread(target=fetch) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r[0] for r in results] == [200] * 4
    assert all(r[2] == STREAM_BODY for r in results)


# ── feed search ──


def test_search_returns_feeds(client, search):
    search.pages["KBOS"] = FIXTURE
    status, _, body = client.request("/api/search?icao=kbos")
    assert status == 200
    data = json.loads(body)
    assert data["icao"] == "KBOS"
    assert data["feeds"][0] == {"mount": "kbos_twr", "label": "KBOS Del/Gnd/Twr", "status": "UP"}


def test_search_no_results(client):
    status, _, body = client.request("/api/search?icao=ZZZZ")
    assert status == 200
    assert json.loads(body)["feeds"] == []


@pytest.mark.parametrize("query", ["", "?icao=", "?icao=TOOLONG", "?icao=K%20BOS", "?icao=../x"])
def test_search_rejects_bad_icao(client, search, query):
    assert client.request(f"/api/search{query}")[0] == 400
    assert search.calls == []


def test_search_upstream_failure(client, search):
    search.error = TimeoutError("slow")
    status, _, body = client.request("/api/search?icao=KBOS")
    assert status == 502
    assert "unreachable" in json.loads(body)["error"]


def test_search_reports_browser_check(client, search):
    search.error = http_error(403, cf_mitigated="challenge")
    status, _, body = client.request("/api/search?icao=KBOS")
    assert status == 502
    assert json.loads(body)["browser_check"] is True


def test_search_shares_cooldown_with_streams(client, search):
    client.request("/atc/ratelimited")
    search.pages["KBOS"] = FIXTURE
    status, headers, _ = client.request("/api/search?icao=KBOS")
    assert status == 429
    assert "Retry-After" in headers
    assert search.calls == []


def test_offline_feeds_are_remembered(client):
    assert client.request("/atc/gone")[0] == 404
    assert client.request("/atc/gone")[0] == 404
    assert FakeLiveATC.hits == ["gone"]
    status, _, body = client.request("/healthz")
    assert json.loads(body)["offline_feeds"] == ["gone"]


def test_offline_memory_expires(make_app):
    app = make_app()
    app.settings = type(app.settings)(upstream_base=app.settings.upstream_base, offline_ttl=0)
    client = Client(f"http://127.0.0.1:{app.server_address[1]}")
    client.request("/atc/gone")
    client.request("/atc/gone")
    assert FakeLiveATC.hits == ["gone", "gone"]
