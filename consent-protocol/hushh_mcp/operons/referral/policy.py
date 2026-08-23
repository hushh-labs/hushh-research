"""Referral qualification rules.

Every function here is pure and takes its clock as an argument. That is not
style: the qualification bar is fifteen real minutes, and a test that had to
wait fifteen real minutes would never be written. Injecting the clock is what
lets the exact boundary -- 899 seconds versus 900 -- be asserted in
milliseconds, against the same code that runs in production.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

# The relationship states, and the only transitions the server will make.
# Mirrored by a database trigger, deliberately: this module decides, the
# database refuses to be wrong even if this module is bypassed.
ATTRIBUTED = "attributed"
SIGNED_UP = "signed_up"
PHONE_VERIFIED = "phone_verified"
ONBOARDED = "onboarded"
ENGAGING = "engaging"
UNDER_REVIEW = "under_review"
QUALIFIED = "qualified"
INELIGIBLE = "ineligible"
REJECTED = "rejected"
EXPIRED = "expired"
REVOKED = "revoked"

TERMINAL_STATES = frozenset({INELIGIBLE, REJECTED, EXPIRED, REVOKED})

ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    ATTRIBUTED: frozenset({SIGNED_UP, INELIGIBLE, EXPIRED, REJECTED}),
    SIGNED_UP: frozenset({PHONE_VERIFIED, INELIGIBLE, EXPIRED, REJECTED}),
    PHONE_VERIFIED: frozenset({ONBOARDED, INELIGIBLE, EXPIRED, REJECTED}),
    ONBOARDED: frozenset({ENGAGING, INELIGIBLE, EXPIRED, REJECTED}),
    ENGAGING: frozenset({QUALIFIED, UNDER_REVIEW, EXPIRED, INELIGIBLE, REJECTED}),
    UNDER_REVIEW: frozenset({QUALIFIED, REJECTED, EXPIRED, INELIGIBLE}),
    QUALIFIED: frozenset({REVOKED}),
    INELIGIBLE: frozenset(),
    REJECTED: frozenset(),
    EXPIRED: frozenset(),
    REVOKED: frozenset(),
}

# What a person is shown. Four words or fewer, and never the reason.
PUBLIC_STATUS_LABELS: dict[str, str] = {
    ATTRIBUTED: "In progress",
    SIGNED_UP: "In progress",
    PHONE_VERIFIED: "In progress",
    ONBOARDED: "In progress",
    ENGAGING: "In progress",
    UNDER_REVIEW: "Under review",
    QUALIFIED: "Qualified",
    INELIGIBLE: "Expired",
    REJECTED: "Expired",
    EXPIRED: "Expired",
    REVOKED: "Expired",
}


class IllegalTransition(ValueError):
    """A transition the state machine will not make."""


@dataclass(frozen=True)
class ReferralPolicy:
    """One version of the program's rules, as read from the database."""

    version: int
    program_enabled: bool = True
    new_users_only: bool = True
    attribution_window_days: int = 30
    qualification_window_days: int = 7
    required_active_seconds: int = 900
    minimum_meaningful_events: int = 3
    eligible_agent_keys: tuple[str, ...] = ()
    heartbeat_interval_seconds: int = 30
    max_credit_per_heartbeat_secs: int = 30
    recent_interaction_window_secs: int = 60
    max_reporting_gap_seconds: int = 90


def can_transition(current: str, target: str) -> bool:
    return target in ALLOWED_TRANSITIONS.get(current, frozenset())


def assert_transition(current: str, target: str) -> str:
    if not can_transition(current, target):
        raise IllegalTransition(f"{current} -> {target}")
    return target


def public_status(internal_status: str) -> str:
    """The label a person sees. Unknown states fail safe, never optimistic."""
    return PUBLIC_STATUS_LABELS.get(internal_status, "In progress")


def counts_toward_public_total(internal_status: str) -> bool:
    """Only a live qualified referral is counted. Revoked ones stop counting."""
    return internal_status == QUALIFIED


