"""Tests for the brand-initiated handshake (fabric consent requests).

Route tests mock the service layer (no DB); the full DB-backed
request -> lookup -> approve -> claim -> read flow is exercised against a real
Postgres in the PR verification. Pairing-code tests are pure.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import fabric
from hushh_mcp.services import fabric_request_service as req_mod

_UID = "owner-uid-1"
_SUBSCRIBER = "developer:acme-clinic"


# ---------------------------------------------------------------------------
# Pairing code (pure)
# ---------------------------------------------------------------------------


def test_pairing_code_shape_and_alphabet():
    for _ in range(50):
        code = req_mod._mint_pairing_code()
        assert len(code) == 9 and code[4] == "-"
        for ch in code.replace("-", ""):
            assert ch in req_mod._CODE_ALPHABET  # no vowels, no 0/O/1/I/L


def test_normalize_code_accepts_human_input():
    assert req_mod._normalize_code("bcdf-ghjk") == "BCDF-GHJK"
    assert req_mod._normalize_code("bcdfghjk") == "BCDF-GHJK"
    assert req_mod._normalize_code(" BCDF GHJK ") == "BCDF-GHJK"


# ---------------------------------------------------------------------------
# Route contract (services mocked)
# ---------------------------------------------------------------------------


def _owner_app() -> FastAPI:
    app = FastAPI()
    app.include_router(fabric.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    return app


def _subscriber_app(agent_id: str = _SUBSCRIBER) -> FastAPI:
    app = FastAPI()
    app.include_router(fabric.router)
    app.dependency_overrides[fabric.require_subscriber_principal] = lambda: SimpleNamespace(
        agent_id=agent_id, app_id="acme", display_name="Acme Clinic"
    )
    return app


def test_subscriber_creates_request():
    created = {
        "request_id": "r1",
        "pairing_code": "BCDF-GHJK",
        "expires_at_ms": 999,
        "poll_interval_ms": 2500,
    }
    with patch.object(fabric, "get_fabric_request_service") as factory:
        factory.return_value.create_request = AsyncMock(return_value=created)
        resp = TestClient(_subscriber_app()).post(
            "/api/fabric/requests",
            json={"scopes": ["privacy.marketing-email"], "purpose": "cookie compliance"},
        )
    assert resp.status_code == 200
    assert resp.json()["pairing_code"] == "BCDF-GHJK"
    # subscriber identity comes from the authenticated principal, not the body
    assert factory.return_value.create_request.await_args.kwargs["subscriber_id"] == _SUBSCRIBER


def test_owner_lookup_by_code():
    found = {
        "request_id": "r1",
        "subscriber_id": _SUBSCRIBER,
        "subscriber_label": "Acme Clinic",
        "scopes": ["privacy.marketing-email"],
        "fields": [],
        "unmapped_scopes": ["privacy.marketing-email"],
        "purpose": "cookie compliance",
        "ttl_ms": None,
        "price_cents": None,
        "currency": None,
        "expires_at_ms": 999,
    }
    with patch.object(fabric, "get_fabric_request_service") as factory:
        factory.return_value.lookup_by_code = AsyncMock(return_value=found)
        resp = TestClient(_owner_app()).get("/api/fabric/requests/code/BCDF-GHJK")
    assert resp.status_code == 200
    assert resp.json()["subscriber_label"] == "Acme Clinic"


def test_owner_approve_binds_token_uid():
    approved = {
        "request_id": "r1",
        "status": "approved",
        "grant_id": "g1",
        "scopes": ["privacy.marketing-email"],
        "fields": [],
        "receipt": {"seq": 1, "event_type": "GRANT"},
    }
    with patch.object(fabric, "get_fabric_request_service") as factory:
        factory.return_value.approve = AsyncMock(return_value=approved)
        resp = TestClient(_owner_app()).post(
            "/api/fabric/requests/r1/approve", json={"pairing_code": "BCDF-GHJK"}
        )
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"
    # uid is the verified token's, never from the body
    assert factory.return_value.approve.await_args.kwargs["user_id"] == _UID


def test_owner_deny():
    with patch.object(fabric, "get_fabric_request_service") as factory:
        factory.return_value.deny = AsyncMock(return_value={"request_id": "r1", "status": "denied"})
        resp = TestClient(_owner_app()).post(
            "/api/fabric/requests/r1/deny", json={"pairing_code": "BCDF-GHJK"}
        )
    assert resp.status_code == 200
    assert resp.json()["status"] == "denied"


def test_subscriber_poll_claims_handle_once():
    with patch.object(fabric, "get_fabric_request_service") as factory:
        factory.return_value.poll = AsyncMock(
            return_value={
                "request_id": "r1",
                "status": "approved",
                "handle": "HFG:abc.def",
                "grant_id": "g1",
            }
        )
        resp = TestClient(_subscriber_app()).get("/api/fabric/requests/r1")
    assert resp.status_code == 200
    assert resp.json()["handle"].startswith("HFG:")
    assert factory.return_value.poll.await_args.kwargs["subscriber_id"] == _SUBSCRIBER


def test_foreign_subscriber_poll_is_not_found():
    from hushh_mcp.services.fabric_grant_service import FabricGrantError

    with patch.object(fabric, "get_fabric_request_service") as factory:
        factory.return_value.poll = AsyncMock(
            side_effect=FabricGrantError("FABRIC_REQUEST_NOT_FOUND", "Request not found.", 404)
        )
        resp = TestClient(_subscriber_app("developer:evil")).get("/api/fabric/requests/r1")
    assert resp.status_code == 404
