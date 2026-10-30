"""Finance metadata uses the canonical signed owner-feed harness and real keys."""

import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from test_pod_owner_feed import OWNER, POD, _client, envelope_mod
from test_pod_owner_feed import agent as agent


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source", "status"),
    [
        ("11111111-1111-4111-8111-111111111111", 200),
        ("finance:11111111-1111-4111-8111-111111111111:1", 200),
        ("finance:11111111-1111-4111-8111-111111111111:999999999", 200),
        ("finance:11111111-1111-4111-8111-111111111111:0", 422),
        ("finance:11111111-1111-4111-8111-111111111111:1000000000", 422),
        ("other:11111111-1111-4111-8111-111111111111:1", 422),
    ],
)
async def test_consent_http_route_uses_the_same_reference_contract_as_the_pod(
    monkeypatch, source, status
):
    from unittest.mock import AsyncMock

    from api.routes.one import pod_owner_feed
    from hushh_mcp.services.pod_consent_read import ConsentReadOptions

    # Isolate the HTTP schema before the separately tested signed owner feed.
    serve = AsyncMock(return_value={"envelope": "synthetic"})
    monkeypatch.setattr(pod_owner_feed, "serve_owner_feed", serve)
    app = FastAPI()
    app.include_router(pod_owner_feed.router)
    nonce = "a" * 32
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/one/pod/owner-feed/consent",
            params={"bundle_id": source, "read_nonce": nonce},
        )
    assert response.status_code == status
    if status == 200:
        serve.assert_awaited_once()
        assert serve.await_args.args[1] == "consent"
        assert serve.await_args.kwargs["consent"] == ConsentReadOptions(
            bundle_id=source, read_nonce=nonce
        )
    else:
        serve.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("replay", [False, True])
async def test_finance_authority_is_fresh_recipient_bound_metadata_for_private_pods(
    agent, monkeypatch, replay
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import pod_owner_feed_client
    from hushh_mcp.services.pod_consent_read import PodConsentReadPort

    owner = SimpleNamespace(owner=OWNER, require_access=AsyncMock())
    source = "finance:11111111-1111-4111-8111-111111111111:1"
    authority = {
        "sourceRef": source,
        "recipientUserId": OWNER,
        "senderName": "Owner",
        "revision": 1,
        "contentHash": "a" * 64,
        "status": "active",
        "modelProcessingAllowed": True,
        "sections": ["allocation"],
        "showAmounts": False,
    }

    class Hub:
        calls = 0
        first = None

        def get(self, path, *, params):
            self.calls += 1
            assert path.endswith("/consent") and params["bundle_id"] == source
            if replay and self.first is not None:
                body = self.first
            else:
                signed = envelope_mod.sign_feed(
                    kind="consent",
                    owner_id=OWNER,
                    hushh_id=POD,
                    projection={"readNonce": params["read_nonce"], "finance": authority},
                    issued_at_ms=int(time.time() * 1000),
                )
                body = {
                    "envelope": envelope_mod.seal_feed(
                        signed,
                        pod_public_key_raw=agent.private_key.public_key().public_bytes_raw(),
                        pod_key_id=agent.key_id,
                    )
                }
                self.first = body
            return SimpleNamespace(status_code=200, json=lambda: body)

    hub = Hub()
    monkeypatch.setattr(pod_owner_feed_client, "owner_feed_client", lambda: _client(agent, hub))
    port = PodConsentReadPort(owner)
    assert (await port.get(requester_user_id=OWNER, bundle_id=source))["modelProcessingAllowed"]
    authority.update(status="stopped", modelProcessingAllowed=False)
    if replay:
        with pytest.raises(PermissionError, match="binding_changed"):
            await port.get(requester_user_id=OWNER, bundle_id=source)
    else:
        assert (await port.lookup(OWNER, source))["progress"]["outcome"] == "revoked"
    assert hub.calls == 2
    with pytest.raises(PermissionError, match="requester_mismatch"):
        await port.get(requester_user_id="other", bundle_id=source)
    assert hub.calls == 2
