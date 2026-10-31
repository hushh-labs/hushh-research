"""Pure retry scheduling, separate from the store's locks and write authority."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

RetryState = Literal["queued", "unknown", "failed", "skipped"]
_RECONCILE_DELAYS = (30, 30, 120, 600, 3600)


@dataclass(frozen=True, slots=True)
class RetrySnapshot:
    now: datetime
    expires_at: datetime
    effect_state: str
    parent_active: bool
    attempts: int
    ordinary_failures: int
    quota_attempts: int
    first_quota_at: datetime | None


@dataclass(frozen=True, slots=True)
class RetryDecision:
    state: RetryState
    delay: float
    ordinary_failures: int
    quota_attempts: int
    first_quota_at: datetime | None
    owner_cooldown: datetime | None


def _state(
    snapshot: RetrySnapshot,
    *,
    quota: bool,
    quota_attempts: int,
    ordinary_failures: int,
    retryable: bool,
    uncertain: bool,
    deferred_until: datetime | None,
    error: str,
) -> RetryState:
    if deferred_until is not None and not uncertain:
        return "queued"
    if (
        uncertain
        or snapshot.effect_state == "dispatching"
        and error == "permission_outcome_unknown"
    ):
        # A dispatched write always receives GET reconciliation. Transient GET
        # failures retain uncertainty even after the ordinary attempt budget.
        return (
            "unknown"
            if snapshot.attempts < 5 or snapshot.effect_state == "dispatching" or retryable
            else "failed"
        )
    if (
        retryable
        and (quota_attempts < 6 if quota else ordinary_failures < 5)
        and snapshot.parent_active
    ):
        return "queued"
    return "failed" if quota or snapshot.effect_state != "queued" else "skipped"


def plan_retry(
    snapshot: RetrySnapshot,
    *,
    error: str,
    retryable: bool,
    uncertain: bool,
    deferred_until: datetime | None,
) -> RetryDecision:
    quota = error == "sharing_rate_limited" and not uncertain
    quota_attempts = min(6, snapshot.quota_attempts + int(quota))
    ordinary = min(
        5, snapshot.ordinary_failures + int(not quota and not uncertain and deferred_until is None)
    )
    first = snapshot.first_quota_at or (snapshot.now if quota else None)
    cooldown = None
    if quota and quota_attempts < 6:
        cooldown = (
            snapshot.now + timedelta(seconds=(300, 1800, 7200, 21600)[quota_attempts - 1])
            if quota_attempts <= 4
            else max(snapshot.now, (first or snapshot.now) + timedelta(hours=24))
        )
    state = _state(
        snapshot,
        quota=quota,
        quota_attempts=quota_attempts,
        ordinary_failures=ordinary,
        retryable=retryable,
        uncertain=uncertain,
        deferred_until=deferred_until,
        error=error,
    )
    if state == "queued":
        target = (
            deferred_until
            or cooldown
            or snapshot.now + timedelta(seconds=min(120, 2 ** max(1, snapshot.attempts)))
        )
        delay = max(0, (min(target, snapshot.expires_at) - snapshot.now).total_seconds())
    elif state == "unknown" and snapshot.effect_state == "unknown":
        delay = _RECONCILE_DELAYS[min(max(snapshot.attempts, 1), len(_RECONCILE_DELAYS)) - 1]
    else:
        delay = 30 if state == "unknown" else 0
    return RetryDecision(state, delay, ordinary, quota_attempts, first, cooldown)
