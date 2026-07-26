"""Tests for the Personal World Model store (/api/pwm) and its merge semantics."""

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import pwm
from hushh_mcp.services.pwm_service import PwmService

_UID = "firebase-uid-123"


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(pwm.router)
    # uid comes only from the verified token; the override stands in for it.
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    return app


# ---------------------------------------------------------------------------
# Merge semantics (pure unit — no DB, no HTTP)
# ---------------------------------------------------------------------------


def test_merge_upserts_new_section():
    stored = {}
    partial = {"connect": {"want": "wants.money.advisor", "zip": "98033", "updatedAt": 1000}}
    assert PwmService.merge(stored, partial) == partial


def test_merge_last_writer_wins_newer_incoming_replaces():
    stored = {"connect": {"want": "wants.money.advisor", "zip": "98033", "updatedAt": 1000}}
    partial = {"connect": {"want": "wants.home.plumber", "zip": "10001", "updatedAt": 2000}}
    assert PwmService.merge(stored, partial)["connect"]["zip"] == "10001"


def test_merge_rejects_stale_incoming_section():
    stored = {"connect": {"want": "wants.money.advisor", "zip": "98033", "updatedAt": 2000}}
    partial = {"connect": {"want": "stale", "zip": "00000", "updatedAt": 1000}}
    # Stored section is strictly newer -> stale write rejected.
    assert PwmService.merge(stored, partial)["connect"]["zip"] == "98033"


def test_merge_leaves_untouched_sections_intact():
    stored = {"connect": {"zip": "98033", "updatedAt": 1000}, "prefs": {"theme": "dark"}}
    partial = {"connect": {"zip": "10001", "updatedAt": 2000}}
    merged = PwmService.merge(stored, partial)
    assert merged["prefs"] == {"theme": "dark"}
    assert merged["connect"]["zip"] == "10001"


def test_merge_incoming_without_timestamp_wins_over_untimestamped():
    stored = {"connect": {"zip": "98033"}}
    partial = {"connect": {"zip": "10001"}}
    assert PwmService.merge(stored, partial)["connect"]["zip"] == "10001"


# ---------------------------------------------------------------------------
# Route behavior (service layer patched)
# ---------------------------------------------------------------------------


def test_get_returns_stored_doc():
    doc = {"connect": {"want": "wants.money.advisor", "zip": "98033", "updatedAt": 1000}}
    with patch.object(pwm, "get_pwm_service") as factory:
        factory.return_value.get_document = AsyncMock(return_value=doc)
        client = TestClient(_make_app())
        resp = client.get("/api/pwm")
    assert resp.status_code == 200
    assert resp.json() == doc


def test_get_returns_404_when_absent():
    with patch.object(pwm, "get_pwm_service") as factory:
        factory.return_value.get_document = AsyncMock(return_value=None)
        client = TestClient(_make_app())
        resp = client.get("/api/pwm")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "PWM_NOT_FOUND"


def test_put_merges_and_returns_doc():
    merged = {"connect": {"want": "wants.money.advisor", "zip": "98033", "updatedAt": 1000}}
    with patch.object(pwm, "get_pwm_service") as factory:
        factory.return_value.merge_document = AsyncMock(return_value=merged)
        client = TestClient(_make_app())
        resp = client.put("/api/pwm", json={"connect": merged["connect"]})
    assert resp.status_code == 200
    assert resp.json() == merged


def test_put_ignores_uid_in_body():
    captured = {}

    async def _capture(uid, partial):
        captured["uid"] = uid
        captured["partial"] = partial
        return partial

    with patch.object(pwm, "get_pwm_service") as factory:
        factory.return_value.merge_document = AsyncMock(side_effect=_capture)
        client = TestClient(_make_app())
        resp = client.put(
            "/api/pwm",
            json={"user_id": "attacker", "uid": "attacker", "connect": {"zip": "98033"}},
        )
    assert resp.status_code == 200
    # uid is the verified token's, never the body's; identity keys are dropped.
    assert captured["uid"] == _UID
    assert "user_id" not in captured["partial"]
    assert "uid" not in captured["partial"]
    assert captured["partial"] == {"connect": {"zip": "98033"}}


def test_empty_put_wipes():
    with patch.object(pwm, "get_pwm_service") as factory:
        delete_mock = AsyncMock(return_value=True)
        factory.return_value.delete_document = delete_mock
        client = TestClient(_make_app())
        resp = client.put("/api/pwm", json={})
    assert resp.status_code == 200
    assert resp.json() == {}
    delete_mock.assert_awaited_once_with(_UID)


def test_delete_wipes():
    with patch.object(pwm, "get_pwm_service") as factory:
        factory.return_value.delete_document = AsyncMock(return_value=True)
        client = TestClient(_make_app())
        resp = client.delete("/api/pwm")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": True, "existed": True}


def test_unauthenticated_request_is_rejected():
    # No dependency override -> the real Firebase auth dependency runs and 401s
    # (no Authorization header present).
    app = FastAPI()
    app.include_router(pwm.router)
    client = TestClient(app)
    assert client.get("/api/pwm").status_code == 401
