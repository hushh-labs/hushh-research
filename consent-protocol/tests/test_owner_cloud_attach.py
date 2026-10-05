"""A recorded owner-cloud setup attaches its agent without Build my agent.

Live, 2026-10-05: Connect Azure recorded, the agent was running in the person's
subscription, and the row stayed `reserved` until the attach was pressed by hand.
"""

from __future__ import annotations

import pytest

from api.routes.one import byoc_azure
from hushh_mcp.services import owner_cloud_attach
from hushh_mcp.services.owner_cloud_attach import attach_after_setup


class _Identities:
    def __init__(self, identity: dict | None) -> None:
        self._identity = identity

    async def get_many(self, user_ids):
        return {user_ids[0]: self._identity} if self._identity is not None else {}


class _Service:
    def __init__(self, *, fail: bool = False) -> None:
        self.calls: list[dict] = []
        self._fail = fail

    async def provision(self, **kwargs):
        self.calls.append(kwargs)
        if self._fail:
            raise RuntimeError("personal agent provision admission unavailable")
        return {"status": "connecting"}


VERIFIED = {"phone_verified": True, "phone_number": "+15550100"}


async def test_a_recorded_setup_attaches_the_agent_it_built():
    service = _Service()
    status = await attach_after_setup("owner", identities=_Identities(VERIFIED), service=service)
    assert status == "connecting"
    assert service.calls == [{"user_id": "owner", "phone_e164": "+15550100"}]


@pytest.mark.parametrize(
    "identity",
    [None, {"phone_verified": False, "phone_number": "+15550100"}, {"phone_verified": True}],
)
async def test_without_a_verified_phone_nothing_is_attached(identity):
    service = _Service()
    assert (
        await attach_after_setup("owner", identities=_Identities(identity), service=service) is None
    )
    assert service.calls == []


async def test_a_refused_attach_never_fails_the_recorded_setup():
    service = _Service(fail=True)
    assert (
        await attach_after_setup("owner", identities=_Identities(VERIFIED), service=service) is None
    )
    assert len(service.calls) == 1


async def test_setup_marks_the_cloud_step_then_attaches(monkeypatch):
    order: list[str] = []

    async def marker(user_id):
        order.append(f"marker:{user_id}")

    async def attach(user_id):
        order.append(f"attach:{user_id}")

    monkeypatch.setattr("api.routes.one.runtime._write_cloud_setup_marker", marker)
    monkeypatch.setattr(owner_cloud_attach, "attach_after_setup", attach)
    await byoc_azure._finish_recorded_setup("owner")
    assert order == ["marker:owner", "attach:owner"]
