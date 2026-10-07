import threading

import pytest

from lofi_atc.ratelimit import RateLimited, RateLimiter


class FakeTime:
    def __init__(self):
        self.now = 100.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)


def test_first_request_does_not_wait():
    t = FakeTime()
    RateLimiter(1.5, t.clock, t.sleep).acquire()
    assert t.sleeps == []


def test_back_to_back_requests_are_spaced():
    t = FakeTime()
    rl = RateLimiter(1.5, t.clock, t.sleep)
    rl.acquire()
    rl.acquire()
    rl.acquire()
    # Slots are reserved in order: the third caller waits for two gaps.
    assert t.sleeps == [1.5, 3.0]


def test_no_wait_after_gap_elapsed():
    t = FakeTime()
    rl = RateLimiter(1.5, t.clock, t.sleep)
    rl.acquire()
    t.now += 2
    rl.acquire()
    assert t.sleeps == []


def test_penalize_fails_fast_until_cooldown_ends():
    t = FakeTime()
    rl = RateLimiter(0, t.clock, t.sleep)
    rl.penalize(10)
    with pytest.raises(RateLimited) as exc:
        rl.acquire()
    assert exc.value.retry_after == pytest.approx(10)
    t.now += 10
    rl.acquire()


def test_penalize_never_shortens_cooldown():
    t = FakeTime()
    rl = RateLimiter(0, t.clock, t.sleep)
    rl.penalize(30)
    rl.penalize(5)
    t.now += 10
    with pytest.raises(RateLimited):
        rl.acquire()


def test_lock_not_held_while_sleeping():
    """A sleeping caller must not block others from reserving their slot."""
    rl = RateLimiter(0.2)
    rl.acquire()
    started = threading.Event()

    def waiter():
        started.set()
        rl.acquire()  # sleeps ~0.2s outside the lock

    th = threading.Thread(target=waiter)
    th.start()
    started.wait()
    assert rl._lock.acquire(timeout=0.1)
    rl._lock.release()
    th.join()
