"""
Webhook JSON parse error detail-leak tests (CWE-209).

Verifies that when the one_email, gmail, and plaid webhook endpoints receive a
malformed JSON body, the raw Python exception text (e.g. JSONDecodeError with
line/column offsets or partial payload content) is not forwarded to the caller.

These tests mount the real product routers from api.routes so the actual route
handlers are exercised, rather than a reimplementation of the handler logic.
Each webhook parses the request body before any auth or signature check, so a
malformed body reaches the JSON-parse branch under test directly.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Raw bytes that are not valid JSON. A leaky handler echoes JSONDecodeError text
# such as "Expecting property name enclosed in double quotes: line 1 column 2".
MALFORMED_BODY = b"{this is not valid json: true,}"

# (real mounted path, expected opaque error code)
_WEBHOOK_CASES = [
    ("/api/one/email/webhook", "ONE_EMAIL_WEBHOOK_INVALID_JSON"),
    ("/api/kai/gmail/webhook", "GMAIL_WEBHOOK_INVALID_JSON"),
    ("/api/kai/plaid/webhook", "PLAID_WEBHOOK_INVALID_JSON"),
]


@pytest.fixture(scope="module")
def client() -> TestClient:
    """Test app with the real webhook routers mounted at their product paths."""
    from api.routes.kai import gmail, plaid
    from api.routes.one import email

    app = FastAPI()
    # gmail and plaid routers are mounted under the /api/kai prefix in production
    # (api/routes/kai/__init__.py); email.router already carries its /api/one
    # prefix. Reproduce the production mount points here.
    app.include_router(gmail.router, prefix="/api/kai")
    app.include_router(plaid.router, prefix="/api/kai")
    app.include_router(email.router)
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("path,code", _WEBHOOK_CASES)
def test_webhook_malformed_json_returns_opaque_message(
    client: TestClient, path: str, code: str
) -> None:
    """The real handler must return the static opaque message and code on bad JSON."""
    resp = client.post(path, content=MALFORMED_BODY, headers={"Content-Type": "application/json"})

    assert resp.status_code == 400, resp.text
    detail = resp.json().get("detail", {})
    assert detail.get("code") == code
    assert detail.get("message") == "Webhook payload is not valid JSON."


@pytest.mark.parametrize("path,code", _WEBHOOK_CASES)
def test_webhook_malformed_json_does_not_leak_parser_internals(
    client: TestClient, path: str, code: str
) -> None:
    """No JSONDecodeError fragments (offsets, prefixes) may appear in the response."""
    resp = client.post(path, content=MALFORMED_BODY, headers={"Content-Type": "application/json"})

    assert resp.status_code == 400, resp.text
    raw = resp.text
    assert "Expecting" not in raw  # JSONDecodeError message prefix
    assert "line " not in raw
    assert "column " not in raw
    assert "char " not in raw
