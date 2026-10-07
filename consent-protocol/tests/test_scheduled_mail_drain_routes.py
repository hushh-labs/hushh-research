"""Admission tests for the OIDC-only scheduled-mail drain route."""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.auth.exceptions import TransportError

from api.routes.one import scheduled_mail_drain as routes

SERVICE_ACCOUNT = "mail-scheduled-send@hushh-pda-uat.iam.gserviceaccount.com"
AUDIENCE = "https://api.uat.hushh.ai"
PRODUCTION_SERVICE_ACCOUNT = "mail-scheduled-send@hushh-pda.iam.gserviceaccount.com"
PRODUCTION_AUDIENCE = "https://api.hushh.ai"
PATH = "/api/one/email/scheduled/drain"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("MAIL_SCHEDULED_DRAIN_ENABLED", "true")
    monkeypatch.delenv("MAIL_SCHEDULED_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL", raising=False)
    monkeypatch.delenv("MAIL_SCHEDULED_DRAIN_SCHEDULER_AUDIENCE", raising=False)
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


def _drain(monkeypatch, **result):
    run = AsyncMock(
        return_value={
            "success": True,
            "fired": 0,
            "sent": [],
            "failed": [],
            "outcome_unknown": [],
            "cancelled": [],
            "expired": [],
            "limit": 50,
            **result,
        }
    )
    monkeypatch.setattr(routes, "drain_scheduled_mail", run)
    return run


@pytest.mark.parametrize("value", [None, "false", "0"])
def test_route_is_default_off_and_never_attempts_oidc_when_disabled(client, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("MAIL_SCHEDULED_DRAIN_ENABLED")
    else:
        monkeypatch.setenv("MAIL_SCHEDULED_DRAIN_ENABLED", value)
    verifier = Mock()
    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", verifier)
    run = _drain(monkeypatch)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "MAIL_SCHEDULED_DRAIN_DISABLED"
    assert "no-store" in response.headers["Cache-Control"]
    verifier.assert_not_called()
    run.assert_not_awaited()


def test_route_refuses_missing_or_non_oidc_credentials(client, monkeypatch):
    verifier = Mock(return_value=_claims())
    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", verifier)
    run = _drain(monkeypatch)

    for headers in ({}, {"Authorization": "Basic not-an-oidc-token"}, {"Authorization": "Bearer "}):
        response = client.post(PATH, headers=headers)
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "MAIL_SCHEDULED_DRAIN_UNAUTHORIZED"
        assert "no-store" in response.headers["Cache-Control"]
    verifier.assert_not_called()
    run.assert_not_awaited()


def test_route_refuses_a_token_that_fails_signature_verification(client, monkeypatch):
    def bad_signature(*_args):
        raise ValueError("Could not verify token signature.")

    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", bad_signature)
    run = _drain(monkeypatch)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 401
    assert "signature" not in response.text
    run.assert_not_awaited()


def test_certificate_fetch_failure_is_retryable_not_unauthorized(client, monkeypatch):
    def unreachable(*_args):
        raise TransportError("certs unreachable")

    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", unreachable)
    run = _drain(monkeypatch)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert "no-store" in response.headers["Cache-Control"]
    run.assert_not_awaited()


@pytest.mark.parametrize(
    "changes",
    [
        {"iss": "https://attacker.example.invalid"},
        {"email": "mail-scheduled-send@other-project.iam.gserviceaccount.com"},
        {"email": "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"},
        {"email_verified": False},
        {"aud": "https://wrong-audience.example.invalid"},
    ],
)
def test_route_refuses_wrong_issuer_identity_or_audience(client, monkeypatch, changes):
    monkeypatch.setattr(
        routes, "_verify_scheduled_mail_drain_oidc_token", lambda *_: _claims(**changes)
    )
    run = _drain(monkeypatch)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "MAIL_SCHEDULED_DRAIN_UNAUTHORIZED"
    assert SERVICE_ACCOUNT not in response.text
    run.assert_not_awaited()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        (
            "MAIL_SCHEDULED_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL",
            "other@hushh-pda-uat.iam.gserviceaccount.com",
        ),
        ("MAIL_SCHEDULED_DRAIN_SCHEDULER_AUDIENCE", "https://unreviewed.example.invalid"),
    ],
)
def test_route_refuses_scheduler_configuration_substitution(client, monkeypatch, name, value):
    verifier = Mock(return_value=_claims())
    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", verifier)
    monkeypatch.setenv(name, value)

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "MAIL_SCHEDULED_DRAIN_UNAVAILABLE"
    verifier.assert_not_called()


def test_production_accepts_only_the_exact_production_identity(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    verifier = Mock(return_value=_claims(email=PRODUCTION_SERVICE_ACCOUNT, aud=PRODUCTION_AUDIENCE))
    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", verifier)
    run = _drain(monkeypatch)

    response = client.post(PATH, headers=_authorized_headers())
    assert response.status_code == 200
    verifier.assert_called_once_with("scheduler-oidc-token", PRODUCTION_AUDIENCE)
    run.assert_awaited_once()

    verifier.return_value = _claims()
    assert client.post(PATH, headers=_authorized_headers()).status_code == 401

    monkeypatch.setenv("MAIL_SCHEDULED_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL", SERVICE_ACCOUNT)
    assert client.post(PATH, headers=_authorized_headers()).status_code == 503


def test_authorized_drain_runs_bounded_and_returns_only_ids_and_counts(client, monkeypatch):
    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", lambda *_: _claims())
    run = _drain(
        monkeypatch,
        fired=2,
        sent=["action-1"],
        outcome_unknown=["action-2"],
        limit=7,
        recipient="priya@example.com",
        subject="private subject",
    )

    response = client.post(f"{PATH}?limit=7", headers=_authorized_headers())

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "fired": 2,
        "limit": 7,
        "sent": ["action-1"],
        "failed": [],
        "outcome_unknown": ["action-2"],
        "cancelled": [],
        "expired": [],
    }
    assert "no-store" in response.headers["Cache-Control"]
    assert "priya" not in response.text and "private subject" not in response.text
    run.assert_awaited_once_with(limit=7, deadline_seconds=240)


@pytest.mark.parametrize("limit", ["0", "101", "ten"])
def test_out_of_range_limit_is_rejected_before_any_work(client, monkeypatch, limit):
    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", lambda *_: _claims())
    run = _drain(monkeypatch)

    response = client.post(f"{PATH}?limit={limit}", headers=_authorized_headers())

    assert response.status_code == 422
    run.assert_not_awaited()


def test_drain_failure_is_retryable_and_leaks_nothing(client, monkeypatch):
    monkeypatch.setattr(routes, "_verify_scheduled_mail_drain_oidc_token", lambda *_: _claims())
    monkeypatch.setattr(
        routes,
        "drain_scheduled_mail",
        AsyncMock(side_effect=RuntimeError("priya@example.com private subject")),
    )

    response = client.post(PATH, headers=_authorized_headers())

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert "priya" not in response.text


def test_router_is_mounted_on_the_one_api():
    from api.routes.one import router as one_router

    assert any(
        getattr(route, "path", "") == PATH and "POST" in getattr(route, "methods", set())
        for route in one_router.routes
    )
