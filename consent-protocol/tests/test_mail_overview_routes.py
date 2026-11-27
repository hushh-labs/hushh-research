"""POST /api/one/mail/overview/*: the contract the Mail screen depends on.

The service is replaced at its module seam; what is proven here is the HTTP
boundary: strict request shapes, typed refusals, no-store headers, and that
mail-derived input (the search text) never reaches a log line.
"""

from __future__ import annotations

import logging
from typing import Any
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import mail_overview
from hushh_mcp.services.mail_overview import MailOverviewError

USER = "firebase-uid-owner"
SOURCE_ID = "ms1." + "A" * 43
SEARCH_TEXT = "from:secret-sender@example.com payroll"


class Service:
    """Records what the route handed the service."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.error: MailOverviewError | None = None

    def _answer(self, name: str):
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
    monkeypatch.setattr(mail_overview, "list_messages", service._answer("list"))
    monkeypatch.setattr(mail_overview, "open_message", service._answer("open"))
    monkeypatch.setattr(mail_overview, "prepare_reply", service._answer("reply"))
    monkeypatch.setattr(routes, "get_gmail_receipts_service", lambda: object())
    application = FastAPI()
    application.include_router(routes.router)
    application.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": USER,
        "token": "vault-fixture",
    }
    return TestClient(application), service


def test_recent_defaults_to_five_rows_for_the_authenticated_owner_and_is_never_cached(app):
    client, service = app

    response = client.post("/api/one/mail/overview/recent", json={"expected_account": "acct"})

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert service.calls == [
        ("list", {"user_id": USER, "query": "", "limit": 5, "expected_account": "acct"})
    ]


def test_search_needs_an_explicit_query_and_refuses_loose_shapes(app):
    client, service = app

    for body in (
        {},
        {"query": ""},
        {"query": "plan", "limit": 26},
        {"query": "plan", "limit": 0},
        {"query": "x" * 513},
        {"query": "plan", "mailbox": "sent"},  # an unknown field is refused, not ignored
    ):
        assert client.post("/api/one/mail/overview/search", json=body).status_code == 422, body
    assert service.calls == []

    ok = client.post("/api/one/mail/overview/search", json={"query": "plan"})
    assert ok.status_code == 200
    # Negative control: the accepted request reaches the service with the 25-row cap, no more.
    assert service.calls == [
        ("list", {"user_id": USER, "query": "plan", "limit": 25, "expected_account": None})
    ]


def test_open_and_reply_accept_only_a_source_id_never_a_message_id_or_position(app):
    client, service = app

    for path in ("open", "reply-source"):
        for body in (
            {},
            {"source_id": "message-1"},
            {"source_id": "rs1." + "A" * 43},  # a reply reference is not a source id
            {"ordinal": 2, "offer_revision": 1},
            {"source_id": SOURCE_ID, "message_id": "18c-secret"},
        ):
            response = client.post(f"/api/one/mail/overview/{path}", json=body)
            assert response.status_code == 422, (path, body)
    assert service.calls == []

    assert (
        client.post("/api/one/mail/overview/open", json={"source_id": SOURCE_ID}).status_code == 200
    )
    assert (
        client.post(
            "/api/one/mail/overview/reply-source", json={"source_id": SOURCE_ID}
        ).status_code
        == 200
    )
    assert [name for name, _ in service.calls] == ["open", "reply"]


@pytest.mark.parametrize(
    "code,status",
    [
        ("CONNECT_REQUIRED", 409),
        ("RECONNECT_REQUIRED", 409),
        ("ACCOUNT_CHANGED", 409),
        ("SOURCE_CHANGED", 410),
        ("SOURCE_REF_INVALID", 422),
        ("MAIL_READS_UNAVAILABLE", 403),
        ("RETRYABLE", 503),
    ],
)
def test_failures_are_typed_and_never_carry_mail_or_the_search_text(app, caplog, code, status):
    client, service = app
    service.error = MailOverviewError(code, "Authored message.", status)

    with caplog.at_level(logging.WARNING):
        response = client.post("/api/one/mail/overview/search", json={"query": SEARCH_TEXT})

    assert response.status_code == status
    assert response.json()["detail"] == {"code": code, "message": "Authored message."}
    assert SEARCH_TEXT not in caplog.text and "secret-sender" not in caplog.text
    # The failure is still observable, by code alone.
    assert f"code={code}" in caplog.text
