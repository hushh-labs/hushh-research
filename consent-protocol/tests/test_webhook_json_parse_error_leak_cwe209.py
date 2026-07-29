"""Regression tests - CWE-209 in webhook JSON-parse error responses.

Gmail, One-email, and Plaid webhook endpoints previously included str(exc)
from json.JSONDecodeError in their 400 response bodies. This exposed internal
parser detail (offending character position, context snippet) to callers.
These tests verify that the raw exception message no longer appears in the
response and that a static opaque message is returned instead.

Attach points:
  api/routes/kai/gmail.py::gmail_webhook   -> POST /api/kai/gmail/webhook
  api/routes/one/email.py::one_email_webhook -> POST /api/one/email/webhook
  api/routes/kai/plaid.py::plaid_webhook   -> POST /api/kai/plaid/webhook
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import router as kai_router
from api.routes.one.email import router as one_email_router

# Shared minimal app fixture.
# Includes kai_router (/api/kai prefix, covers gmail and plaid webhooks) and
# one_email_router (/api/one prefix, covers one-email webhook).


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(kai_router)
    app.include_router(one_email_router)
    return TestClient(app, raise_server_exceptions=False)


# Helpers

_MALFORMED = b"{ definitely not valid JSON !!!"


def _post_raw(client: TestClient, url: str, body: bytes):
    return client.post(
        url,
        content=body,
        headers={"Content-Type": "application/json"},
    )


# Gmail webhook


class TestGmailWebhookJsonParseLeak:
    """gmail_webhook must not echo json.JSONDecodeError detail in 400 responses."""

    def test_sentinel_not_in_gmail_webhook_400(self, client: TestClient) -> None:
        sentinel = "SENTINEL_GMAIL_JSON_PARSE_DETAIL_b3f7"

        with patch(
            "api.routes.kai.gmail.Request.json",
            new_callable=lambda: lambda self: (_ for _ in ()).throw(ValueError(sentinel)),
        ):
            resp = _post_raw(client, "/api/kai/gmail/webhook", _MALFORMED)

        assert sentinel not in resp.text, (
            "JSON parse error detail leaked into gmail_webhook 400 response"
        )

    def test_gmail_webhook_400_static_message(self, client: TestClient) -> None:
        resp = _post_raw(client, "/api/kai/gmail/webhook", _MALFORMED)
        assert resp.status_code == 400
        body = resp.json()
        detail = body.get("detail", {})
        assert detail.get("code") == "GMAIL_WEBHOOK_INVALID_JSON"
        assert detail.get("message") == "Webhook payload is not valid JSON."


# One-email webhook


class TestOneEmailWebhookJsonParseLeak:
    """one_email_webhook must not echo json.JSONDecodeError detail in 400 responses."""

    def test_sentinel_not_in_email_webhook_400(self, client: TestClient) -> None:
        sentinel = "SENTINEL_EMAIL_JSON_PARSE_DETAIL_c9a2"

        with patch(
            "api.routes.one.email.Request.json",
            new_callable=lambda: lambda self: (_ for _ in ()).throw(ValueError(sentinel)),
        ):
            resp = _post_raw(client, "/api/one/email/webhook", _MALFORMED)

        assert sentinel not in resp.text, (
            "JSON parse error detail leaked into one_email_webhook 400 response"
        )

    def test_email_webhook_400_static_message(self, client: TestClient) -> None:
        resp = _post_raw(client, "/api/one/email/webhook", _MALFORMED)
        assert resp.status_code == 400
        body = resp.json()
        detail = body.get("detail", {})
        assert detail.get("code") == "ONE_EMAIL_WEBHOOK_INVALID_JSON"
        assert detail.get("message") == "Webhook payload is not valid JSON."


# Plaid webhook


class TestPlaidWebhookJsonParseLeak:
    """plaid_webhook must not echo json.JSONDecodeError detail in 400 responses."""

    def test_sentinel_not_in_plaid_webhook_400(self, client: TestClient) -> None:
        sentinel = "SENTINEL_PLAID_JSON_PARSE_DETAIL_d5e1"

        async def _bad_body():
            return sentinel.encode()

        with patch("api.routes.kai.plaid.Request.body", new=_bad_body):
            resp = _post_raw(client, "/api/kai/plaid/webhook", _MALFORMED)

        assert sentinel not in resp.text, (
            "JSON parse error detail leaked into plaid_webhook 400 response"
        )

    def test_plaid_webhook_400_static_message(self, client: TestClient) -> None:
        resp = _post_raw(client, "/api/kai/plaid/webhook", _MALFORMED)
        assert resp.status_code == 400
        body = resp.json()
        detail = body.get("detail", {})
        assert detail.get("code") == "PLAID_WEBHOOK_INVALID_JSON"
        assert detail.get("message") == "Webhook payload is not valid JSON."
