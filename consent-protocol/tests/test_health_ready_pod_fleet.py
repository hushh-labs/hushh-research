"""Pod-fleet signal on /health/ready: ship-dark, reported-only, fail-safe.

Three properties are worth a test each, and each is a way the feature could be
silently wrong:

  1. **Flag off is byte-identical.** Not "has the same keys" -- the exact response
     bytes, so a stray key, a reordered key, or an accidentally-issued registry
     query all fail. The probe must also issue no SQL beyond the existing
     ``SELECT 1``.
  2. **A breached threshold never gates.** The pods are separate hosts; a fleet
     outage that took every control-plane instance out of rotation at once would
     turn a partial failure into a total one.
  3. **A registry read error never gates either.** ``personal_agent_registry`` is a
     dev-only parked migration, so in UAT and production the table simply is not
     there -- turning the signal on in an environment without the table must
     report ``unknown``, not 503.

The pool and the Firebase-configured check are monkeypatched, so nothing here
needs a database or Firebase.
"""

from __future__ import annotations

import asyncpg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import health as health_mod
from hushh_mcp.runtime_settings import pod_fleet_failed_threshold

# The exact bytes /health/ready returned before the pod-fleet signal existed.
LEGACY_READY_BODY = b'{"status":"ready","checks":{"database":"ok","firebase_admin":"ok"}}'


class _FakeConn:
    """Records every query so a test can assert what the probe actually ran."""

    def __init__(self, queries, *, failed_count=0, registry_error=None):
        self._queries = queries
        self._failed_count = failed_count
        self._registry_error = registry_error

    async def fetchval(self, query, *args):
        self._queries.append(query)
        if "personal_agent_registry" in query:
            if self._registry_error is not None:
                raise self._registry_error
            return self._failed_count
        return 1


class _FakeAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *_args):
        return False


class _FakePool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return _FakeAcquire(self._conn)


def _client(monkeypatch, *, db_ok=True, failed_count=0, registry_error=None):
    queries: list[str] = []
    conn = _FakeConn(queries, failed_count=failed_count, registry_error=registry_error)

    async def _get_pool():
        if not db_ok:
            raise RuntimeError("db down")
        return _FakePool(conn)

    monkeypatch.setattr(health_mod, "get_pool", _get_pool)
    monkeypatch.setattr(health_mod, "ensure_firebase_auth_admin", lambda: (True, "proj"))
    monkeypatch.setattr(health_mod, "_is_production_runtime", lambda: False)

    app = FastAPI()
    app.include_router(health_mod.router)
    return TestClient(app), queries


@pytest.fixture(autouse=True)
def _clean_pod_fleet_env(monkeypatch):
    """Unset both knobs so a developer's .env cannot decide a test's outcome."""
    monkeypatch.delenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", raising=False)
    monkeypatch.delenv("POD_FLEET_FAILED_THRESHOLD", raising=False)


# ── 1. Ship dark ────────────────────────────────────────────────────────────


def test_signal_off_body_is_byte_identical_to_the_legacy_contract(monkeypatch):
    client, queries = _client(monkeypatch, failed_count=999)
    resp = client.get("/health/ready")

    assert resp.status_code == 200
    assert resp.content == LEGACY_READY_BODY
    # No registry read at all: the flag-off path must not even touch the table.
    assert [q for q in queries if "personal_agent_registry" in q] == []


def test_signal_off_is_the_default_with_the_env_var_absent(monkeypatch):
    # The autouse fixture already deleted it; assert the default explicitly so a
    # future default flip fails here rather than silently in production.
    client, _ = _client(monkeypatch)
    assert "pod_fleet" not in client.get("/health/ready").json()["checks"]


def test_signal_off_when_the_flag_is_explicitly_false(monkeypatch):
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "0")
    client, _ = _client(monkeypatch, failed_count=999)
    assert client.get("/health/ready").content == LEGACY_READY_BODY


# ── 2. Reported, never gating ───────────────────────────────────────────────


def test_healthy_fleet_reports_ok(monkeypatch):
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "1")
    client, queries = _client(monkeypatch, failed_count=0)
    resp = client.get("/health/ready")

    assert resp.status_code == 200
    assert resp.json()["checks"]["pod_fleet"] == "ok"
    assert any("personal_agent_registry" in q for q in queries)


def test_count_at_the_threshold_is_still_ok(monkeypatch):
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "1")
    monkeypatch.setenv("POD_FLEET_FAILED_THRESHOLD", "3")
    client, _ = _client(monkeypatch, failed_count=3)
    assert client.get("/health/ready").json()["checks"]["pod_fleet"] == "ok"


def test_count_above_the_threshold_is_degraded_but_still_ready(monkeypatch):
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "1")
    monkeypatch.setenv("POD_FLEET_FAILED_THRESHOLD", "3")
    client, _ = _client(monkeypatch, failed_count=4)
    resp = client.get("/health/ready")

    # The load balancer must keep this instance: broken pods are not a broken hub.
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"
    assert resp.json()["checks"]["pod_fleet"] == "degraded"


def test_threshold_zero_reports_on_the_first_failure(monkeypatch):
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "1")
    monkeypatch.setenv("POD_FLEET_FAILED_THRESHOLD", "0")
    client, _ = _client(monkeypatch, failed_count=1)
    assert client.get("/health/ready").json()["checks"]["pod_fleet"] == "degraded"


# ── 3. Fail-safe ────────────────────────────────────────────────────────────


def test_missing_registry_table_is_unknown_not_unready(monkeypatch):
    # UAT/production reality: migration 900 is parked, so the table is absent.
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "1")
    client, _ = _client(
        monkeypatch,
        registry_error=asyncpg.exceptions.UndefinedTableError(
            'relation "personal_agent_registry" does not exist'
        ),
    )
    resp = client.get("/health/ready")

    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"
    assert resp.json()["checks"]["pod_fleet"] == "unknown"


def test_registry_read_error_is_unknown_not_unready(monkeypatch):
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "1")
    client, _ = _client(monkeypatch, registry_error=RuntimeError("registry exploded"))
    resp = client.get("/health/ready")

    assert resp.status_code == 200
    assert resp.json()["checks"]["pod_fleet"] == "unknown"


def test_db_down_is_still_the_only_reason_for_503(monkeypatch):
    monkeypatch.setenv("POD_FLEET_HEALTH_SIGNAL_ENABLED", "1")
    client, _ = _client(monkeypatch, db_ok=False)
    resp = client.get("/health/ready")

    assert resp.status_code == 503
    assert resp.json()["checks"]["database"] == "unavailable"
    # The fleet check degrades with the pool rather than adding a second cause.
    assert resp.json()["checks"]["pod_fleet"] == "unknown"


# ── Threshold parsing ───────────────────────────────────────────────────────


@pytest.mark.parametrize("raw", ["", "   ", "many", "-1", "3.5"])
def test_unparseable_or_negative_threshold_falls_back_to_the_default(monkeypatch, raw):
    monkeypatch.setenv("POD_FLEET_FAILED_THRESHOLD", raw)
    assert pod_fleet_failed_threshold() == 5


@pytest.mark.parametrize(("raw", "expected"), [("0", 0), ("1", 1), ("250", 250)])
def test_valid_threshold_is_honored(monkeypatch, raw, expected):
    monkeypatch.setenv("POD_FLEET_FAILED_THRESHOLD", raw)
    assert pod_fleet_failed_threshold() == expected
