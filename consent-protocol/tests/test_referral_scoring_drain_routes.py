"""Admission tests for the internal, OIDC-only referral-scoring drain route.

Mirrors tests/test_drive_work_drain_routes.py's shape for the same
verification mechanism; the route-specific assertions are about who may call
it and that it actually drains the queue, not about scoring correctness
(that is pinned in tests/services/test_one_referral_scoring_service.py).
"""

from __future__ import annotations

from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import referral_scoring_drain as routes

PROJECT = "hushh-pda-uat"
SERVICE_ACCOUNT = "referral-scoring-sched@hushh-pda-uat.iam.gserviceaccount.com"
AUDIENCE = "https://api.uat.hushh.ai"
PRODUCTION_PROJECT = "hushh-pda"
PRODUCTION_SERVICE_ACCOUNT = "referral-scoring-sched@hushh-pda.iam.gserviceaccount.com"
PRODUCTION_AUDIENCE = "https://api.hushh.ai"
PATH = "/api/internal/referral-scoring/drain"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("REFERRAL_SCORING_DRAIN_ENABLED", "true")
    monkeypatch.setenv("REFERRAL_SCORING_DRAIN_SCHEDULER_PROJECT_ID", PROJECT)
    monkeypatch.setenv("REFERRAL_SCORING_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL", SERVICE_ACCOUNT)
    monkeypatch.setenv("REFERRAL_SCORING_DRAIN_SCHEDULER_AUDIENCE", AUDIENCE)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def _claims(**changes):
    return {
        "email": SERVICE_ACCOUNT,
        "email_verified": True,
        "iss": "https://accounts.google.com",
        "aud": AUDIENCE,
        **changes,
    }


def _authorized_headers():
    return {"Authorization": "Bearer scheduler-oidc-token"}


def test_route_is_default_off_and_never_attempts_oidc_when_disabled(client, monkeypatch):
    monkeypatch.setenv("REFERRAL_SCORING_DRAIN_ENABLED", "false")
    verifier = Mock()
    monkeypatch.setattr(routes, "_verify_referral_scoring_drain_oidc_token", verifier)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "REFERRAL_SCORING_DRAIN_DISABLED"
    assert "no-store" in response.headers["Cache-Control"]
    verifier.assert_not_called()


def test_route_refuses_missing_or_non_oidc_credentials(client, monkeypatch):
    verifier = Mock(return_value=_claims())
    monkeypatch.setattr(routes, "_verify_referral_scoring_drain_oidc_token", verifier)

    for headers in ({}, {"Authorization": "Basic not-an-oidc-token"}):
        response = client.post(PATH, headers=headers)
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "REFERRAL_SCORING_DRAIN_UNAUTHORIZED"
        assert "no-store" in response.headers["Cache-Control"]
    verifier.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"iss": "https://attacker.example.invalid"},
        {"email": "referral-scoring-sched@other-project.iam.gserviceaccount.com"},
        {"email_verified": False},
        {"aud": "https://wrong-audience.example.invalid"},
    ],
)
def test_route_refuses_wrong_issuer_project_identity_or_audience(client, monkeypatch, changes):
    monkeypatch.setattr(
        routes, "_verify_referral_scoring_drain_oidc_token", lambda *_: _claims(**changes)
    )

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "REFERRAL_SCORING_DRAIN_UNAUTHORIZED"
    assert "no-store" in response.headers["Cache-Control"]
    assert SERVICE_ACCOUNT not in response.text


def test_route_requires_complete_runtime_configuration(client, monkeypatch):
    monkeypatch.delenv("REFERRAL_SCORING_DRAIN_SCHEDULER_AUDIENCE")
    response = client.post(PATH, headers=_authorized_headers())
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "REFERRAL_SCORING_DRAIN_UNAVAILABLE"
    assert "no-store" in response.headers["Cache-Control"]


def _production_configuration(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("REFERRAL_SCORING_DRAIN_SCHEDULER_PROJECT_ID", PRODUCTION_PROJECT)
    monkeypatch.setenv(
        "REFERRAL_SCORING_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL", PRODUCTION_SERVICE_ACCOUNT
    )
    monkeypatch.setenv("REFERRAL_SCORING_DRAIN_SCHEDULER_AUDIENCE", PRODUCTION_AUDIENCE)


def test_production_worker_remains_default_off(client, monkeypatch):
    _production_configuration(monkeypatch)
    monkeypatch.delenv("REFERRAL_SCORING_DRAIN_ENABLED")
    verifier = Mock()
    monkeypatch.setattr(routes, "_verify_referral_scoring_drain_oidc_token", verifier)
    response = client.post(PATH, headers=_authorized_headers())
    assert response.status_code == 404
    verifier.assert_not_called()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("REFERRAL_SCORING_DRAIN_SCHEDULER_PROJECT_ID", PROJECT),
        ("REFERRAL_SCORING_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL", SERVICE_ACCOUNT),
        ("REFERRAL_SCORING_DRAIN_SCHEDULER_AUDIENCE", AUDIENCE),
    ],
)
def test_production_worker_rejects_uat_scheduler_configuration(client, monkeypatch, name, value):
    _production_configuration(monkeypatch)
    monkeypatch.setenv(name, value)
    verifier = Mock()
    monkeypatch.setattr(routes, "_verify_referral_scoring_drain_oidc_token", verifier)
    response = client.post(PATH, headers=_authorized_headers())
    assert response.status_code == 503
    verifier.assert_not_called()


def test_authorized_drain_claims_and_processes_due_jobs(client, monkeypatch):
    verifier = Mock(return_value=_claims())
    monkeypatch.setattr(routes, "_verify_referral_scoring_drain_oidc_token", verifier)
    job = {"job_id": "job-1", "relationship_id": "rel-1", "user_id": "user-1", "retry_count": 0}
    claim = Mock(return_value=[job])
    process = Mock(return_value={"status": "completed"})
    monkeypatch.setattr(routes, "claim_due_scoring_jobs", claim)
    monkeypatch.setattr(routes, "process_one_job", process)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "ok": True,
        "claimed": 1,
        "outcomes": {"completed": 1, "skipped": 0, "failed": 0},
    }
    claim.assert_called_once()
    process.assert_called_once_with(job)


def test_authorized_drain_with_no_due_jobs_is_a_clean_no_op(client, monkeypatch):
    verifier = Mock(return_value=_claims())
    monkeypatch.setattr(routes, "_verify_referral_scoring_drain_oidc_token", verifier)
    monkeypatch.setattr(routes, "claim_due_scoring_jobs", Mock(return_value=[]))
    process = Mock()
    monkeypatch.setattr(routes, "process_one_job", process)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "claimed": 0,
        "outcomes": {"completed": 0, "skipped": 0, "failed": 0},
    }
    process.assert_not_called()