def credit_for_heartbeat(
    *,
    previous_beat_at: datetime | None,
    beat_at: datetime,
    last_interaction_at: datetime | None,
    foreground: bool,
    policy: ReferralPolicy,
) -> int:
    """Seconds this heartbeat is worth. Server time only, never the client's.

    Returns 0 rather than raising for every "not really using it" case, because
    each of them is normal behaviour and not an error: the phone is in a pocket,
    the tab is hidden, the person walked away, the network dropped for two
    minutes and the session came back.
    """
    if not foreground:
        return 0

    # No recent touch means an open screen nobody is using. An idle agent view
    # is the cheapest thing in the world to fake, so it earns nothing.
    if last_interaction_at is None:
        return 0
    idle_for = (beat_at - last_interaction_at).total_seconds()
    if idle_for < 0 or idle_for > policy.recent_interaction_window_secs:
        return 0

    # First beat of a session credits one interval; there is no earlier beat to
    # measure from, and crediting the gap back to session start would pay for
    # time before anyone was watching.
    if previous_beat_at is None:
        return policy.max_credit_per_heartbeat_secs

    elapsed = (beat_at - previous_beat_at).total_seconds()

    # Out of order. Time cannot run backwards, and a batch that says it did is
    # either a replay or a broken client -- neither earns credit.
    if elapsed <= 0:
        return 0

    # The session went quiet for longer than we are willing to assume presence.
    # Whatever happened in that gap, we did not see it.
    if elapsed > policy.max_reporting_gap_seconds:
        return 0

    # Never more than one interval per beat, however long the gap: beating
    # slower must not be worth more than beating on time.
    return int(min(elapsed, policy.max_credit_per_heartbeat_secs))


def merge_intervals(intervals: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    """Collapse overlapping engagement windows into non-overlapping ones.

    Two tabs, two devices, or an agent switch produce sessions that overlap in
    real time. Adding their durations would let one person earn fifteen minutes
    in seven and a half, which is the cheapest way to farm this program.
    """
    usable = [(start, end) for start, end in intervals if end > start]
    if not usable:
        return []
    usable.sort(key=lambda pair: pair[0])
    merged = [usable[0]]
    for start, end in usable[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def eligible_credited_seconds(intervals: list[tuple[datetime, datetime]]) -> int:
    """Total wall-clock seconds covered, counting overlap once."""
    return int(sum((end - start).total_seconds() for start, end in merge_intervals(intervals)))


def qualification_window_closes_at(onboarded_at: datetime, policy: ReferralPolicy) -> datetime:
    return onboarded_at + timedelta(days=policy.qualification_window_days)


def attribution_expires_at(first_seen_at: datetime, policy: ReferralPolicy) -> datetime:
    return first_seen_at + timedelta(days=policy.attribution_window_days)


@dataclass(frozen=True)
class QualificationInput:
    """Everything the decision needs, already gathered by the caller."""

    status: str
    phone_verified: bool
    onboarding_complete: bool
    entered_application: bool
    credited_active_seconds: int
    meaningful_event_count: int
    used_eligible_agent: bool
    onboarded_at: datetime | None
    now: datetime
    risk_level: str = "low"


@dataclass(frozen=True)
class QualificationDecision:
    target_status: str
    reason: str
    changed: bool


def evaluate(candidate: QualificationInput, policy: ReferralPolicy) -> QualificationDecision:
    """Decide what this relationship's status should now be.

    Order matters. Expiry is checked before success so a person cannot qualify
    on time they spent after the window closed, and risk is checked after the
    bar is met so a clean referral is never held for review it did not earn.
    """
    status = candidate.status

    if status in TERMINAL_STATES or status == QUALIFIED:
        return QualificationDecision(status, "already_settled", changed=False)

    if not policy.program_enabled:
        return QualificationDecision(status, "program_disabled", changed=False)

    if candidate.onboarded_at is not None:
        closes_at = qualification_window_closes_at(candidate.onboarded_at, policy)
        if candidate.now >= closes_at:
            return QualificationDecision(EXPIRED, "qualification_window_closed", changed=True)

    if not candidate.phone_verified:
        return QualificationDecision(status, "phone_not_verified", changed=False)
    if not candidate.onboarding_complete:
        return QualificationDecision(status, "onboarding_incomplete", changed=False)
    if not candidate.entered_application:
        return QualificationDecision(status, "application_not_entered", changed=False)
    if not candidate.used_eligible_agent:
        return QualificationDecision(status, "no_eligible_agent", changed=False)

    if candidate.credited_active_seconds < policy.required_active_seconds:
        return QualificationDecision(status, "active_time_below_threshold", changed=False)
    if candidate.meaningful_event_count < policy.minimum_meaningful_events:
        return QualificationDecision(status, "events_below_threshold", changed=False)

    if candidate.risk_level == "high":
        return QualificationDecision(REJECTED, "risk_high", changed=True)
    if candidate.risk_level == "medium":
        if status == UNDER_REVIEW:
            return QualificationDecision(status, "awaiting_human_review", changed=False)
        return QualificationDecision(UNDER_REVIEW, "risk_medium", changed=True)

    return QualificationDecision(QUALIFIED, "qualified", changed=True)
