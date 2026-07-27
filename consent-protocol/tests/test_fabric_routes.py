"""Tests for the Preference Subscription Fabric (grants, receipts, subscriber read).

Route tests mock the service layer (no DB); the full DB-backed grant -> read ->
revoke -> chain-verify flow is exercised against a real Postgres in
scripts/smoke (see PR notes). Scope-registry and receipt-hash tests are pure.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import fabric
from hushh_mcp.services import fabric_receipts_service as receipts_mod
from hushh_mcp.services.fabric_scope_registry import project_fields, resolve_fields

_UID = "owner-uid-1"
_SUBSCRIBER = "developer:acme-rialabs"


# ---------------------------------------------------------------------------
# Scope registry (pure, fail-closed)
# ---------------------------------------------------------------------------


def test_resolve_fields_maps_known_scope():
    fields, unmapped = resolve_fields(["wants.money.advisor"])
    assert fields == ["connect.want", "connect.zip"]
    assert unmapped == []


def test_resolve_fields_is_fail_closed_for_unknown_scope():
    fields, unmapped = resolve_fields(["favorites.secret-unmodelled"])
    assert fields == []
    assert unmapped == ["favorites.secret-unmodelled"]


def test_resolve_fields_dedupes_across_scopes():
    fields, _ = resolve_fields(["wants.money.advisor", "wants.financial-services"])
    assert fields == ["connect.want", "connect.zip"]


def test_project_fields_returns_only_present_paths():
    doc = {"connect": {"want": "wants.money.advisor", "zip": "98033", "updatedAt": 1}}
    out = project_fields(doc, ["connect.want", "connect.zip", "connect.missing"])
    assert out == {"connect.want": "wants.money.advisor", "connect.zip": "98033"}


# ---------------------------------------------------------------------------
# Receipt hashing (pure, deterministic + chain-linked)
# ---------------------------------------------------------------------------


def test_receipt_hash_is_deterministic_and_chains():
    payload = receipts_mod._canonical_payload(
        user_id=_UID,
        seq=1,
        event_type="GRANT",
        subscriber_id=_SUBSCRIBER,
        grant_id="g1",
        scopes=["wants.money.advisor"],
        fields=["connect.want"],
        purpose="local match",
        created_at_ms=1000,
        metadata={},
    )
    h1 = receipts_mod._chain_hash(receipts_mod.GENESIS_HASH, payload)
    h1_again = receipts_mod._chain_hash(receipts_mod.GENESIS_HASH, payload)
    assert h1 == h1_again  # deterministic
    # next link folds the previous hash in -> different hash for same payload
    h2 = receipts_mod._chain_hash(h1, payload)
    assert h2 != h1
    # signature is stable HMAC over the hash
    assert receipts_mod._sign(h1) == receipts_mod._sign(h1)
    assert receipts_mod._sign(h1) != receipts_mod._sign(h2)


# ---------------------------------------------------------------------------
# Owner routes (Firebase auth; service mocked)
# ---------------------------------------------------------------------------


def _owner_app() -> FastAPI:
    app = FastAPI()
    app.include_router(fabric.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    return app


def test_create_grant_returns_handle_and_receipt():
    created = {
        "grant_id": "g-abc",
        "handle": "HCT:payload.sig",
        "subscriber_id": _SUBSCRIBER,
        "scopes": ["wants.money.advisor"],
        "fields": ["connect.want", "connect.zip"],
        "purpose": "local match",
        "price_cents": None,
        "currency": None,
        "expires_at_ms": 9999,
        "receipt": {"seq": 1, "hash": "abc", "event_type": "GRANT"},
    }
    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.create_grant = AsyncMock(return_value=created)
        resp = TestClient(_owner_app()).post(
            "/api/fabric/grants",
            json={
                "subscriber_id": _SUBSCRIBER,
                "scopes": ["wants.money.advisor"],
                "purpose": "local match",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["handle"] == "HCT:payload.sig"
    assert body["receipt"]["event_type"] == "GRANT"
    # uid passed to the service is the verified token's, not the body's.
    assert factory.return_value.create_grant.await_args.kwargs["user_id"] == _UID


def test_create_grant_maps_service_error_to_http():
    from hushh_mcp.services.fabric_grant_service import FabricGrantError

    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.create_grant = AsyncMock(
            side_effect=FabricGrantError("FABRIC_SCOPES_REQUIRED", "At least one scope.", 422)
        )
        resp = TestClient(_owner_app()).post(
            "/api/fabric/grants",
            json={"subscriber_id": _SUBSCRIBER, "scopes": ["x"], "purpose": "p"},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "FABRIC_SCOPES_REQUIRED"


def test_revoke_grant():
    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.revoke_grant = AsyncMock(
            return_value={"grant_id": "g1", "status": "revoked", "already": False}
        )
        resp = TestClient(_owner_app()).post("/api/fabric/grants/g1/revoke")
    assert resp.status_code == 200
    assert resp.json()["status"] == "revoked"


def test_list_receipts():
    with patch.object(fabric, "get_fabric_receipts_service") as factory:
        factory.return_value.list_receipts = AsyncMock(
            return_value=[{"seq": 1, "event_type": "GRANT", "hash": "h1"}]
        )
        resp = TestClient(_owner_app()).get("/api/fabric/receipts")
    assert resp.status_code == 200
    assert resp.json()["count"] == 1


# ---------------------------------------------------------------------------
# Subscriber read route (developer-principal auth; service mocked)
# ---------------------------------------------------------------------------


def _subscriber_app(agent_id: str = _SUBSCRIBER) -> FastAPI:
    app = FastAPI()
    app.include_router(fabric.router)
    app.dependency_overrides[fabric.require_subscriber_principal] = lambda: SimpleNamespace(
        agent_id=agent_id, app_id="acme"
    )
    return app


def test_subscriber_read_returns_only_granted_fields():
    result = {
        "user_id": _UID,
        "subscriber_id": _SUBSCRIBER,
        "grant_id": "g1",
        "scopes": ["wants.money.advisor"],
        "fields": {"connect.want": "wants.money.advisor", "connect.zip": "98033"},
        "receipt": {"seq": 2, "hash": "h2", "event_type": "READ"},
    }
    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.read_for_subscriber = AsyncMock(return_value=result)
        resp = TestClient(_subscriber_app()).post(
            "/api/fabric/read", json={"handle": "HCT:cGF5bG9hZA.c2lnbmF0dXJl"}
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["fields"] == {"connect.want": "wants.money.advisor", "connect.zip": "98033"}
    assert body["receipt"]["event_type"] == "READ"
    # the subscriber id used is the authenticated principal's, never the body's.
    assert (
        factory.return_value.read_for_subscriber.await_args.kwargs["subscriber_id"] == _SUBSCRIBER
    )


def test_subscriber_read_revoked_grant_denied():
    from hushh_mcp.services.fabric_grant_service import FabricGrantError

    with patch.object(fabric, "get_fabric_grant_service") as factory:
        factory.return_value.read_for_subscriber = AsyncMock(
            side_effect=FabricGrantError("FABRIC_GRANT_REVOKED", "Revoked.", 403)
        )
        resp = TestClient(_subscriber_app()).post(
            "/api/fabric/read", json={"handle": "HCT:cGF5bG9hZA.c2lnbmF0dXJl"}
        )
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "FABRIC_GRANT_REVOKED"
