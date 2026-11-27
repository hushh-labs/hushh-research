"""POST /api/one/mail/overview/{brief,completed}: the HTTP boundary.

The services are replaced at their module seam. What is proven here: the vault
owner's identity and consent token are the only authority, request shapes are
strict, answers are never cached, and a failure is a typed code that never
carries mail text.
"""

from __future__ import annotations

import logging
from typing import Any
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import mail_overview_brief
from hushh_mcp.services.mail_overview import MailOverviewError

USER = "firebase-uid-owner"
LEAK = "quarterly payroll for secret-sender@example.com"


class Service:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.error: MailOverviewError | None = None

    def answer(self, name: str):
        async def call(**kwargs: Any) -> dict[str, Any]:
            self.calls.append((name, {k: v for k, v in kwargs.items() if k != "gmail"}))
            if self.error is not None:
                raise self.error
            return {"account": "acct", "ok": name}

        return call


@pytest.fixture
def app(monkeypatch, active_account_lifecycle):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middleware import require_vault_owner_token
    from api.routes.one import mail_overview as routes
    from hushh_mcp.services import owner_placement_guard as guard

    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    service = Service()
    monkeypatch.setattr(mail_overview_brief, "build_brief", service.answer("brief"))
    monkeypatch.setattr(mail_overview_brief, "completed_items", service.answer("completed"))
    monkeypatch.setattr(routes, "get_gmail_receipts_service", lambda: object())
    application = FastAPI()
    application.include_router(routes.router)
    application.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": USER,
        "token": "vault-fixture",
    }
    return TestClient(application), service


def test_brief_uses_the_owners_identity_and_consent_token_and_is_never_cached(app):
    client, service = app

    response = client.post("/api/one/mail/overview/brief", json={"expected_account": "acct"})

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert service.calls == [
        (
            "brief",
            {"user_id": USER, "consent_token": "vault-fixture", "expected_account": "acct"},
        )
    ]


def test_completed_needs_no_model_authority_and_is_never_cached(app):
    client, service = app

    response = client.post("/api/one/mail/overview/completed", json={})

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    # No consent token is handed to the part that has no model.
    assert service.calls == [("completed", {"user_id": USER, "expected_account": None})]


@pytest.mark.parametrize("path", ["brief", "completed"])
def test_requests_refuse_loose_shapes_and_never_take_a_user_or_message_from_the_browser(app, path):
    client, service = app

    for body in (
        {"user_id": "someone-else"},
        {"expected_account": ""},
        {"expected_account": "x" * 257},
        {"message_id": "18c-secret"},
        {"query": "payroll"},
        {"limit": 3},
    ):
        response = client.post(f"/api/one/mail/overview/{path}", json=body)
        assert response.status_code == 422, (path, body)
    assert service.calls == []


@pytest.mark.parametrize(
    "code,status",
    [
        ("CONNECT_REQUIRED", 409),
        ("RECONNECT_REQUIRED", 409),
        ("ACCOUNT_CHANGED", 409),
        ("MAIL_READS_UNAVAILABLE", 403),
        ("BRIEF_UNAVAILABLE", 503),
        ("BRIEF_TIMEOUT", 504),
        ("BRIEF_INVALID", 502),
        ("BRIEF_BUSY", 429),
    ],
)
@pytest.mark.parametrize("path", ["brief", "completed"])
def test_failures_are_typed_and_never_carry_mail_text(app, caplog, path, code, status):
    client, service = app
    service.error = MailOverviewError(code, "Authored message.", status)

    with caplog.at_level(logging.WARNING):
        response = client.post(f"/api/one/mail/overview/{path}", json={"expected_account": "acct"})

    assert response.status_code == status
    assert response.json()["detail"] == {"code": code, "message": "Authored message."}
    assert LEAK not in caplog.text and "secret-sender" not in caplog.text
    assert f"code={code}" in caplog.text
