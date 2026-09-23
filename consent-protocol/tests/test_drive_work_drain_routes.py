"""Admission tests for the internal, OIDC-only Drive work drain route."""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import drive_work_drain as routes

PROJECT = "hushh-pda-uat"
SERVICE_ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
AUDIENCE = "https://api.uat.hushh.ai"
PATH = "/api/internal/drive-work/drain"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "true")
    monkeypatch.setenv("DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID", PROJECT)
    monkeypatch.setenv("DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL", SERVICE_ACCOUNT)
    monkeypatch.setenv("DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE", AUDIENCE)
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
    monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "false")
    verifier = Mock()
    monkeypatch.setattr(routes, "_verify_drive_work_drain_oidc_token", verifier)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "DRIVE_WORK_DRAIN_DISABLED"
    assert "no-store" in response.headers["Cache-Control"]
    verifier.assert_not_called()


def test_route_refuses_missing_or_non_oidc_credentials(client, monkeypatch):
    verifier = Mock(return_value=_claims())
    monkeypatch.setattr(routes, "_verify_drive_work_drain_oidc_token", verifier)

    for headers in ({}, {"Authorization": "Basic not-an-oidc-token"}):
        response = client.post(PATH, headers=headers)
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "DRIVE_WORK_DRAIN_UNAUTHORIZED"
        assert "no-store" in response.headers["Cache-Control"]
    verifier.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"iss": "https://attacker.example.invalid"},
        {"email": "drive-work-drain-sched@other-project.iam.gserviceaccount.com"},
        {"email_verified": False},
        {"aud": "https://wrong-audience.example.invalid"},
    ],
)
def test_route_refuses_wrong_issuer_project_identity_or_audience(client, monkeypatch, changes):
    monkeypatch.setattr(
        routes, "_verify_drive_work_drain_oidc_token", lambda *_: _claims(**changes)
    )

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "DRIVE_WORK_DRAIN_UNAUTHORIZED"
    assert "no-store" in response.headers["Cache-Control"]
    assert SERVICE_ACCOUNT not in response.text


def test_route_requires_complete_runtime_configuration(client, monkeypatch):
    monkeypatch.delenv("DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE")
    response = client.post(PATH, headers=_authorized_headers())
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "DRIVE_WORK_DRAIN_UNAVAILABLE"
    assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID", "other-uat-project"),
        (
            "DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL",
            "other@hushh-pda-uat.iam.gserviceaccount.com",
        ),
        ("DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE", "https://unreviewed.example.invalid"),
    ],
)
def test_route_refuses_scheduler_configuration_substitution(client, monkeypatch, name, value):
    verifier = Mock()
    monkeypatch.setattr(routes, "_verify_drive_work_drain_oidc_token", verifier)
    monkeypatch.setenv(name, value)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "DRIVE_WORK_DRAIN_UNAVAILABLE"
    verifier.assert_not_called()


def test_route_runs_fixed_bounded_coordinator_and_returns_only_aggregate_status(
    client, monkeypatch
):
    monkeypatch.setattr(routes, "_verify_drive_work_drain_oidc_token", lambda *_: _claims())
    run = AsyncMock(
        return_value={
            "schema_version": "drive.work_drain.v1",
            "workers": {
                "documents": {"ready": 1},
                "suggestions": {"review_ready": 1, "private_request_id": "not-allowed"},
                "permissions": {"succeeded": 1},
                "notifications": {"settled": 1},
            },
        }
    )

    class Drain:
        def run(self, **kwargs):
            return run(**kwargs)

    monkeypatch.setattr(routes, "DriveWorkDrain", Drain)
    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "schema_version": "drive.work_drain.v1",
        "workers": {
            "documents": {"ready": 1},
            "suggestions": {"review_ready": 1},
            "permissions": {"succeeded": 1},
            "notifications": {"settled": 1},
        },
    }
    assert "no-store" in response.headers["Cache-Control"]
    assert "private_request_id" not in response.text
    run.assert_awaited_once_with(max_jobs_per_worker=4, deadline_seconds=90)
