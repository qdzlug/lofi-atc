# lofi + atc

Lofi beats mixed with live air traffic control radio. A single-page web app backed by a tiny Python proxy server that streams audio from [LiveATC.net](https://www.liveatc.net).

![lofi + atc](https://img.shields.io/badge/vibes-immaculate-7c6ff0)

## Features

- Simultaneous lofi music + live ATC audio streams
- Independent volume controls and mute toggles for each channel
- Five major US airports: **SFO**, **JFK**, **ORD**, **DEN**, **EWR**
- Multiple feeds per airport (tower, ground, approach, departure)
- Keyboard shortcuts: `Space` play/pause, `M` mute, `↑↓` volume
- Zero external dependencies — Python 3.9+ stdlib only

## Quick start

```
make run
```

This creates a venv, installs deps, starts the server, and opens `http://localhost:7331` in your browser.

## Manual start

```
python3 lofi-atc-server.py
```

## Why a proxy server?

LiveATC streams are behind Cloudflare and don't send CORS headers, so browsers block direct connections from a web page. The proxy server fetches streams server-side with the correct `Referer` and `User-Agent` headers, and includes rate limiting to avoid getting 429'd.

## Project structure

```
lofi-atc/
├── lofi-atc.html         # the UI — vanilla HTML/CSS/JS
├── lofi-atc-server.py    # proxy server (stdlib only)
├── Makefile              # make setup / make run / make clean
├── requirements.txt      # empty for now (stdlib only)
└── README.md
```

## Make targets

| Target | Description |
|--------|-------------|
| `make setup` | Create venv and install deps |
| `make run` | Start the server |
| `make clean` | Remove venv |
| `make help` | Show all targets |

## License

MIT
# lofi-atc
