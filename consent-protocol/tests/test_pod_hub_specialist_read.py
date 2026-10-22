"""The pod's egress to the data-door broker fails loud, never silent.

read_specialist is how a keyless pod reads a DB-backed specialist THROUGH the
hub. The one behaviour that must hold: a refusal or outage RAISES, so the
specialist degrades to runtime_unavailable (today's DB-wall). A swallowed failure
that returned empty state would make the pod answer "you share with nobody" for a
person who shares with many -- a confident wrong answer, the worst kind.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import pytest

from hushh_mcp.services.pod_hub_client import PodHubClient, PodHubUnavailable
from tests.test_pod_owner_feed import agent as agent


class _Resp:
    def __init__(self, status_code: int, payload: Optional[dict] = None, *, bad_json: bool = False):
        self.status_code = status_code
        self._payload = payload or {}
        self._bad = bad_json

    def json(self) -> dict:
        if self._bad:
            raise ValueError("not json")
        return self._payload


class _TokenResp:
    """The metadata server's identity-token response the client fetches first."""

    status_code = 200
    text = "pod-id-token"


class _Session:
    def __init__(self, resp: Any = None, boom: Exception | None = None):
        self._resp = resp
        self._boom = boom
        self.calls: list[dict] = []

    def get(self, url, params=None, headers=None, timeout=None):
        # The pod fetches its own identity token from the metadata server first.
        return _TokenResp()

    def post(self, url, data=None, headers=None, timeout=None):
        # The client serialises the body once and sends those exact (signed) bytes.
        self.calls.append(
            {"url": url, "json": json.loads(data) if data else None, "headers": headers}
        )
        if self._boom:
            raise self._boom
        return self._resp


def _client(session):
    return PodHubClient(base_url="https://hub.example", session=session)


@pytest.mark.parametrize(
    "code", ["connect_required", "connection_changed", "provider-private-details", {"bad": "shape"}]
)
def test_mail_refusal_preserves_only_declared_machine_codes(code):
    from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError

    session = _Session(_Resp(409, {"detail": {"code": code}}))
    error_type = (
        GmailMetadataError
        if code in ("connect_required", "connection_changed")
        else PodHubUnavailable
    )
    with pytest.raises(error_type) as error:
        _client(session).read_specialist(
            "email", "synthetic", email_read={"operation": "list_recent"}
        )
    if error_type is GmailMetadataError:
        assert error.value.code == code
    else:
        assert "provider-private-details" not in str(error.value)


def test_a_successful_read_returns_the_projection_state():
    projection = {"recipients": [{"userId": "friend"}], "circles": []}
    session = _Session(_Resp(200, {"name": "location", "state": projection}))
    state = _client(session).read_specialist("location", "scope-jwt")
    assert state == projection
    call = session.calls[0]
    assert call["url"].endswith("/api/one/pod/specialist/location/read")
    assert call["json"] == {"scopeToken": "scope-jwt"}


def test_a_refused_scope_raises_rather_than_returning_empty():
    session = _Session(_Resp(403, {"detail": "scope is not valid for this read"}))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_an_unknown_door_raises():
    session = _Session(_Resp(404, {"detail": "no such specialist read"}))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("vault", "scope-jwt")


def test_an_unreachable_hub_raises():
    session = _Session(boom=OSError("connection refused"))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_a_missing_state_body_raises_not_returns_none():
    session = _Session(_Resp(200, {"name": "location"}))  # no 'state'
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_a_non_json_body_raises():
    session = _Session(_Resp(200, bad_json=True))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "scope-jwt")


def test_an_empty_scope_token_raises_before_any_call():
    session = _Session(_Resp(200, {"state": {}}))
    with pytest.raises(PodHubUnavailable):
        _client(session).read_specialist("location", "")
    assert session.calls == [], "must not call the hub without a scope token"


@pytest.mark.parametrize(
    "state",
    [
        {"connected": True, "events": []},
        {
            "connected": True,
            "operation": "events",
            "range_start": "2026-10-01T00:00:00Z",
            "range_end": "2026-10-02T00:00:00Z",
        },
    ],
)
def test_calendar_read_rejects_old_or_mismatched_hub_coverage(state):
    client = _client(_Session(_Resp(200, {"state": state})))
    with pytest.raises(PodHubUnavailable, match="coverage"):
        client.read_specialist(
            "calendar",
            "synthetic-scope",
            calendar_read={
                "operation": "events",
                "start_at": "2026-10-01T00:00:00Z",
                "end_at": "2026-10-08T00:00:00Z",
            },
        )


