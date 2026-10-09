# lofi + atc

Lofi beats mixed with live air traffic control radio. A single-page web app backed by a small Python server that proxies audio from [LiveATC.net](https://www.liveatc.net).

## Features

- Lofi music and live ATC audio playing at the same time
- **Ad-free music by default:** listener-supported [SomaFM](https://somafm.com) channels (instrumental hip-hop and downtempo), with a station picker. If a station is unreachable, the next one plays automatically
- **SoundCloud backup:** Chillhop Music and Lofi Girl on SoundCloud, played through SoundCloud's official widget. Add any SoundCloud artist, playlist or track as a station
- **Spotify for Premium members:** connect your Spotify account and play a playlist, album or artist right in the page (see [Spotify](#spotify))
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

This starts the server on http://127.0.0.1:7331 and opens your browser. You can also run it without `make`:

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
         [--min-gap SECONDS] [--max-streams N] [--spotify-client-id ID]
         [--log-level LEVEL]
```

| Option          | Default       | Description                                                               |
| --------------- | ------------- | ------------------------------------------------------------------------- |
| `--host`        | `127.0.0.1`   | Interface to bind. Use `0.0.0.0` to reach it from other devices. Env: `LOFI_ATC_HOST` |
| `--port`        | `7331`        | Port. Env: `LOFI_ATC_PORT`                                                |
| `--open`        | off           | Open the UI in your browser on startup                                    |
| `--stations`    | bundled       | Use your own stations JSON (see below)                                    |
| `--min-gap`     | `1.5`         | Minimum seconds between requests to LiveATC                               |
| `--max-streams` | `4`           | Maximum ATC streams proxied at once                                       |
| `--spotify-client-id` | none    | Your Spotify app's client ID; enables Spotify (see below). Env: `LOFI_ATC_SPOTIFY_CLIENT_ID` |
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
- To use SoundCloud, add `"type": "soundcloud"` and set `url` to any `https://soundcloud.com/...` artist, playlist or track page:

  ```json
  { "type": "soundcloud", "label": "Chillhop Music · SoundCloud", "url": "https://soundcloud.com/chillhopdotcom" }
  ```

  It plays through SoundCloud's embed widget, which appears in the lofi card while that station is playing. That shows the track and gives SoundCloud the attribution it expects. Playback starts at a random track and loops at the end of the list. Volume and mute are controlled by the app as usual. SoundCloud may occasionally play its own ads or previews in the widget; that's out of this app's control.
- `credit` and `credit_url` are optional. When set, the UI links back to the source.
- The selected station plays first, and the others are fallbacks in list order.
- The defaults are ad-free SomaFM channels. SomaFM is listener-supported, so consider [donating](https://somafm.com/support/) if you use it a lot.

## Spotify

Spotify Premium members can play Spotify playlists, albums or artists in the lofi card. Spotify's [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) turns the page into a Spotify Connect device. It needs Premium, and each self-hoster uses their own (free) Spotify developer app.

**One-time setup**

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard), log in, and click **Create app**.
2. Set **Redirect URI** to exactly `http://127.0.0.1:7331/spotify/callback`. Spotify doesn't accept `localhost`. If you run on another port, use that port instead.
3. Under the APIs/SDKs used, tick **Web API** and **Web Playback SDK**, then save.
4. Copy the app's **Client ID**. The login uses PKCE, so the app never needs the Client Secret. Don't share the secret.

**Run with it**

```
LOFI_ATC_SPOTIFY_CLIENT_ID=<your client id> make run
# or: python3 -m lofi_atc --spotify-client-id <your client id> --open
```

Open http://127.0.0.1:7331, click **connect Spotify**, and approve. The **Lofi Girl · Spotify** station is then selected; press play. To use other music, add stations to `stations.json`:

```json
{ "type": "spotify", "label": "My playlist · Spotify", "url": "https://open.spotify.com/playlist/<id>" }
```

Notes:

- **Privacy:** login tokens are stored only in your browser (localStorage) and go straight to Spotify; the lofi-atc server never sees them. **disconnect Spotify** forgets them.
- **Limits:** apps in Spotify's development mode work for the app owner plus up to 5 accounts you add under **Settings → User Management**. Spotify only grants wider access to registered businesses.
- **Browsers:** playback needs a desktop browser with DRM enabled (Chrome, Edge, Firefox or Safari). Spotify's SDK doesn't support mobile browsers.
- **Fallback:** if Spotify can't play (not connected, not Premium, DRM unavailable), the next station plays and the card says why.
- **Without a client ID:** no Spotify options appear at all.

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
- **Spotify says "INVALID_CLIENT: Invalid redirect URI":** the redirect URI in the Spotify dashboard must match `http://127.0.0.1:<port>/spotify/callback` exactly. The server prints the expected value at startup.
- **Health check:** `curl 127.0.0.1:7331/healthz` shows the version, the number of open streams, and the feeds currently known to be offline.

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
│       ├── player.js     # playback/reconnect logic and input parsing (unit tested)
│       ├── soundcloud.js # SoundCloud widget adapter
│       ├── spotify.js    # Spotify Web Playback SDK adapter
│       └── spotify-auth.js # Spotify login (PKCE) and token refresh
├── tests/                # pytest + tests/js (node --test)
├── lofi-atc-server.py    # compatibility shim for the old entry point
├── pyproject.toml
└── Makefile
```

### HTTP endpoints

| Path                     | Description                                         |
| ------------------------ | --------------------------------------------------- |
| `/`                      | The UI                                              |
| `/api/stations`          | Built-in airports, music stations and Spotify client ID (JSON) |
| `/spotify/callback`      | Where Spotify's login returns; serves the UI        |
| `/api/search?icao=KBOS`  | Feeds LiveATC lists for an airport (JSON)           |
| `/atc/<mount>`           | Proxied LiveATC audio stream                        |
| `/healthz`               | Health/status (JSON)                                |

## License

MIT
