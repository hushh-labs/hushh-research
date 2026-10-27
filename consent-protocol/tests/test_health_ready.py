"""Readiness-probe contract: /health stays liveness; /health/ready checks deps.

The DB pool and Firebase-configured check are monkeypatched, so the endpoint is
exercised without a database or Firebase. Verifies: healthy deps -> 200 ready,
DB down -> 503 not_ready, and that /health never reports a dependency.
"""

from __future__ import annotations

from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from firebase_admin import auth

from api.routes import health as health_mod
from hushh_mcp.services import phone_test_transport

PHONE_CONFIGURATION = {
    "HUSHH_UAT_PHONE_TEST_NUMBERS": "+16505550001",
    "HUSHH_UAT_PHONE_TEST_CODE": "654321",
    "HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET": "synthetic-uat-challenge-key",
    "HUSHH_PROD_PHONE_TEST_ENABLED": "true",
    "HUSHH_PROD_PHONE_TEST_NUMBERS": "+16505550002",
    "HUSHH_PROD_PHONE_TEST_CODE": "765432",
    "HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET": "synthetic-prod-challenge-key",
    "APP_SIGNING_KEY": "synthetic-app-signing-key-for-health-tests",
}
LEGACY_READY_BODY = b'{"status":"ready","checks":{"database":"ok","firebase_admin":"ok"}}'


@pytest.fixture(autouse=True)
def _isolated_phone_configuration(monkeypatch):
    for name in (
        *PHONE_CONFIGURATION,
        "UAT_PHONE_TEST_NUMBERS",
        "UAT_PHONE_TEST_CODE",
        "HUSHH_DEPLOY_ENV",
        "POD_FLEET_HEALTH_SIGNAL_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENVIRONMENT", "test")


class _FakeConn:
    async def fetchval(self, _query):
        assert _query == "SELECT 1"
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


@pytest.mark.parametrize(
    ("environment", "overrides", "expected"),
    [
        ("uat", {}, "healthy"),
        ("uat", {"HUSHH_UAT_PHONE_TEST_NUMBERS": ""}, "unavailable"),
        ("uat", {"HUSHH_UAT_PHONE_TEST_NUMBERS": "invalid"}, "unavailable"),
        ("uat", {"HUSHH_UAT_PHONE_TEST_CODE": " "}, "unavailable"),
        ("uat", {"HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET": ""}, "healthy"),
        (
            "uat",
            {"HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET": "", "APP_SIGNING_KEY": ""},
            "healthy",
        ),
        ("production", {}, "healthy"),
        ("production", {"HUSHH_PROD_PHONE_TEST_ENABLED": ""}, "unavailable"),
        ("production", {"HUSHH_PROD_PHONE_TEST_ENABLED": "false"}, "unavailable"),
        ("production", {"HUSHH_PROD_PHONE_TEST_NUMBERS": ""}, "unavailable"),
        ("production", {"HUSHH_PROD_PHONE_TEST_NUMBERS": "++1"}, "unavailable"),
        ("production", {"HUSHH_PROD_PHONE_TEST_CODE": " "}, "unavailable"),
        ("production", {"HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET": ""}, "unavailable"),
    ],
)
def test_phone_transport_prerequisites_are_advisory(monkeypatch, environment, overrides, expected):
    monkeypatch.setenv("ENVIRONMENT", environment)
    for name, value in (PHONE_CONFIGURATION | overrides).items():
        monkeypatch.setenv(name, value)
    client = _client(monkeypatch, production=environment == "production")

    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "checks": {"database": "ok", "firebase_admin": "ok", "phone_test_transport": expected},
    }


def test_uat_legacy_aliases_and_deploy_environment_use_canonical_fallbacks(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", " ")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", " UAT ")
    monkeypatch.setenv("UAT_PHONE_TEST_NUMBERS", "00 1 650 555 0001")
    monkeypatch.setenv("UAT_PHONE_TEST_CODE", "654321")

    response = _client(monkeypatch).get("/health/ready")

    assert response.status_code == 200
    assert response.json()["checks"]["phone_test_transport"] == "healthy"


@pytest.mark.parametrize("environment", ["", "test", "local", "development", "dev", "prod"])
def test_phone_signal_omitted_outside_governed_environments(monkeypatch, environment):
    monkeypatch.setenv("ENVIRONMENT", environment)
    for name, value in PHONE_CONFIGURATION.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_FIXTURE_MODE", "true")
    monkeypatch.setenv("DB_HOST", "localhost")
    monkeypatch.setenv("DB_NAME", "hushh_profile_fixture_health")
    monkeypatch.delenv("DB_UNIX_SOCKET", raising=False)

    assert _client(monkeypatch).get("/health/ready").content == LEGACY_READY_BODY


def test_private_pod_omits_phone_transport_and_hub_dependencies(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    client = _client(monkeypatch, db_ok=False, firebase_configured=False)
    client.app.state.runtime_topology = "private_pod"

    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.content == b'{"status":"ready","checks":{"pod_process":"ok"}}'


@pytest.mark.parametrize("environment", ["uat", "production"])
def test_phone_signal_never_issues_or_exposes_fixture_material(monkeypatch, caplog, environment):
    caplog.set_level("DEBUG")
    monkeypatch.setenv("ENVIRONMENT", environment)
    for name, value in PHONE_CONFIGURATION.items():
        monkeypatch.setenv(name, value)
    forbidden = Mock(side_effect=AssertionError("health must not issue or contact a provider"))
    for name in (
        "configured_dev_reviewer_phone_transport",
        "create_phone_test_challenge",
        "_create_uat_phone_test_verification_id",
        "validate_phone_test_confirmation",
    ):
        monkeypatch.setattr(phone_test_transport, name, forbidden)
    for name in ("get_user", "get_user_by_phone_number", "create_custom_token"):
        monkeypatch.setattr(auth, name, forbidden)
    client = _client(monkeypatch, production=environment == "production")

    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json()["checks"]["phone_test_transport"] == "healthy"
    forbidden.assert_not_called()
    for value in PHONE_CONFIGURATION.values():
        if value != "true":
            assert value not in response.text + caplog.text
    assert response.headers["cache-control"] == "no-store"


def test_healthy_phone_fixture_does_not_mask_dependency_failure(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    for name, value in PHONE_CONFIGURATION.items():
        monkeypatch.setenv(name, value)

    response = _client(monkeypatch, db_ok=False, production=True).get("/health/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert response.json()["checks"]["phone_test_transport"] == "healthy"
