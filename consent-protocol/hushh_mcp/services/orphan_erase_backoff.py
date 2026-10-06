"""Per-owner retry backoff for the orphan-erasure sweep, and bounded error codes.

An orphan whose erasure keeps failing (a pod that refuses the erasure fence, a
reservation that was never hosted) was retried on every reconcile pass, held one of
the ``_ORPHAN_ERASE_BATCH`` slots each time, and logged the same failure every five
minutes. ``OrphanEraseBackoff`` holds such an owner back for 5 minutes, doubling to
6 hours, so it frees its slot and logs once per step.

The state is in memory per sweep holder. The fleet sweep lock gives the pass to one
holder at a time, and a new holder starts with no backoff. That only retries sooner,
never erases sooner: the worker's identity-absence confirmation still gates every
attempt, and backoff only ever removes an owner from a batch.

Diagnostics stay bounded. ``bounded_code`` admits an exception's ``code`` only when
it has the shape of a transport diagnostic (``POD_UNREACHABLE``,
``POD_REFUSED_403``); the exception message is never read here.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol, TypeVar

logger = logging.getLogger(__name__)

#: The only ``code`` shape that is logged; anything else falls back to the type name.
SAFE_CODE_RE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
FIRST_DELAY = timedelta(minutes=5)
MAX_DELAY = timedelta(hours=6)
#: 5 minutes * 2**7 already exceeds the cap; clamping keeps timedelta from overflowing.
_MAX_DOUBLINGS = 16


def bounded_code(exc: BaseException) -> str:
    """The exception's ``code`` when it matches ``SAFE_CODE_RE``, otherwise ``""``."""
    code = getattr(exc, "code", "")
    return code if isinstance(code, str) and SAFE_CODE_RE.fullmatch(code) else ""


def bounded_reason(exc: BaseException) -> str:
    """A bounded code, or the exception type name. Never the message."""
    return bounded_code(exc) or type(exc).__name__[:64]


def error_fields(exc: BaseException) -> str:
    """``error_type=<type>``, plus ``code=<code>`` when the code is bounded."""
    code = bounded_code(exc)
    return f"error_type={type(exc).__name__}" + (f" code={code}" if code else "")


class _Owned(Protocol):
    @property
    def user_id(self) -> str: ...

    @property
    def hushh_id(self) -> str: ...


_C = TypeVar("_C", bound=_Owned)


@dataclass(frozen=True)
class _Step:
    failures: int
    retry_at: datetime


class OrphanEraseBackoff:
    """Owner id -> consecutive erasure failures and the instant the next try is allowed."""

    def __init__(self, first: timedelta = FIRST_DELAY, cap: timedelta = MAX_DELAY) -> None:
        self._first = first
        self._cap = cap
        self._steps: dict[str, _Step] = {}

    def ready(self, candidates: Sequence[_C], now: datetime) -> list[_C]:
        """The candidates not held back at ``now``, in their original order."""
        return [c for c in candidates if not self._held(c.user_id, now)]

    def _held(self, user_id: str, now: datetime) -> bool:
        step = self._steps.get(user_id)
        return step is not None and now < step.retry_at

    def failed(
        self, label: str, candidate: _Owned, exc: Exception, now: datetime, detail: str
    ) -> timedelta:
        """Record one failed erasure, log it once for this step, return the delay.

        ``detail`` must already be redacted by the caller; it is logged as given.
        """
        previous = self._steps.get(candidate.user_id)
        failures = (previous.failures if previous else 0) + 1
        delay = min(self._first * (2 ** min(failures - 1, _MAX_DOUBLINGS)), self._cap)
        self._steps[candidate.user_id] = _Step(failures=failures, retry_at=now + delay)
        shown = candidate.hushh_id or "<none>"
        logger.warning(
            "[%s] personal_agent.orphan_erase_failed hushh_id=%s error=%s detail=%s",
            label,
            shown,
            type(exc).__name__,
            detail,
        )
        logger.warning(
            "[%s] personal_agent.orphan_erase_blocked reason=%s hushh_id=%s attempt=%d "
            "retry_in_s=%d",
            label,
            bounded_reason(exc),
            shown,
            failures,
            int(delay.total_seconds()),
        )
        return delay

    def forget(self, user_id: str) -> None:
        """Erased, or the owner reappeared: the next failure starts at the first step."""
        self._steps.pop(user_id, None)

    def retain(self, live_ids: set[str]) -> None:
        """Drop owners that are no longer candidates, so the map cannot grow unbounded."""
        for stale_id in [k for k in self._steps if k not in live_ids]:
            self._steps.pop(stale_id, None)

    def attempts(self, user_id: str) -> int:
        step = self._steps.get(user_id)
        return step.failures if step else 0
