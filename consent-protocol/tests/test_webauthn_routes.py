"""Route-contract tests for the WebAuthn ceremony endpoints (M14).

TestClient with the WebAuthn service faked and Firebase auth overridden, so the
routes are exercised without DB, auth, or real crypto. Verifies the flag gate and
the register/authenticate happy paths (incl. the deliberate 'session not wired' note).
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import limiter
from api.routes.one import webauthn as wa


class _FakeSvc:
    async def begin_registration(self, **kw):
        return '{"rp": {"id": "one.hushh.ai"}, "challenge": "reg"}'

    async def finish_registration(self, **kw):
        return {"credentialId": "c1", "aaguid": "ag-titan", "userVerified": True}

    async def begin_authentication(self, **kw):
        return '{"rpId": "one.hushh.ai", "challenge": "auth"}'

    async def finish_authentication(self, **kw):
        return {"userId": "u9", "credentialId": "c1", "aaguid": "ag-titan", "userVerified": True}


def _client(monkeypatch, *, enabled=True):
    monkeypatch.setenv("WEBAUTHN_ENABLED", "1" if enabled else "0")
    monkeypatch.setattr(wa, "_service", lambda: _FakeSvc())
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(wa.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid1"
    return TestClient(app)


def test_authenticate_options_404_when_flag_off(monkeypatch):
    resp = _client(monkeypatch, enabled=False).post("/api/one/webauthn/authenticate/options")
    assert resp.status_code == 404


def test_authenticate_options_returns_options(monkeypatch):
    resp = _client(monkeypatch).post("/api/one/webauthn/authenticate/options")
    assert resp.status_code == 200
    assert resp.json()["rpId"] == "one.hushh.ai"


def test_register_options_returns_options(monkeypatch):
    resp = _client(monkeypatch).post("/api/one/webauthn/register/options", json={"userName": "a@x"})
    assert resp.status_code == 200
    assert resp.json()["rp"]["id"] == "one.hushh.ai"


def test_register_verify_stores(monkeypatch):
    resp = _client(monkeypatch).post(
        "/api/one/webauthn/register/verify", json={"credential": {"id": "c1"}}
    )
    assert resp.status_code == 200
    assert resp.json()["credentialId"] == "c1"


def test_authenticate_verify_mints_session_when_user_verified(monkeypatch):
    monkeypatch.setattr(wa, "_mint_session", lambda **kw: "fake.custom.token")
    resp = _client(monkeypatch).post(
        "/api/one/webauthn/authenticate/verify", json={"credential": {"id": "c1"}}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["verified"] is True and body["userId"] == "u9"
    assert body["session"] == "minted" and body["customToken"] == "fake.custom.token"


def test_authenticate_verify_no_session_without_user_verification(monkeypatch):
    class _NoUV(_FakeSvc):
        async def finish_authentication(self, **kw):
            return {"userId": "u9", "credentialId": "c1", "userVerified": False, "aal": "AAL1"}

    monkeypatch.setenv("WEBAUTHN_ENABLED", "1")
    monkeypatch.setattr(wa, "_service", lambda: _NoUV())
    minted: list = []
    monkeypatch.setattr(wa, "_mint_session", lambda **kw: minted.append(kw) or "x")
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(wa.router)
    resp = TestClient(app).post(
        "/api/one/webauthn/authenticate/verify", json={"credential": {"id": "c1"}}
    )
    assert resp.status_code == 200
    assert resp.json()["session"] == "user_verification_required"
    assert minted == []  # an unverified assertion never mints a login session
