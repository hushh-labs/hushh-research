"""HTTP boundary for owner payout activity and receipts.

The owner comes only from the vault owner token, every response (including
401, 404, 422 and 503) is private and uncached, and malformed filters, edited
cursors and item IDs never reach the database.
"""

from datetime import UTC, datetime
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import payout_activity as activity_routes
from hushh_mcp.services import external_connector_lifecycle_store as lifecycle_store
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.payout_activity_service import PayoutActivityService, encode_cursor

PRIVATE = "private, no-store"
ITEM = "redemption:3f0c5a52-8f7e-4b8a-9d6a-2a1b3c4d5e6f"
PAGE = {
    "schemaVersion": 1,
    "mode": "live",
    "kind": "all",
    "asOf": "2026-10-11T10:00:00+00:00",
    "currency": "USD",
    "coinsPerDollar": 100,
    "balanceCoins": 0,
    "items": [],
    "nextCursor": None,
    "reset": False,
}


@pytest.fixture
def api(monkeypatch):
    """App with the real router and service; only the database read is faked."""
    state = {"result": PAGE, "error": None, "reads": 0, "calls": []}

    async def fake_read(self, operation):
        state["reads"] += 1
        if state["error"] is not None:
            raise state["error"]
        return state["result"]

    activity = PayoutActivityService.activity
    receipt = PayoutActivityService.receipt

    async def spy_activity(self, **kwargs):
        state["calls"].append(("activity", kwargs))
        return await activity(self, **kwargs)

    async def spy_receipt(self, **kwargs):
        state["calls"].append(("receipt", kwargs))
        return await receipt(self, **kwargs)

    monkeypatch.setattr(lifecycle_store, "get_db", lambda: None)
    monkeypatch.setattr(PayoutActivityService, "_read", fake_read)
    monkeypatch.setattr(PayoutActivityService, "activity", spy_activity)
    monkeypatch.setattr(PayoutActivityService, "receipt", spy_receipt)
    monkeypatch.setenv("STRIPE_MODE", "live")
    app = FastAPI()
    app.include_router(activity_routes.router)
    return app, TestClient(app), state


def _cursor(**overrides):
    fields = {
        "user_id": "owner",
        "mode": "live",
        "kind": "all",
        "occurred_at": datetime(2026, 10, 1, 9, 30, 15, 123456, tzinfo=UTC),
        "item_id": ITEM,
    }
    return encode_cursor(**{**fields, **overrides})


def test_routes_require_the_owner_token_and_never_cache_the_refusal(api):
    _app, client, state = api
    for path in ("/api/one/payouts/activity", "/api/one/payouts/activity/" + ITEM):
        response = client.get(path)
        assert response.status_code == 401
        assert response.headers["Cache-Control"] == PRIVATE
    assert state["reads"] == 0 and state["calls"] == []


def test_owner_comes_only_from_the_token(api):
    app, client, state = api
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    page = client.get("/api/one/payouts/activity?user_id=other&owner=other&kind=coins&limit=5")
    assert page.status_code == 200
    assert page.headers["Cache-Control"] == PRIVATE
    assert page.json() == PAGE
    state["result"] = {"id": ITEM, "kind": "redemption"}
    receipt = client.get("/api/one/payouts/activity/" + ITEM + "?user_id=other")
    assert receipt.status_code == 200
    assert receipt.headers["Cache-Control"] == PRIVATE
    assert [(name, kwargs["user_id"]) for name, kwargs in state["calls"]] == [
        ("activity", "owner"),
        ("receipt", "owner"),
    ]
    assert state["calls"][0][1] == {
        "user_id": "owner",
        "mode": "live",  # the configured Stripe mode by default
        "kind": "coins",
        "cursor": None,
        "limit": 5,
        "since": None,
    }


