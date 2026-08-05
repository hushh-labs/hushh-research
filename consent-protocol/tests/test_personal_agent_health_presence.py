"""What the owner is told about their agent's health.

The rule under test is restraint about what we do not know. Every registry row
starts at ``health_state='unknown'`` and stays there until the liveness sweep is
switched on, so the common case today is no verdict at all. Reporting that as
"healthy" would be the same class of untruth as a 200 on an empty page -- and it is
the exact failure this whole workstream exists to stop.
"""

from __future__ import annotations

import pytest

from api.routes.one import personal_agent


class _Registry:
    def __init__(self, row: dict | None) -> None:
        self._row = row

    async def get(self, _user_id: str):
        return self._row


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    monkeypatch.setattr(personal_agent, "personal_agent_enabled", lambda: True)

    # The status route opportunistically re-collects a pod key; keep it inert so
    # these tests exercise only the health mapping.
    async def _no_collect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(personal_agent, "collect_pod_key_if_pending", _no_collect, raising=False)


def _row(**overrides) -> dict:
    row = {
        "user_id": "u1",
        "hushh_id": "h1",
        "status": "provisioned",
        "health_state": "healthy",
        "last_heartbeat_at": "2026-08-05T12:00:00+00:00",
    }
    row.update(overrides)
    return row


async def _status(row: dict | None) -> dict:
    return await personal_agent.resolve_personal_agent_status(
        user_id="u1", registry=_Registry(row)
    )


@pytest.mark.parametrize(
    "health_state,expected",
    [("healthy", "healthy"), ("degraded", "degraded"), ("unreachable", "unreachable")],
)
async def test_a_verdict_on_a_live_agent_is_reported(health_state, expected):
    result = await _status(_row(health_state=health_state))
    assert result["state"] == "active"
    assert result["health"] == expected


async def test_a_sleeping_economy_pod_is_not_called_unhealthy():
    """Scaled to zero is working as designed. Telling its owner otherwise is false."""
    result = await _status(_row(health_state="sleeping"))
    assert result["health"] == "sleeping"
    assert result["state"] == "active"


async def test_an_unknown_verdict_is_omitted_rather_than_guessed():
    """The common case until the sweep is switched on. Absent means absent."""
    result = await _status(_row(health_state="unknown"))
    assert "health" not in result
    assert result["state"] == "active"


async def test_a_missing_health_column_is_omitted():
    """Pre-905 rows, and any backend that never reports one."""
    row = _row()
    row.pop("health_state")
    result = await _status(row)
    assert "health" not in result


async def test_an_unrecognised_health_value_is_never_echoed_to_the_caller():
    """A raw DB value reaching a client makes their state handling a function of
    our schema."""
    result = await _status(_row(health_state="something-new"))
    assert "health" not in result


async def test_health_is_not_reported_for_an_agent_with_no_host_yet():
    """Asking whether a reserved agent is reachable is a category error."""
    result = await _status(_row(status="pending", health_state="healthy"))
    assert result["state"] == "reserved"
    assert "health" not in result


async def test_last_seen_accompanies_a_verdict_but_never_stands_alone():
    """A bare timestamp invites each client to invent its own staleness rule --
    which is precisely the tier-aware judgment that must not be re-derived."""
    with_verdict = await _status(_row(health_state="healthy"))
    assert with_verdict["lastSeenAt"] == "2026-08-05T12:00:00+00:00"

    without_verdict = await _status(_row(health_state="unknown"))
    assert "lastSeenAt" not in without_verdict


async def test_a_missing_row_reports_no_health():
    result = await _status(None)
    assert "health" not in result
