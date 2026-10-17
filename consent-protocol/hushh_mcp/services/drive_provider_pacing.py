"""Per-process Drive quota pacing: a per-owner limiter and a project unit budget.

Google meters the Drive API in units per minute: a list call costs 100 units, a
read 5 and a download 200; one user may spend 325,000 units a minute and the
project 1,000,000 (developers.google.com/workspace/drive/api/guides/limits).
This process cannot see the other worker instance or the API process, so it
keeps half of each budget. A call that would overspend is deferred locally:
nothing is sent, and the caller learns how many seconds to wait.

A deferral is not a provider failure. Durable callers requeue through their
``next_at`` and never count it toward failing a job. Budgets apply only in the
Drive worker deployment (``DRIVE_WORKER_MODE=true``), where every drain and
chained slice runs; in the API process admission is a no-op.

Owner keys are internal user ids held in memory, in a bounded LRU. Nothing here
is logged or persisted, so no query, file name, email or provider id can leak.
"""

from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

# Drive units per fixed adapter operation (guides/limits). changes.list and
# drives.list are not classified there, so they are charged like a list.
UNIT_COSTS = {
    "list": 100,
    "changes": 100,
    "list_drives": 100,
    "metadata": 5,
    "changes_start": 5,
    "account": 5,
    "content": 200,
    "export": 200,
}
USER_UNITS_PER_MINUTE = 325_000
PROJECT_UNITS_PER_MINUTE = 1_000_000
# Two worker instances plus the API process share the project and each owner.
PROCESS_SHARE = 0.5
WINDOW_SECONDS = 60
# Google recommends truncated exponential backoff up to 32-64 s (guides/limits).
MAX_DEFER_SECONDS = 64.0
MIN_DEFER_SECONDS = 1.0
MAX_TRACKED_OWNERS = 4096

_OWNER: ContextVar[str | None] = ContextVar("drive_pacing_owner", default=None)


def bounded_wait(value: object) -> float | None:
    """A wait in seconds clamped to Google's 64 s backoff ceiling, or None."""
    if type(value) not in {int, float} or value != value:  # noqa: PLR0124 - NaN check
        return None
    return float(min(MAX_DEFER_SECONDS, max(0.0, value)))


def worker_mode() -> bool:
    return os.getenv("DRIVE_WORKER_MODE", "").strip().lower() == "true"


@contextmanager
def owner_scope(owner_id: str) -> Iterator[None]:
    """Charge Drive calls made inside this block to one owner's budget."""
    marker = _OWNER.set(owner_id if isinstance(owner_id, str) and owner_id else None)
    try:
        yield
    finally:
        _OWNER.reset(marker)


def current_owner() -> str | None:
    return _OWNER.get()


@dataclass
class _Window:
    """Units spent per whole second over the last minute."""

    buckets: deque = field(default_factory=deque)
    total: int = 0

    def prune(self, now: float) -> None:
        horizon = int(now) - WINDOW_SECONDS
        while self.buckets and self.buckets[0][0] <= horizon:
            self.total -= self.buckets.popleft()[1]

    def wait_for(self, now: float, cost: int, limit: int) -> float:
        """Seconds until ``cost`` more units fit; 0 when they fit now."""
        self.prune(now)
        excess = self.total + cost - limit
        if excess <= 0:
            return 0.0
        for second, units in self.buckets:
            excess -= units
            if excess <= 0:
                # That second's units leave the window once int(now) reaches it + 60.
                return second + WINDOW_SECONDS - now
        return float(WINDOW_SECONDS)

    def add(self, now: float, cost: int) -> None:
        second = int(now)
        if self.buckets and self.buckets[-1][0] == second:
            self.buckets[-1][1] += cost
        else:
            self.buckets.append([second, cost])
        self.total += cost


class DrivePacing:
    """Admission for one process. Thread safe; never blocks or sleeps."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        enforce: Callable[[], bool] = worker_mode,
        user_units_per_minute: int = int(USER_UNITS_PER_MINUTE * PROCESS_SHARE),
        project_units_per_minute: int = int(PROJECT_UNITS_PER_MINUTE * PROCESS_SHARE),
        max_owners: int = MAX_TRACKED_OWNERS,
    ) -> None:
        self._clock = clock
        self._enforce = enforce
        self._user_limit = user_units_per_minute
        self._project_limit = project_units_per_minute
        self._max_owners = max_owners
        self._lock = threading.Lock()
        self._project = _Window()
        self._owners: OrderedDict[str, _Window] = OrderedDict()

    def _owner(self, owner: str) -> _Window:
        window = self._owners.get(owner)
        if window is None:
            window = _Window()
            self._owners[owner] = window
        self._owners.move_to_end(owner)
        while len(self._owners) > self._max_owners:
            self._owners.popitem(last=False)
        return window

    def admit(self, owner: str | None, operation: str) -> float | None:
        """Charge one call, or return the seconds to defer it (nothing is charged).

        Outside the worker this is a no-op: nothing is charged or deferred.
        """
        if not self._enforce():
            return None
        cost = UNIT_COSTS.get(operation, UNIT_COSTS["list"])
        with self._lock:
            now = self._clock()
            window = self._owner(owner) if owner else None
            wait = max(
                self._project.wait_for(now, cost, self._project_limit),
                window.wait_for(now, cost, self._user_limit) if window else 0.0,
            )
            if wait > 0:
                return min(MAX_DEFER_SECONDS, max(MIN_DEFER_SECONDS, wait))
            self._project.add(now, cost)
            if window is not None:
                window.add(now, cost)
            return None

    def spent(self, owner: str | None = None) -> int:
        """Units charged in the current window, for the project or one owner."""
        with self._lock:
            now = self._clock()
            window = self._project if owner is None else self._owners.get(owner)
            if window is None:
                return 0
            window.prune(now)
            return window.total

    def reset(self) -> None:
        with self._lock:
            self._project = _Window()
            self._owners.clear()


PACING = DrivePacing()
