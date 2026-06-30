"""
Regression tests for push-token input-length enforcement.

Attach point: api/routes/notifications.py

Bug: POST /api/notifications/register and DELETE /api/notifications/unregister
accepted arbitrarily long strings for the `token` and `user_id` fields.
Because the service layer passes these values directly to a parameterised SQL
INSERT/DELETE, a caller could store multi-megabyte strings in the database
(CWE-400: Uncontrolled Resource Consumption).

  - A real FCM registration token is ~163 characters.
  - A real APNs device token is ~100 hex characters.
  - Firebase UIDs are exactly 28 alphanumeric characters.

Fix: two module-level constants gate the values before they reach the service
layer or any log statement:

    _PUSH_TOKEN_MAX_LEN = 4096   # generous ceiling above any real-world token
    _USER_ID_MAX_LEN    = 128    # generous ceiling above any Firebase UID

Requests that exceed these limits receive HTTP 422.

Tests cover:
- Oversized token on /register returns 422
- Oversized user_id on /register returns 422
- Oversized user_id on /unregister returns 422
- Nominal-size token and user_id are not rejected by the length checks
- Constant values are within reasonable bounds
- Code-level guard: constants exist in the module
"""

from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# Constant-level checks (no network / DB required)
# ---------------------------------------------------------------------------
import api.routes.notifications as _notif_module


def test_push_token_max_len_constant_exists():
    """_PUSH_TOKEN_MAX_LEN must be defined on the module."""
    assert hasattr(_notif_module, "_PUSH_TOKEN_MAX_LEN"), (
        "_PUSH_TOKEN_MAX_LEN constant is missing from api/routes/notifications.py"
    )


def test_user_id_max_len_constant_exists():
    """_USER_ID_MAX_LEN must be defined on the module."""
    assert hasattr(_notif_module, "_USER_ID_MAX_LEN"), (
        "_USER_ID_MAX_LEN constant is missing from api/routes/notifications.py"
    )


def test_push_token_max_len_is_above_real_world_max():
    """Token limit must be at least 500 chars (all real FCM/APNs tokens are shorter)."""
    assert _notif_module._PUSH_TOKEN_MAX_LEN >= 500, (
        f"_PUSH_TOKEN_MAX_LEN={_notif_module._PUSH_TOKEN_MAX_LEN} is too small; "
        "real FCM tokens can be ~163 chars"
    )


def test_push_token_max_len_is_not_absurdly_large():
    """Token limit must be at most 65536 chars to actually prevent DoS."""
    assert _notif_module._PUSH_TOKEN_MAX_LEN <= 65536, (
        f"_PUSH_TOKEN_MAX_LEN={_notif_module._PUSH_TOKEN_MAX_LEN} offers no meaningful DoS protection"
    )


def test_user_id_max_len_is_above_firebase_uid_length():
    """User ID limit must accommodate Firebase UIDs (28 chars)."""
    assert _notif_module._USER_ID_MAX_LEN >= 28, (
        f"_USER_ID_MAX_LEN={_notif_module._USER_ID_MAX_LEN} would reject legitimate Firebase UIDs"
    )


def test_user_id_max_len_is_not_absurdly_large():
    """User ID limit must be at most 1024 chars."""
    assert _notif_module._USER_ID_MAX_LEN <= 1024, (
        f"_USER_ID_MAX_LEN={_notif_module._USER_ID_MAX_LEN} offers no meaningful protection"
    )


# ---------------------------------------------------------------------------
# HTTP-layer tests (TestClient)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client():
    """
    TestClient with Firebase auth stubbed so the route handler is reached.
    The stub always returns the same uid that callers send as user_id,
    ensuring the uid-match check passes and we reach the length-validation code.
    """
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    import api.routes.notifications as notif_mod
    from server import app

    def _stub_verify(auth_header: str | None) -> str:  # noqa: ARG001
        return "firebase_uid_stub_28chars_abc"

    with patch.object(notif_mod, "verify_firebase_bearer", side_effect=_stub_verify):
        yield TestClient(app, raise_server_exceptions=False)


_STUB_UID = "firebase_uid_stub_28chars_abc"


def test_register_oversized_token_returns_422(client):
    """POST /api/notifications/register must return 422 for a token that exceeds _PUSH_TOKEN_MAX_LEN."""
    oversized_token = "t" * (_notif_module._PUSH_TOKEN_MAX_LEN + 1)
    resp = client.post(
        "/api/notifications/register",
        json={"user_id": _STUB_UID, "token": oversized_token, "platform": "web"},
        headers={"Authorization": "Bearer stub"},
    )
    assert resp.status_code == 422, (
        f"Expected 422 for oversized token, got {resp.status_code}"
    )


def test_register_oversized_user_id_returns_422(client):
    """POST /api/notifications/register must return 422 for a user_id that exceeds _USER_ID_MAX_LEN."""
    oversized_uid = "u" * (_notif_module._USER_ID_MAX_LEN + 1)
    resp = client.post(
        "/api/notifications/register",
        json={"user_id": oversized_uid, "token": "valid_token_abc123", "platform": "web"},
        headers={"Authorization": "Bearer stub"},
    )
    assert resp.status_code == 422, (
        f"Expected 422 for oversized user_id, got {resp.status_code}"
    )


def test_unregister_oversized_user_id_returns_422(client):
    """DELETE /api/notifications/unregister must return 422 for a user_id that exceeds _USER_ID_MAX_LEN."""
    oversized_uid = "u" * (_notif_module._USER_ID_MAX_LEN + 1)
    resp = client.request(
        "DELETE",
        "/api/notifications/unregister",
        json={"user_id": oversized_uid},
        headers={"Authorization": "Bearer stub"},
    )
    assert resp.status_code == 422, (
        f"Expected 422 for oversized user_id on unregister, got {resp.status_code}"
    )


def test_register_nominal_payload_not_rejected_by_length_check(client):
    """
    POST /api/notifications/register with valid-length fields must NOT return 422
    due to our length checks (it may fail for other business-logic reasons).
    """
    resp = client.post(
        "/api/notifications/register",
        json={
            "user_id": _STUB_UID,
            "token": "APA91bH" + "x" * 150,  # realistic FCM-length token
            "platform": "android",
        },
        headers={"Authorization": "Bearer stub"},
    )
    assert resp.status_code != 422, (
        f"Nominal-length payload was incorrectly rejected with 422: {resp.json()}"
    )