async def test_commerce_port_uses_scoped_existing_door_and_owner_feed(monkeypatch):
    from hushh_mcp.services import pod_specialist_runtime as runtime
    from hushh_mcp.services.pod_owner_read_ports import OwnerFeedMarketplacePort

    calls = []
    page = {"items": [], "next_cursor": None}

    def door(name, scope, **options):
        calls.append((name, scope, options))
        return {"operation": "commerce_activity", "result": page}

    class Feed:
        def read(self, door, owner, *, params):
            calls.append((door, owner, params))
            return {"operation": "commerce_activity", "result": page}

    monkeypatch.setattr(runtime, "_hub_read", door)
    port = runtime.PodMarketplaceReadPort("owner", "marketplace-scope")
    assert await port.scope_commerce_activity(user_id="owner", view="sales", cursor=None) == page
    feed = OwnerFeedMarketplacePort("owner", Feed())
    assert (
        await feed.scope_commerce_activity(user_id="owner", view="purchases", cursor=None) == page
    )
    assert calls[0][0:2] == ("marketplace", "marketplace-scope")
    assert calls[0][2]["marketplace_read"]["operation"] == "commerce_activity"
    assert calls[1][0:2] == ("marketplace", "owner")
    for selected in (port, feed):
        with pytest.raises(PermissionError):
            await selected.scope_commerce_summary(user_id="other")
    assert len(calls) == 2


async def test_commerce_owner_feed_roundtrip_is_signed_sealed_and_owner_selected(agent):
    import asyncio

    from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions
    from hushh_mcp.services.pod_owner_read_ports import OwnerFeedMarketplacePort
    from hushh_mcp.services.pod_specialist_runtime import PodSpecialistInformationUnavailable
    from tests.test_pod_owner_feed import OWNER, _client, _Hub, _serve

    observed = []
    page = {
        "operation": "commerce_activity",
        "result": {"items": [], "next_cursor": None, "consent_token": "forbidden-token"},
        "provider_response": {"secret": "forbidden-provider"},
    }

    class CommerceHub(_Hub):
        def get(self, path, *, params=None):
            async def reader(kind, owner_id, *, marketplace, command):
                observed.append((kind, owner_id, marketplace.operation, marketplace.view))
                return page

            options = MarketplaceReadOptions(**params)
            served = asyncio.run(
                _serve(self.keypair, kind="marketplace", marketplace=options, reader=reader)
            )
            return _Resp(200, served)

    port = OwnerFeedMarketplacePort(OWNER, _client(agent, CommerceHub(agent)))
    assert await port.scope_commerce_activity(user_id=OWNER, view="sales", cursor=None) == {
        "items": [],
        "next_cursor": None,
    }
    assert observed == [("marketplace", OWNER, "commerce_activity", "sales")]
    with pytest.raises(PermissionError):
        await port.scope_commerce_summary(user_id="other")
    assert len(observed) == 1
    # A valid signed activity feed cannot stand in for a requested summary.
    with pytest.raises(PodSpecialistInformationUnavailable):
        await port.scope_commerce_summary(user_id=OWNER)
    assert observed[-1][2] == "commerce_summary"


async def test_unknown_commerce_operation_cannot_be_sealed_as_legacy_earnings(agent):
    from fastapi import HTTPException

    from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions
    from tests.test_pod_owner_feed import _serve

    async def forged(kind, owner_id, *, marketplace, command):
        return {"operation": "forged_operation", "result": {"accruedCents": 0}}

    with pytest.raises(HTTPException) as refused:
        await _serve(
            agent,
            kind="marketplace",
            marketplace=MarketplaceReadOptions(operation="commerce_activity"),
            reader=forged,
        )
    assert refused.value.status_code == 503


async def test_owner_feed_http_commerce_query_is_typed_and_preserves_signed_authority(monkeypatch):
    import httpx
    from fastapi import FastAPI

    from api.routes.one import pod_owner_feed as route

    received = []

    async def serve(request, kind, authorization, *, marketplace):
        received.append((kind, authorization, marketplace))
        return {"envelope": "synthetic-signed-feed"}

    monkeypatch.setattr(route, "serve_owner_feed", serve)
    app = FastAPI()
    app.include_router(route.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        path = "/api/one/pod/owner-feed/marketplace"
        reply = await c.get(
            path,
            params={"operation": "commerce_activity", "view": "sales", "cursor": "bounded"},
            headers={"Authorization": "signed-owner-request"},
        )
        assert reply.status_code == 200
        assert received[0][0:2] == ("marketplace", "signed-owner-request")
        assert received[0][2].operation == "commerce_activity"
        assert (received[0][2].view, received[0][2].cursor) == ("sales", "bounded")
        assert (await c.get(path, params={"operation": "commerce_summary"})).status_code == 200
        for params in (
            {"operation": "spend"},
            {"operation": "commerce_activity", "view": "all_owners"},
            {"operation": "commerce_activity", "cursor": "a" * 2049},
        ):
            assert (await c.get(path, params=params)).status_code == 422
        assert (
            await c.get("/api/one/pod/owner-feed/location", params={"view": "sales"})
        ).status_code == 422
    assert len(received) == 2
