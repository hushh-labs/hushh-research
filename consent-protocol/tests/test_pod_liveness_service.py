"""Tier-aware pod liveness.

The test that matters most here is not "does a dead pod get noticed" -- it is that
an ECONOMY pod, which is supposed to be asleep, is never probed, never marked
failed and never healed on the strength of its silence. Getting that wrong keeps
the scale-to-zero fleet permanently awake by way of its own health check, so it is
asserted from several angles rather than once.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services.pod_liveness_service import (
    HEALTH_DEGRADED,
    HEALTH_HEALTHY,
    HEALTH_SLEEPING,
    HEALTH_UNKNOWN,
    HEALTH_UNREACHABLE,
    MODE_ECONOMY,
    MODE_WARM,
    evaluate,
)

NOW = datetime(2026, 8, 5, 12, 0, 0, tzinfo=timezone.utc)
STALE = 300


def _row(**overrides) -> dict:
    row = {
        "user_id": "u1",
        "hushh_id": "h1",
        "liveness_mode": MODE_WARM,
        "liveness_failures": 0,
        "created_at": (NOW - timedelta(hours=1)).isoformat(),
        "last_heartbeat_at": NOW.isoformat(),
        "last_healed_at": None,
    }
    row.update(overrides)
    return row


def _evaluate(row: dict, **kwargs):
    return evaluate(row, now=NOW, warm_stale_seconds=STALE, **kwargs)


# -- warm tier ---------------------------------------------------------------


def test_warm_pod_with_fresh_heartbeat_is_healthy():
    decision = _evaluate(_row(last_heartbeat_at=(NOW - timedelta(seconds=30)).isoformat()))
    assert decision.health_state == HEALTH_HEALTHY
    assert not decision.is_actionable


def test_warm_pod_with_stale_heartbeat_is_degraded_and_probed_not_healed():
    """Stale means "stopped talking", which is not yet "is down"."""
    decision = _evaluate(
        _row(last_heartbeat_at=(NOW - timedelta(seconds=STALE + 60)).isoformat()),
        heal_enabled=True,
    )
    assert decision.health_state == HEALTH_DEGRADED
    assert decision.should_probe is True
    # The whole point: an unconfirmed inference never triggers a service replacement,
    # even with healing switched on.
    assert decision.should_heal is False


def test_warm_pod_is_unreachable_and_healed_once_probes_confirm_it():
    decision = _evaluate(
        _row(
            last_heartbeat_at=(NOW - timedelta(seconds=STALE + 60)).isoformat(),
            liveness_failures=2,
        ),
        heal_enabled=True,
    )
    assert decision.health_state == HEALTH_UNREACHABLE
    assert decision.should_heal is True


def test_confirmed_unreachable_is_reported_but_not_healed_while_the_switch_is_off():
    """Detection has to stand alone -- it runs long before anyone allows restarts."""
    decision = _evaluate(
        _row(
            last_heartbeat_at=(NOW - timedelta(seconds=STALE + 60)).isoformat(),
            liveness_failures=5,
        ),
        heal_enabled=False,
    )
    assert decision.health_state == HEALTH_UNREACHABLE
    assert decision.should_heal is False


def test_a_recently_healed_pod_is_not_healed_again():
    """A pod a restart cannot fix must not be restarted forever."""
    decision = _evaluate(
        _row(
            last_heartbeat_at=(NOW - timedelta(seconds=STALE + 60)).isoformat(),
            liveness_failures=9,
            last_healed_at=(NOW - timedelta(minutes=5)).isoformat(),
        ),
        heal_enabled=True,
    )
    assert decision.health_state == HEALTH_UNREACHABLE
    assert decision.should_heal is False


def test_heal_resumes_once_the_backoff_window_has_passed():
    decision = _evaluate(
        _row(
            last_heartbeat_at=(NOW - timedelta(seconds=STALE + 60)).isoformat(),
            liveness_failures=9,
            last_healed_at=(NOW - timedelta(hours=2)).isoformat(),
        ),
        heal_enabled=True,
    )
    assert decision.should_heal is True


# -- economy tier: silence is the healthy steady state ------------------------


def test_economy_pod_idle_past_the_warm_threshold_is_sleeping_not_failed():
    decision = _evaluate(
        _row(
            liveness_mode=MODE_ECONOMY,
            last_heartbeat_at=(NOW - timedelta(hours=6)).isoformat(),
        ),
        heal_enabled=True,
    )
    assert decision.health_state == HEALTH_SLEEPING
    assert decision.should_probe is False
    assert decision.should_heal is False


@pytest.mark.parametrize("idle_hours", [1, 6, 24, 24 * 30])
def test_no_amount_of_economy_silence_ever_produces_a_probe_or_a_heal(idle_hours: int):
    """The regression this module exists to prevent, asserted across the range.

    A scheduled probe is what WAKES a scale-to-zero service, so a sweep that probed
    on silence would keep the entire economy fleet awake and bill for it.
    """
    decision = _evaluate(
        _row(
            liveness_mode=MODE_ECONOMY,
            last_heartbeat_at=(NOW - timedelta(hours=idle_hours)).isoformat(),
            liveness_failures=99,
        ),
        heal_enabled=True,
    )
    assert decision.should_probe is False
    assert decision.should_heal is False
    assert decision.health_state != HEALTH_UNREACHABLE


def test_economy_pod_that_never_reported_is_unknown_rather_than_probed():
    decision = _evaluate(
        _row(
            liveness_mode=MODE_ECONOMY,
            last_heartbeat_at=None,
            created_at=(NOW - timedelta(days=3)).isoformat(),
        ),
        heal_enabled=True,
    )
    assert decision.health_state == HEALTH_UNKNOWN
    assert not decision.is_actionable


def test_the_same_silence_is_a_fault_on_warm_and_not_on_economy():
    """One row, one clock, one threshold -- only the stored mode differs."""
    silent = {"last_heartbeat_at": (NOW - timedelta(hours=6)).isoformat()}
    warm = _evaluate(_row(liveness_mode=MODE_WARM, **silent))
    economy = _evaluate(_row(liveness_mode=MODE_ECONOMY, **silent))
    assert warm.should_probe is True
    assert economy.should_probe is False


# -- boot grace + robustness --------------------------------------------------


def test_a_freshly_created_pod_is_unknown_not_degraded():
    """Judging a pod before its first heartbeat could have arrived would restart
    pods that were merely still booting."""
    decision = _evaluate(
        _row(last_heartbeat_at=None, created_at=(NOW - timedelta(seconds=10)).isoformat()),
        heal_enabled=True,
    )
    assert decision.health_state == HEALTH_UNKNOWN
    assert not decision.is_actionable


def test_a_warm_pod_past_boot_grace_with_no_heartbeat_is_probed():
    decision = _evaluate(
        _row(last_heartbeat_at=None, created_at=(NOW - timedelta(minutes=30)).isoformat())
    )
    assert decision.health_state == HEALTH_DEGRADED
    assert decision.should_probe is True


def test_an_unparseable_timestamp_does_not_raise():
    """A malformed row must not be able to take down a fleet-wide sweep."""
    decision = _evaluate(_row(last_heartbeat_at="not-a-timestamp"))
    assert decision.health_state in (HEALTH_UNKNOWN, HEALTH_DEGRADED)


def test_a_naive_timestamp_is_read_as_utc_rather_than_crashing():
    decision = _evaluate(_row(last_heartbeat_at=NOW.replace(tzinfo=None)))
    assert decision.health_state == HEALTH_HEALTHY


def test_an_unknown_mode_is_judged_by_the_warm_rule():
    """Fail safe: an unrecognised mode must not silently disable liveness for a
    paid instance."""
    decision = _evaluate(
        _row(
            liveness_mode="something-new",
            last_heartbeat_at=(NOW - timedelta(hours=6)).isoformat(),
        )
    )
    assert decision.should_probe is True
