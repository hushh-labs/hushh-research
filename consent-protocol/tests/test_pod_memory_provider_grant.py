"""Direct grant delivery preserves owner authorization and issuer failure boundaries."""

import pytest
from fastapi import HTTPException

from hushh_mcp.constants import ConsentScope


@pytest.fixture
def relay(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")


class _Audit:
    async def authorize_owner_read(self, **kwargs):
        return {"authorized": True}


async def test_direct_memory_grant_authorizes_before_minting_without_pod_transport(relay):
    from api.routes.one.pod_memory_provider_grant import issue_memory_provider_grant
    from hushh_mcp.services.pod_access_audit import PodAccessDenied

    events = []

    class Audit:
        async def authorize_owner_read(self, **kwargs):
            events.append("audit")
            if kwargs["hushh_id"] != "ha1owner" or kwargs["user_id"] != "uid-1":
                raise PodAccessDenied("wrong owner")

    async def issue(user_id, **kwargs):
        events.append("mint")
        assert user_id == "uid-1"
        assert kwargs["scope"] is ConsentScope.CAP_MEMORY_PROVIDER_PROCESS
        assert kwargs["expires_in_ms"] == 300000
        return {"token": "synthetic-provider-grant", "expiresAt": 12345}

    result = await issue_memory_provider_grant(
        hushh_id="ha1owner",
        user_id="uid-1",
        audit=Audit(),
        provider_grants=issue,
    )
    assert events == ["audit", "mint"]
    assert result == {
        "hushhId": "ha1owner",
        "providerConsentToken": "synthetic-provider-grant",
        "expiresAt": 12345,
    }
    for owner, hushh_id in [("uid-2", "ha1owner"), ("uid-1", "ha1other")]:
        events.clear()
        with pytest.raises(HTTPException) as refused:
            await issue_memory_provider_grant(
                hushh_id=hushh_id,
                user_id=owner,
                audit=Audit(),
                provider_grants=issue,
            )
        assert refused.value.status_code == 403 and events == ["audit"]


async def test_direct_memory_grant_refuses_authority_failure_and_disables_caching(
    relay, monkeypatch
):
    from fastapi import Response

    from api.routes.one import pod_memory_provider_grant as pod_relay

    async def unavailable(*args, **kwargs):
        raise RuntimeError("synthetic authority failure")

    with pytest.raises(HTTPException) as refused:
        await pod_relay.issue_memory_provider_grant(
            hushh_id="ha1owner",
            user_id="uid-1",
            audit=_Audit(),
            provider_grants=unavailable,
        )
    assert refused.value.status_code == 503

    async def issued(**kwargs):
        return {"hushhId": kwargs["hushh_id"], "providerConsentToken": "synthetic"}

    monkeypatch.setattr(pod_relay, "issue_memory_provider_grant", issued)
    response = Response()
    await pod_relay.memory_provider_grant_route(response, hushh_id="ha1owner", user_id="uid-1")
    assert response.headers["Cache-Control"] == "no-store"
