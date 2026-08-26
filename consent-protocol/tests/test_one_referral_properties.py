"""Generated-input invariants for the referral program.

These are property tests in intent: assert a rule over a large sampled input
space rather than over hand-picked examples. They use a seeded `random.Random`
rather than Hypothesis, because CI installs Python dependencies with
`uv sync --frozen` and adding a library here would mean regenerating the lock
for the whole repository. The seed is fixed and printed on failure, so a
counterexample is reproducible; the trade-off is no automatic shrinking.

Each test states an invariant that must hold for every sequence, not a
behaviour for one sequence.
"""

from __future__ import annotations

import random
import string
from datetime import datetime, timedelta, timezone

from hushh_mcp.operons.referral.policy import (
    ALLOWED_TRANSITIONS,
    ATTRIBUTED,
    QUALIFIED,
    TERMINAL_STATES,
    ReferralPolicy,
    can_transition,
    credit_for_heartbeat,
    eligible_credited_seconds,
    merge_intervals,
)
from hushh_mcp.operons.referral.slug import (
    RESERVED_SLUGS,
    is_valid_slug,
    normalize_slug,
    slug_stem,
)

SEED = 20260823
NOW = datetime(2026, 8, 23, 12, 0, tzinfo=timezone.utc)
POLICY = ReferralPolicy(version=1)

_ALPHABET = string.ascii_letters + string.digits + " -_.@!#áéîöü😀\t\n/\\"


def _rng(tag: str) -> random.Random:
    # Per-test stream, so adding a test never shifts another test's inputs.
    # noqa: S311 -- deliberately NOT a cryptographic generator. These are test
    # inputs, and reproducibility from a fixed seed is the entire point;
    # secrets.SystemRandom would make a counterexample impossible to replay.
    return random.Random(f"{SEED}:{tag}")  # noqa: S311


def _random_text(rng: random.Random) -> str:
    return "".join(rng.choice(_ALPHABET) for _ in range(rng.randint(0, 40)))


# --- slugs ------------------------------------------------------------------


def test_normalization_is_idempotent_and_canonical():
    """Normalizing twice must equal normalizing once, for any input.

    If it did not, the same person's link could store one form and be looked up
    under another, and the lookup would simply never find them.
    """
    rng = _rng("normalize")
    for _ in range(3000):
        raw = _random_text(rng)
        once = normalize_slug(raw)
        assert normalize_slug(once) == once, f"seed={SEED} raw={raw!r}"


def test_a_normalized_slug_only_ever_contains_the_allowed_shape():
    rng = _rng("shape")
    for _ in range(3000):
        value = normalize_slug(_random_text(rng))
        if not value:
            continue
        assert all(ch.islower() or ch.isdigit() or ch == "-" for ch in value)
        assert not value.startswith("-") and not value.endswith("-")
        assert "--" not in value
        assert len(value) <= 64


def test_a_generated_stem_is_never_a_reserved_word():
    """A slug must never let someone impersonate Hushh itself."""
    rng = _rng("reserved")
    for _ in range(1500):
        assert slug_stem(_random_text(rng)) not in RESERVED_SLUGS
    for reserved in RESERVED_SLUGS:
        assert slug_stem(reserved) not in RESERVED_SLUGS
        assert is_valid_slug(reserved) is False


# --- credited time ----------------------------------------------------------


def test_credited_time_never_exceeds_the_wall_clock_it_covers():
    """The ceiling that makes the fifteen minutes mean fifteen minutes.

    However many sessions overlap, in whatever order they arrive, the credited
    total can never be more than the span from the earliest start to the latest
    end. Naive addition breaks this the moment two tabs are open.
    """
    rng = _rng("ceiling")
    for _ in range(2000):
        count = rng.randint(1, 8)
        intervals = []
        for _ in range(count):
            start = NOW + timedelta(minutes=rng.randint(0, 120))
            intervals.append((start, start + timedelta(minutes=rng.randint(0, 60))))
        credited = eligible_credited_seconds(intervals)
        span = (
            max(end for _, end in intervals) - min(start for start, _ in intervals)
        ).total_seconds()
        assert 0 <= credited <= span, f"seed={SEED} intervals={intervals}"


