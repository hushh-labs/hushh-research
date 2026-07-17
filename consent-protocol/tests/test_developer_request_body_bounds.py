# tests/test_developer_request_body_bounds.py
"""
Regression tests for CWE-400 / CWE-209 fixes in api/routes/developer.py.

CWE-400: DeveloperConsentRequest and DeveloperScopedExportRequest previously had
no max_length on several string fields (user_id, scope, reason, connector_public_key,
consent_token, expected_scope), allowing arbitrarily large payloads to reach the
DB and crypto layers.

CWE-209: POST /api/v1/request-consent echoed the caller-supplied scope value in
the "INVALID_SCOPE" error message; replaced with a static opaque string.

Attach points:
  POST /api/v1/request-consent   DeveloperConsentRequest
  POST /api/v1/scoped-export     DeveloperScopedExportRequest
"""

from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.routes.developer import DeveloperConsentRequest, DeveloperScopedExportRequest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GOOD_USER_ID = "firebase_uid_stub_28chars_abc"
_GOOD_SCOPE = "pkm.read"
_GOOD_KEY = "A" * 64   # 64-char base64 blob, valid pubkey placeholder
_GOOD_TOKEN = "tok_" + "x" * 32


def _stub_principal(**_kwargs):
    """Minimal DeveloperPrincipal-like stub."""
    p = MagicMock()
    p.app_id = "test_app_id"
    p.app_display_name = "Test App"
    return p


@contextmanager
def _dev_client():
    """Mount only developer.router on a minimal FastAPI app so the MCP
    session-manager lifespan (single-start-per-process) is never touched.

    authenticate_developer_principal is called directly inside the route
    handlers rather than via Depends(), so it must be patched at the
    module level instead of through app.dependency_overrides.
    """
    import api.routes.developer as developer_mod

    app = FastAPI()
    app.include_router(developer_mod.router)

    with patch.object(developer_mod, "authenticate_developer_principal", side_effect=_stub_principal):
        with patch.object(
            developer_mod, "try_authenticate_developer_principal", side_effect=_stub_principal
        ):
            yield TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Model-level ValidationError tests (no HTTP layer needed)
# ---------------------------------------------------------------------------

def test_consent_request_rejects_oversized_user_id():
    with pytest.raises(ValidationError):
        DeveloperConsentRequest(
            user_id="u" * 129,
            scope=_GOOD_SCOPE,
            connector_public_key=_GOOD_KEY,
            connector_key_id="kid_1",
            connector_wrapping_alg="RSA-OAEP",
        )


def test_consent_request_rejects_oversized_scope():
    with pytest.raises(ValidationError):
        DeveloperConsentRequest(
            user_id=_GOOD_USER_ID,
            scope="s" * 513,
            connector_public_key=_GOOD_KEY,
            connector_key_id="kid_1",
            connector_wrapping_alg="RSA-OAEP",
        )


def test_consent_request_rejects_oversized_reason():
    with pytest.raises(ValidationError):
        DeveloperConsentRequest(
            user_id=_GOOD_USER_ID,
            scope=_GOOD_SCOPE,
            reason="r" * 2049,
            connector_public_key=_GOOD_KEY,
            connector_key_id="kid_1",
            connector_wrapping_alg="RSA-OAEP",
        )


def test_consent_request_rejects_oversized_connector_public_key():
    with pytest.raises(ValidationError):
        DeveloperConsentRequest(
            user_id=_GOOD_USER_ID,
            scope=_GOOD_SCOPE,
            connector_public_key="K" * 8193,  # exceeds max_length=8192
            connector_key_id="kid_1",
            connector_wrapping_alg="RSA-OAEP",
        )


def test_consent_request_accepts_valid_payload():
    # Should NOT raise; confirms our bounds are not too strict
    req = DeveloperConsentRequest(
        user_id=_GOOD_USER_ID,
        scope=_GOOD_SCOPE,
        connector_public_key=_GOOD_KEY,
        connector_key_id="kid_1",
        connector_wrapping_alg="RSA-OAEP",
    )
    assert req.user_id == _GOOD_USER_ID


def test_scoped_export_request_rejects_oversized_user_id():
    with pytest.raises(ValidationError):
        DeveloperScopedExportRequest(
            user_id="u" * 129,
            consent_token=_GOOD_TOKEN,
        )


def test_scoped_export_request_rejects_oversized_consent_token():
    with pytest.raises(ValidationError):
        DeveloperScopedExportRequest(
            user_id=_GOOD_USER_ID,
            consent_token="t" * 2049,  # exceeds max_length=2048
        )


def test_scoped_export_request_rejects_oversized_expected_scope():
    with pytest.raises(ValidationError):
        DeveloperScopedExportRequest(
            user_id=_GOOD_USER_ID,
            consent_token=_GOOD_TOKEN,
            expected_scope="s" * 513,
        )


def test_scoped_export_request_accepts_valid_payload():
    req = DeveloperScopedExportRequest(
        user_id=_GOOD_USER_ID,
        consent_token=_GOOD_TOKEN,
        expected_scope=_GOOD_SCOPE,
    )
    assert req.consent_token == _GOOD_TOKEN


# ---------------------------------------------------------------------------
# HTTP-level tests via TestClient
# ---------------------------------------------------------------------------

def test_request_consent_http_rejects_oversized_scope():
    with _dev_client() as client:
        r = client.post(
            "/api/v1/request-consent",
            json={
                "user_id": _GOOD_USER_ID,
                "scope": "s" * 513,
                "connector_public_key": _GOOD_KEY,
                "connector_key_id": "kid_1",
                "connector_wrapping_alg": "RSA-OAEP",
            },
        )
        assert r.status_code == 422, r.text


def test_request_consent_http_rejects_oversized_user_id():
    with _dev_client() as client:
        r = client.post(
            "/api/v1/request-consent",
            json={
                "user_id": "u" * 129,
                "scope": _GOOD_SCOPE,
                "connector_public_key": _GOOD_KEY,
                "connector_key_id": "kid_1",
                "connector_wrapping_alg": "RSA-OAEP",
            },
        )
        assert r.status_code == 422, r.text


def test_scoped_export_http_rejects_oversized_consent_token():
    with _dev_client() as client:
        r = client.post(
            "/api/v1/scoped-export",
            json={
                "user_id": _GOOD_USER_ID,
                "consent_token": "t" * 2049,
            },
        )
        assert r.status_code == 422, r.text


# ---------------------------------------------------------------------------
# CWE-209: invalid scope error must NOT echo back user-supplied scope value
# ---------------------------------------------------------------------------

def test_invalid_scope_error_does_not_echo_scope_value():
    """
    When an unsupported scope is submitted, the error message must not
    contain the caller-supplied scope string (CWE-209).
    """
    sentinel = "SENTINEL_SCOPE_xyzzy_12345"
    with _dev_client() as client:
        r = client.post(
            "/api/v1/request-consent",
            json={
                "user_id": _GOOD_USER_ID,
                "scope": sentinel,
                "connector_public_key": _GOOD_KEY,
                "connector_key_id": "kid_1",
                "connector_wrapping_alg": "RSA-OAEP",
            },
        )
        # 400 = unsupported scope (or 422 = validation; either way sentinel not in body)
        assert r.status_code in (400, 422), r.text
        assert sentinel not in r.text, (
            f"CWE-209: error response echoes caller-supplied scope: {r.text!r}"
        )
