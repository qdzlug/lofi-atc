"""Rate limiting for requests to LiveATC."""

from __future__ import annotations

import threading
import time
from typing import Callable


class RateLimited(Exception):
    """Raised when we are in a cooldown after being rate limited upstream."""

    def __init__(self, retry_after: float):
        super().__init__(f"rate limited, retry after {retry_after:.0f}s")
        self.retry_after = retry_after


class RateLimiter:
    """Spaces outgoing requests at least `min_interval` seconds apart.

    Callers reserve a slot under the lock and then sleep *outside* it, so
    concurrent callers queue up in order without holding the lock while
    waiting. After an upstream 429, `penalize()` starts a cooldown during
    which `acquire()` fails fast instead of making things worse.
    """

    def __init__(
        self,
        min_interval: float,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.min_interval = min_interval
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next_slot = 0.0
        self._cooldown_until = 0.0

    def acquire(self) -> None:
        with self._lock:
            now = self._clock()
            if now < self._cooldown_until:
                raise RateLimited(self._cooldown_until - now)
            slot = max(now, self._next_slot)
            self._next_slot = slot + self.min_interval
        wait = slot - now
        if wait > 0:
            self._sleep(wait)

    def penalize(self, seconds: float) -> None:
        with self._lock:
            self._cooldown_until = max(self._cooldown_until, self._clock() + seconds)
