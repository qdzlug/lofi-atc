#!/usr/bin/env python3
"""Compatibility shim: `python3 lofi-atc-server.py` still works.

Prefer `python3 -m lofi_atc` (or the `lofi-atc` command once installed).
"""

import sys

from lofi_atc.cli import main

if __name__ == "__main__":
    sys.exit(main())