def test_signed_cursors_are_bound_to_owner_mode_and_kind(api):
    app, client, state = api
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    valid = _cursor()
    assert client.get("/api/one/payouts/activity", params={"cursor": valid}).status_code == 200
    payload, signature = valid.split(".")
    flipped = payload[:-3] + ("A" if payload[-3] != "A" else "B") + payload[-2:]
    for cursor, query in (
        (valid, {"kind": "coins"}),
        (valid, {"mode": "test"}),
        (_cursor(user_id="other"), {}),
        (flipped + "." + signature, {}),
        (payload, {}),
        (payload + "." + signature[:-1], {}),
        ("not-a-cursor", {}),
        ("a" * 257, {}),
    ):
        response = client.get("/api/one/payouts/activity", params={"cursor": cursor, **query})
        assert response.status_code == 422, (cursor, query)
        assert response.headers["Cache-Control"] == PRIVATE
        assert response.json()["detail"]["code"] == "INVALID_CURSOR"
    assert state["reads"] == 1


@pytest.mark.parametrize(
    "query",
    [
        "kind=bogus",
        "kind=",
        "mode=prod",
        "limit=0",
        "limit=51",
        "limit=2x",
        "limit=-1",
        "since=yesterday",
        "since=2026-10-11T10:00:00",  # no time zone
        "since=" + quote("2026-10-11T10:00:00+00:00") + "&cursor=x",
    ],
)
def test_malformed_filters_are_422_before_any_read(api, query):
    app, client, state = api
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = client.get("/api/one/payouts/activity?" + query)
    assert response.status_code == 422
    assert response.headers["Cache-Control"] == PRIVATE
    assert response.json()["detail"]["code"] == "INVALID_ACTIVITY_QUERY"
    assert state["reads"] == 0


def test_since_accepts_the_returned_as_of_even_with_a_decoded_plus(api):
    app, client, state = api
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    for raw in ("2026-10-11T10:00:00.123456+00:00", "2026-10-11T10:00:00.123456 00:00"):
        response = client.get("/api/one/payouts/activity?since=" + raw.replace("+", "%2B"))
        assert response.status_code == 200
    assert [kwargs["since"] for _, kwargs in state["calls"]] == [
        datetime(2026, 10, 11, 10, 0, 0, 123456, tzinfo=UTC)
    ] * 2


@pytest.mark.parametrize(
    "item_id",
    [
        "earning",
        "earning:",
        "earning:abc",
        "foo:3f0c5a52-8f7e-4b8a-9d6a-2a1b3c4d5e6f",
        "deposit:po_" + "a" * 70,
        "redemption:3f0c5a52 8f7e",
        "redemption:%2E%2E",
    ],
)
def test_malformed_item_ids_are_422_before_any_read(api, item_id):
    app, client, state = api
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    response = client.get("/api/one/payouts/activity/" + item_id)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "INVALID_ITEM_ID"
    assert response.headers["Cache-Control"] == PRIVATE
    assert state["reads"] == 0


def test_another_owners_or_unknown_item_is_404_and_outages_are_503(api):
    app, client, state = api
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    state["result"] = None  # the read model scopes by owner and finds nothing
    for item_id in (ITEM, "deposit:po_1ABCdef", "earning:not-a-uuid-at-all"):
        missing = client.get("/api/one/payouts/activity/" + item_id)
        assert missing.status_code == 404
        assert missing.headers["Cache-Control"] == PRIVATE
        assert missing.json()["detail"]["code"] == "ACTIVITY_ITEM_NOT_FOUND"
    state["error"] = ConnectorLifecycleError("connector_storage_unavailable")
    for path in ("/api/one/payouts/activity", "/api/one/payouts/activity/" + ITEM):
        outage = client.get(path)
        assert outage.status_code == 503
        assert outage.headers["Cache-Control"] == PRIVATE
        assert outage.json()["detail"] == {
            "code": "ACTIVITY_UNAVAILABLE",
            "message": "Activity is unavailable. Try again.",
        }
