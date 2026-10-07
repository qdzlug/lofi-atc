"""Command-line entry point."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import webbrowser

from . import __version__
from .config import DEFAULT_STATIONS_PATH, ConfigError, load_stations
from .ratelimit import RateLimiter
from .server import LofiATCServer, ProxySettings

log = logging.getLogger("lofi_atc")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="lofi-atc",
        description="Serve the lofi + atc UI and proxy LiveATC streams.",
    )
    p.add_argument(
        "--host",
        default=os.environ.get("LOFI_ATC_HOST", "127.0.0.1"),
        help="interface to bind (default: 127.0.0.1; use 0.0.0.0 to expose on your LAN) [env: LOFI_ATC_HOST]",
    )
    p.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("LOFI_ATC_PORT", "7331")),
        help="port to listen on (default: 7331) [env: LOFI_ATC_PORT]",
    )
    p.add_argument(
        "--stations",
        default=str(DEFAULT_STATIONS_PATH),
        metavar="PATH",
        help="stations JSON file (default: bundled stations.json)",
    )
    p.add_argument("--open", action="store_true", help="open the UI in your web browser on startup")
    p.add_argument(
        "--min-gap",
        type=float,
        default=1.5,
        metavar="SECONDS",
        help="minimum seconds between requests to LiveATC (default: 1.5)",
    )
    p.add_argument(
        "--max-streams",
        type=int,
        default=4,
        metavar="N",
        help="maximum concurrent proxied ATC streams (default: 4)",
    )
    p.add_argument("--upstream", default=ProxySettings.upstream_base, help=argparse.SUPPRESS)
    p.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="log verbosity; DEBUG includes every HTTP request (default: INFO)",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def _raise_interrupt(signum, frame):
    raise KeyboardInterrupt


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        stations = load_stations(args.stations)
    except ConfigError as e:
        log.error("invalid station config: %s", e)
        return 2

    settings = ProxySettings(upstream_base=args.upstream, max_streams=args.max_streams)
    try:
        server = LofiATCServer((args.host, args.port), stations, RateLimiter(args.min_gap), settings)
    except OSError as e:
        log.error("cannot listen on %s:%d: %s", args.host, args.port, e)
        return 1

    port = server.server_address[1]
    display_host = "localhost" if args.host in ("0.0.0.0", "127.0.0.1", "::") else args.host
    url = f"http://{display_host}:{port}"
    log.info("lofi + atc %s listening on %s (Ctrl+C to stop)", __version__, url)
    if args.open:
        webbrowser.open(url)

    # Treat SIGTERM like Ctrl+C so both paths shut down the same way.
    signal.signal(signal.SIGTERM, _raise_interrupt)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
