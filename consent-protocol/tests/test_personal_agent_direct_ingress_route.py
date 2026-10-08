"""The owner sees a blocked switch to direct chat and can retry it, for their own row only."""

from __future__ import annotations

from typing import Any

import pytest

from api.routes.one import personal_agent
from api.routes.one import personal_agent_direct_ingress as route
from hushh_mcp.services import owner_direct_widen as widen
from hushh_mcp.services.owner_direct_ingress import BLOCKER_ORG_POLICY

_BLOCKED = {"ingress": "internal", "directIngressBlocker": {"code": BLOCKER_ORG_POLICY}}


@pytest.mark.parametrize(
    ("lane", "retryable"), [("dev", True), ("uat", False), ("production", False)]
)
def test_a_recorded_blocker_is_shown_in_plain_words(monkeypatch, lane, retryable):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", lane)
    status = route.direct_ingress_status(_BLOCKED)["directIngressBlocker"]
    assert status["code"] == BLOCKER_ORG_POLICY and status["retryable"] is retryable
    assert "Hussh" in status["message"] and chr(0x2014) not in status["message"]
    assert "cannot" not in status["message"]


@pytest.mark.parametrize(
    "metadata", [None, {}, {"ingress": "internal"}, {"directIngressBlocker": "x"}]
)
def test_no_blocker_adds_nothing(metadata):
    assert route.direct_ingress_status(metadata) == {}


async def test_the_status_read_carries_the_blocker():
    class _Registry:
        async def get(self, _user_id):
            return {
                "user_id": "owner",
                "hushh_id": "ha1_owner",
                "status": "provisioned",
                "deployment_target": "user_gcp",
                "backend_metadata": _BLOCKED,
            }

    result = await personal_agent.resolve_personal_agent_status(
        user_id="owner", registry=_Registry()
    )
    assert result["directIngressBlocker"]["code"] == BLOCKER_ORG_POLICY


def test_the_retry_route_is_mounted_on_the_personal_agent_router():
    paths = {
        (route_.path, tuple(sorted(route_.methods))) for route_ in personal_agent.router.routes
    }
    assert ("/api/one/personal-agent/direct-ingress/retry", ("POST",)) in paths


async def test_retry_clears_the_callers_own_blocker_then_schedules(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    seen: list[Any] = []

    async def clear(user_id, *, db=None):
        seen.append(("clear", user_id))
        return True

    class _Repo:
        async def get(self, user_id):
            seen.append(("get", user_id))
            return {"user_id": user_id, "backend_metadata": {"ingress": "internal"}}

    def schedule(user_id, *, row=None, db=None):
        seen.append(("schedule", user_id, row["user_id"]))
        return True

    monkeypatch.setattr(route, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(route, "clear_direct_ingress_blocker", clear)
    monkeypatch.setattr(route, "PersonalAgentRegistryRepo", _Repo)
    monkeypatch.setattr(route, "schedule_widen_if_due", schedule)
    result = await route.retry_direct_ingress.__wrapped__(request=None, user_id="owner")
    assert result == {"cleared": True, "scheduled": True}
    assert seen == [("clear", "owner"), ("get", "owner"), ("schedule", "owner", "owner")]


async def test_retry_is_unavailable_while_the_feature_is_off(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(route, "personal_agent_enabled", lambda: False)
    with pytest.raises(HTTPException) as refused:
        await route.retry_direct_ingress.__wrapped__(request=None, user_id="owner")
    assert refused.value.status_code == 404


@pytest.mark.parametrize("lane", ["uat", "production"])
async def test_retry_off_the_widening_lane_keeps_the_blocker_and_runs_nothing(monkeypatch, lane):
    """A Retry where nothing widens must not erase the only recorded reason."""
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", lane)
    writes: list[Any] = []

    async def write(_db, sql, params):
        writes.append(sql)
        return True

    class _Repo:
        async def get(self, user_id):
            return {"user_id": user_id, "backend_metadata": _BLOCKED}

    def schedule(*_args, **_kwargs):
        raise AssertionError("no widening is scheduled off the dev lane")

    monkeypatch.setattr(widen, "_write", write)
    monkeypatch.setattr(route, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(route, "PersonalAgentRegistryRepo", _Repo)
    monkeypatch.setattr(route, "schedule_widen_if_due", schedule)
    result = await route.retry_direct_ingress.__wrapped__(request=None, user_id="owner")
    assert result["cleared"] is False and result["scheduled"] is False
    assert result["directIngressBlocker"]["code"] == BLOCKER_ORG_POLICY
    assert result["directIngressBlocker"]["retryable"] is False
    assert writes == []
    assert await widen.clear_direct_ingress_blocker("owner") is False
    assert writes == []