def test_merged_intervals_never_overlap_and_stay_ordered():
    rng = _rng("merge")
    for _ in range(1500):
        intervals = []
        for _ in range(rng.randint(0, 10)):
            start = NOW + timedelta(minutes=rng.randint(0, 200))
            intervals.append((start, start + timedelta(minutes=rng.randint(0, 90))))
        merged = merge_intervals(intervals)
        for (a_start, a_end), (b_start, b_end) in zip(merged, merged[1:], strict=False):
            assert a_end < b_start, f"seed={SEED} merged={merged}"
            assert a_start < a_end and b_start < b_end


def test_reordering_the_same_sessions_never_changes_the_total():
    """Event delivery order is not guaranteed. The answer must be."""
    rng = _rng("order")
    for _ in range(800):
        intervals = []
        for _ in range(rng.randint(1, 7)):
            start = NOW + timedelta(minutes=rng.randint(0, 100))
            intervals.append((start, start + timedelta(minutes=rng.randint(0, 45))))
        first = eligible_credited_seconds(intervals)
        shuffled = list(intervals)
        rng.shuffle(shuffled)
        assert eligible_credited_seconds(shuffled) == first


def test_a_heartbeat_is_never_worth_more_than_one_interval_and_never_negative():
    rng = _rng("beat")
    for _ in range(3000):
        previous_offset = rng.choice([None, *range(-120, 300)])
        credit = credit_for_heartbeat(
            previous_beat_at=(
                None if previous_offset is None else NOW - timedelta(seconds=previous_offset)
            ),
            beat_at=NOW,
            last_interaction_at=(
                None if rng.random() < 0.2 else NOW - timedelta(seconds=rng.randint(0, 300))
            ),
            foreground=rng.random() < 0.8,
            policy=POLICY,
        )
        assert 0 <= credit <= POLICY.max_credit_per_heartbeat_secs, f"seed={SEED}"


def test_replaying_one_heartbeat_forever_earns_nothing_after_the_first():
    """Idempotency at the arithmetic level: a repeated beat adds no time."""
    previous = NOW - timedelta(seconds=30)
    kwargs = dict(
        beat_at=NOW,
        last_interaction_at=NOW - timedelta(seconds=5),
        foreground=True,
        policy=POLICY,
    )
    first = credit_for_heartbeat(previous_beat_at=previous, **kwargs)
    assert first == 30
    # Once the session's cursor has moved to NOW, the same beat is worth zero,
    # however many times it is delivered.
    for _ in range(50):
        assert credit_for_heartbeat(previous_beat_at=NOW, **kwargs) == 0


# --- the state machine ------------------------------------------------------


def test_no_random_walk_can_reach_qualified_without_passing_the_funnel():
    """The safety property. Generate arbitrary transition attempts and assert
    that qualification is only ever reachable through engaging or review."""
    rng = _rng("walk")
    states = sorted(ALLOWED_TRANSITIONS)
    for _ in range(4000):
        current = ATTRIBUTED
        reached_gate = False
        for _ in range(rng.randint(1, 12)):
            target = rng.choice(states)
            if not can_transition(current, target):
                continue
            if target == QUALIFIED:
                assert reached_gate, f"seed={SEED} qualified from {current}"
            current = target
            reached_gate = current in {"engaging", "under_review"}


def test_a_terminal_state_is_absorbing_for_every_attempted_target():
    rng = _rng("absorb")
    states = sorted(ALLOWED_TRANSITIONS)
    for terminal in TERMINAL_STATES:
        for _ in range(200):
            assert can_transition(terminal, rng.choice(states)) is False


def test_every_declared_transition_target_is_a_real_state():
    known = set(ALLOWED_TRANSITIONS)
    for source, targets in ALLOWED_TRANSITIONS.items():
        assert source in known
        for target in targets:
            assert target in known, f"{source} -> {target} is not a state"
