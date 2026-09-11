"""Readiness-probe contract: /health stays liveness; /health/ready checks deps.

The DB pool and Firebase-configured check are monkeypatched, so the endpoint is
exercised without a database or Firebase. Verifies: healthy deps -> 200 ready,
DB down -> 503 not_ready, and that /health never reports a dependency.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import health as health_mod


class _FakeConn:
    async def fetchval(self, _query):
        return 1


class _FakeAcquire:
    async def __aenter__(self):
        return _FakeConn()

    async def __aexit__(self, *_args):
        return False


class _FakePool:
    def acquire(self):
        return _FakeAcquire()


def _client(monkeypatch, *, db_ok=True, firebase_configured=True, production=False):
    async def _get_pool():
        if not db_ok:
            raise RuntimeError("db down")
        return _FakePool()

    monkeypatch.setattr(health_mod, "get_pool", _get_pool)
    monkeypatch.setattr(
        health_mod, "ensure_firebase_auth_admin", lambda: (firebase_configured, "proj")
    )
    monkeypatch.setattr(health_mod, "_is_production_runtime", lambda: production)

    app = FastAPI()
    app.include_router(health_mod.router)
    return TestClient(app)


def test_liveness_never_touches_dependencies(monkeypatch):
    client = _client(monkeypatch, db_ok=False)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "healthy"
    assert "checks" not in body  # liveness reports no dependency state


def test_ready_when_all_dependencies_ok(monkeypatch):
    client = _client(monkeypatch, db_ok=True, firebase_configured=True)
    resp = client.get("/health/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["checks"]["database"] == "ok"
    assert body["checks"]["firebase_admin"] == "ok"


def test_not_ready_when_db_down(monkeypatch):
    client = _client(monkeypatch, db_ok=False)
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json()["status"] == "not_ready"
    assert resp.json()["checks"]["database"] == "unavailable"


def test_firebase_not_configured_is_soft_outside_production(monkeypatch):
    client = _client(monkeypatch, db_ok=True, firebase_configured=False, production=False)
    resp = client.get("/health/ready")
    # DB is up and we're not in production -> still ready, but the gap is reported.
    assert resp.status_code == 200
    assert resp.json()["checks"]["firebase_admin"] == "not_configured"


def test_firebase_not_configured_is_hard_in_production(monkeypatch):
    client = _client(monkeypatch, db_ok=True, firebase_configured=False, production=True)
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json()["status"] == "not_ready"
