# tests/test_account_email_validation.py
"""
PR attach points:
  POST /api/account/email-aliases/verification/start
        (api/routes/account.py :: start_email_alias_verification)
  POST /api/account/email-aliases/verification/confirm
        (api/routes/account.py :: confirm_email_alias_verification)

Verifies that the email fields in both verification request models enforce
RFC 5322-simplified format validation.  Prior to this fix, any string with
length >= 3 was accepted (e.g. "abc"), allowing nonsensical values to reach
the downstream verification pipeline.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token

_UID = "test-uid-email-validation"
_TOKEN_DATA = {"user_id": _UID, "token": "fake", "scope": "vault.owner"}


@pytest.fixture()
def client():
    from server import app

    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN_DATA
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# start_email_alias_verification — email format
# ---------------------------------------------------------------------------

_START_URL = "/api/account/email-aliases/verification/start"


@pytest.mark.parametrize(
    "bad_email",
    [
        "abc",           # no @
        "abc@",          # no domain
        "@example.com",  # no local part
        "a b@x.com",     # space in local part
        "ab@",           # incomplete
        "notanemail",    # just a word
        "double@@x.com", # double @
    ],
)
def test_start_verification_invalid_email_rejected(client: TestClient, bad_email: str) -> None:
    """Malformed email addresses must return 422 from the validator."""
    resp = client.post(_START_URL, json={"email": bad_email})
    assert resp.status_code == 422, (
        f"Expected 422 for invalid email {bad_email!r}, got {resp.status_code}: {resp.text}"
    )


@pytest.mark.parametrize(
    "good_email",
    [
        "user@example.com",
        "first.last@subdomain.example.org",
        "user+tag@example.co.uk",
        "USER@EXAMPLE.COM",
    ],
)
def test_start_verification_valid_email_accepted(client: TestClient, good_email: str) -> None:
    """Well-formed email addresses must NOT be rejected with 422."""
    resp = client.post(_START_URL, json={"email": good_email})
    # Auth passes (mocked); downstream may 500/503 — that's fine
    assert resp.status_code != 422, (
        f"Valid email {good_email!r} was rejected with 422: {resp.text}"
    )


# ---------------------------------------------------------------------------
# confirm_email_alias_verification — email format
# ---------------------------------------------------------------------------

_CONFIRM_URL = "/api/account/email-aliases/verification/confirm"


@pytest.mark.parametrize(
    "bad_email",
    [
        "abc",
        "noatsign",
        "missing@",
    ],
)
def test_confirm_verification_invalid_email_rejected(client: TestClient, bad_email: str) -> None:
    """Malformed email in confirm request must return 422."""
    resp = client.post(
        _CONFIRM_URL,
        json={"email": bad_email, "verification_code": "123456"},
    )
    assert resp.status_code == 422, (
        f"Expected 422 for invalid email {bad_email!r}, got {resp.status_code}"
    )


def test_confirm_verification_valid_email_accepted(client: TestClient) -> None:
    """Well-formed email in confirm request must not be rejected with 422."""
    resp = client.post(
        _CONFIRM_URL,
        json={"email": "valid@example.com", "verification_code": "ABC123"},
    )
    assert resp.status_code != 422, (
        f"Valid email was rejected with 422: {resp.text}"
    )
