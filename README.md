# lofi + atc

Lofi beats mixed with live air traffic control radio. A single-page web app backed by a small Python server that proxies audio from [LiveATC.net](https://www.liveatc.net).

## Features

- Lofi music and live ATC audio playing at the same time
- **Ad-free music by default:** listener-supported [SomaFM](https://somafm.com) channels (instrumental hip-hop and downtempo), with a station picker. If a station is unreachable, the next one plays automatically
- Separate volume and mute controls for each channel
- Built-in airports: **SFO**, **JFK**, **ORD**, **DEN**, **EWR**
- **Any LiveATC airport or feed:** press **+** and enter an airport code (`KBOS`, `EGLL`), a feed name (`kbos_twr`), or paste a LiveATC link
- **Feed failover:** individual LiveATC feeds go offline often, so if the feed you picked is down the app plays the airport's next working feed and tells you which one
- Automatic reconnect with backoff when a stream drops or LiveATC rate-limits you
- Remembers your airports, selected feed and volumes
- Keyboard shortcuts: `Space` play/pause, `M` mute/unmute all, `↑↓` lofi volume
- No runtime dependencies: Python 3.9+ standard library only

## Quick start

```
make run
```

This starts the server on http://localhost:7331 and opens your browser. You can also run it without `make`:

```
python3 -m lofi_atc            # or: python3 lofi-atc-server.py
```

Or install it as a command:

```
pip install .
lofi-atc --open
```

### Options

```
lofi-atc [--host HOST] [--port PORT] [--open] [--stations PATH]
         [--min-gap SECONDS] [--max-streams N] [--log-level LEVEL]
```

| Option          | Default       | Description                                                               |
| --------------- | ------------- | ------------------------------------------------------------------------- |
| `--host`        | `127.0.0.1`   | Interface to bind. Use `0.0.0.0` to reach it from other devices. Env: `LOFI_ATC_HOST` |
| `--port`        | `7331`        | Port. Env: `LOFI_ATC_PORT`                                                |
| `--open`        | off           | Open the UI in your browser on startup                                    |
| `--stations`    | bundled       | Use your own stations JSON (see below)                                    |
| `--min-gap`     | `1.5`         | Minimum seconds between requests to LiveATC                               |
| `--max-streams` | `4`           | Maximum ATC streams proxied at once                                       |
| `--log-level`   | `INFO`        | `DEBUG` also logs every HTTP request                                      |

## Adding airports and feeds

**From the UI:** press **+** next to the airport buttons and enter one of the following.

- An **airport code** such as `KBOS`. The server looks the airport up on LiveATC's search page and adds every feed it finds. Feeds LiveATC reports as down are marked. LiveATC sometimes puts its search page behind a Cloudflare browser check that a server can't pass. When that happens, the app links you to the search page in your own browser so you can copy a feed link from there.
- A **feed (mount) name** such as `kbos_twr`. This is the `mount=` part of a LiveATC listen link.
- A **LiveATC link** to a feed, its `.pls` playlist, or a search page.

Airports you add are saved in your browser. Select one and press **remove** to delete it.

**Built-in defaults:** edit `lofi_atc/stations.json`, or point `--stations` at your own copy. The server checks the file on startup and reports problems such as duplicate feeds, invalid mount names, or missing labels.

## Music stations

The lofi card plays the stations listed under `lofi` in `stations.json`. Each entry looks like this:

```json
{
  "label": "Fluid · instrumental hip-hop",
  "url": "https://ice1.somafm.com/fluid-128-mp3",
  "credit": "SomaFM",
  "credit_url": "https://somafm.com/fluid/"
}
```

- `url` must be a direct audio stream (MP3/AAC) that a browser can play. Plain URL strings are still accepted, as in older config files.
- `credit` and `credit_url` are optional. When set, the UI links back to the source.
- The selected station plays first, and the others are fallbacks in list order.
- The defaults are ad-free SomaFM channels. SomaFM is listener-supported, so consider [donating](https://somafm.com/support/) if you use it a lot.

## Why a proxy server?

LiveATC streams sit behind Cloudflare and expect a browser-like `Referer` and `User-Agent`, and the airport search has no API. The server fetches both on the page's behalf. It also protects you from LiveATC's rate limits:

- It spaces requests at least `--min-gap` seconds apart.
- After LiveATC answers `429 Too Many Requests`, it stops sending requests for the `Retry-After` period. During that cooldown it answers `429` itself instead of making things worse.
- It caps concurrent streams with `--max-streams`.
- It caches airport lookups for 15 minutes.
- It remembers feeds that returned 404 for 5 minutes and answers those requests itself, so failover doesn't spend your rate budget on dead feeds.

## Troubleshooting

- **ATC takes a while to start:** that's normal. ATC feeds are low bitrate, so browsers buffer about 15–20 seconds before they start playing.
- **ATC shows "retry Ns":** none of the airport's feeds are producing audio. Check the server output:
  - `HTTP 429` means LiveATC is rate limiting you. The app backs off and retries automatically.
  - `HTTP 404` / "feed offline" means that feed is down. The app already tried the airport's other feeds, so they're all down. Try another airport.
  - "unreachable" means the server can't reach LiveATC. Check your network.
- **Airport lookup finds nothing:** LiveATC may not cover that airport. You can still paste a feed name or link directly.
- **Streams fail behind a firewall or allowlist:** `d.liveatc.net` redirects to regional relays such as `s1-bos.liveatc.net`. Allow `*.liveatc.net`. The server log shows which relay each stream came from.
- **Health check:** `curl localhost:7331/healthz` shows the version, the number of open streams, and the feeds currently known to be offline.

## Development

```
make setup     # .venv with pytest + ruff
make check     # lint + all tests (what CI runs)
make test-py   # Python tests (pytest)
make test-js   # frontend unit tests (node --test, Node 20+, no npm install)
make fmt       # auto-format
```

The Python tests run the real server on an ephemeral port against a fake LiveATC. They cover proxying, rate-limit cooldowns, stream limits, lookups, static file serving, and clean shutdown on SIGINT and SIGTERM. Frontend logic that needs testing lives in `player.js` with no DOM dependencies, and is tested with fake audio elements and timers.

## Project structure

```
lofi-atc/
├── lofi_atc/
│   ├── cli.py            # argument parsing, startup, shutdown
│   ├── server.py         # HTTP routes: UI, /api/*, /atc/<mount> proxy
│   ├── liveatc.py        # airport → feeds lookup (search page parser + cache)
│   ├── ratelimit.py      # request spacing + 429 cooldown
│   ├── upstream.py       # outbound requests to LiveATC
│   ├── config.py         # stations.json loading and validation
│   ├── stations.json     # built-in airports and lofi streams
│   └── static/
│       ├── index.html
│       ├── style.css
│       ├── app.js        # DOM wiring
│       └── player.js     # playback/reconnect logic and input parsing (unit tested)
├── tests/                # pytest + tests/js (node --test)
├── lofi-atc-server.py    # compatibility shim for the old entry point
├── pyproject.toml
└── Makefile
```

### HTTP endpoints

| Path                     | Description                                         |
| ------------------------ | --------------------------------------------------- |
| `/`                      | The UI                                              |
| `/api/stations`          | Built-in airports and lofi streams (JSON)           |
| `/api/search?icao=KBOS`  | Feeds LiveATC lists for an airport (JSON)           |
| `/atc/<mount>`           | Proxied LiveATC audio stream                        |
| `/healthz`               | Health/status (JSON)                                |

## License

MIT
