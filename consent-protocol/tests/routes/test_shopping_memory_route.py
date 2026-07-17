"""Hermetic unit tests for api/routes/kai/shopping_memory.py.

All tests run without DB, network, or LLM.
Covers the consent validation, user-ID binding, and error boundary logic
of POST /api/consent/shopping-memory.
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai.shopping_memory import router

# ---------------------------------------------------------------------------
# App fixture
# ---------------------------------------------------------------------------

app = FastAPI()
app.include_router(router, prefix="/api")
client = TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Token helpers (no DB — pure HMAC)
# ---------------------------------------------------------------------------


def _make_token(
    user_id: str = "user_abc",
    scope: str = "attr.shopping.*",
    agent_id: str = "mcp",
    ttl_ms: int = 3_600_000,
) -> str:
    """Issue a real HMAC-signed token via the production code path."""
    from hushh_mcp.consent.token import issue_token

    tok = issue_token(user_id=user_id, agent_id=agent_id, scope=scope, expires_in_ms=ttl_ms)
    return tok.token


def _expired_token(user_id: str = "user_abc") -> str:
    return _make_token(user_id=user_id, ttl_ms=-1_000)


# ---------------------------------------------------------------------------
# Shared mock for get_receipt_memory_preview_service
# ---------------------------------------------------------------------------

_PREVIEW_STUB = {
    "merchant_affinity": [{"merchant_id": "amazon", "label": "Amazon", "order_count": 12}],
    "purchase_patterns": [],
    "recent_highlights": [],
    "top_currency_summary": {"currency": "USD", "total": 499.99},
    "watermark": {"receipt_count": 20, "schema_version": 1},
}


def _patch_service(preview=None, *, raise_exc=None):
    """Return a context-manager that patches get_receipt_memory_preview_service."""
    svc = MagicMock()
    if raise_exc is not None:
        svc.build_preview = AsyncMock(side_effect=raise_exc)
    else:
        svc.build_preview = AsyncMock(return_value=preview or _PREVIEW_STUB)

    return patch(
        "api.routes.kai.shopping_memory.get_receipt_memory_preview_service",
        return_value=svc,
    )


def _patch_db_ok(user_id: str = "user_abc", scope: str = "attr.shopping.*"):
    """Patch validate_token_with_db to approve without touching the DB."""
    from hushh_mcp.consent.token import HushhConsentToken, _scope_str_to_enum

    tok = HushhConsentToken(
        token="stub_tok",  # noqa: S106
        user_id=user_id,
        agent_id="mcp",
        scope=_scope_str_to_enum(scope),
        scope_str=scope,
        issued_at=int(time.time() * 1000),
        expires_at=int(time.time() * 1000) + 3_600_000,
        signature="stub_sig",
    )
    return patch(
        "api.routes.kai.shopping_memory.validate_token_with_db",
        new=AsyncMock(return_value=(True, None, tok)),
    )


def _patch_db_denied(reason: str = "Token expired"):
    return patch(
        "api.routes.kai.shopping_memory.validate_token_with_db",
        new=AsyncMock(return_value=(False, reason, None)),
    )


# ---------------------------------------------------------------------------
# Happy-path tests
# ---------------------------------------------------------------------------


class TestShoppingMemoryHappyPath:
    def test_returns_200_with_valid_token(self):
        with _patch_db_ok(), _patch_service():
            resp = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            )
        assert resp.status_code == 200

    def test_response_contains_merchant_affinity(self):
        with _patch_db_ok(), _patch_service():
            data = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            ).json()
        assert "merchant_affinity" in data

    def test_response_contains_watermark(self):
        with _patch_db_ok(), _patch_service():
            data = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            ).json()
        assert "watermark" in data

    def test_force_refresh_passed_to_service(self):
        mock_svc = MagicMock()
        mock_svc.build_preview = AsyncMock(return_value=_PREVIEW_STUB)
        with (
            _patch_db_ok(),
            patch(
                "api.routes.kai.shopping_memory.get_receipt_memory_preview_service",
                return_value=mock_svc,
            ),
        ):
            client.post(
                "/api/consent/shopping-memory",
                json={
                    "user_id": "user_abc",
                    "consent_token": _make_token(),
                    "force_refresh": True,
                },
            )
        mock_svc.build_preview.assert_awaited_once()
        call_kwargs = mock_svc.build_preview.call_args.kwargs
        assert call_kwargs.get("force_refresh") is True

    def test_inference_window_days_passed_to_service(self):
        mock_svc = MagicMock()
        mock_svc.build_preview = AsyncMock(return_value=_PREVIEW_STUB)
        with (
            _patch_db_ok(),
            patch(
                "api.routes.kai.shopping_memory.get_receipt_memory_preview_service",
                return_value=mock_svc,
            ),
        ):
            client.post(
                "/api/consent/shopping-memory",
                json={
                    "user_id": "user_abc",
                    "consent_token": _make_token(),
                    "inference_window_days": 180,
                },
            )
        call_kwargs = mock_svc.build_preview.call_args.kwargs
        assert call_kwargs.get("inference_window_days") == 180

    def test_highlights_window_days_passed_to_service(self):
        mock_svc = MagicMock()
        mock_svc.build_preview = AsyncMock(return_value=_PREVIEW_STUB)
        with (
            _patch_db_ok(),
            patch(
                "api.routes.kai.shopping_memory.get_receipt_memory_preview_service",
                return_value=mock_svc,
            ),
        ):
            client.post(
                "/api/consent/shopping-memory",
                json={
                    "user_id": "user_abc",
                    "consent_token": _make_token(),
                    "highlights_window_days": 45,
                },
            )
        call_kwargs = mock_svc.build_preview.call_args.kwargs
        assert call_kwargs.get("highlights_window_days") == 45

    def test_force_refresh_defaults_false(self):
        mock_svc = MagicMock()
        mock_svc.build_preview = AsyncMock(return_value=_PREVIEW_STUB)
        with (
            _patch_db_ok(),
            patch(
                "api.routes.kai.shopping_memory.get_receipt_memory_preview_service",
                return_value=mock_svc,
            ),
        ):
            client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            )
        call_kwargs = mock_svc.build_preview.call_args.kwargs
        assert call_kwargs.get("force_refresh") is False

    def test_user_id_forwarded_to_service(self):
        mock_svc = MagicMock()
        mock_svc.build_preview = AsyncMock(return_value=_PREVIEW_STUB)
        with (
            _patch_db_ok(user_id="uid_xyz"),
            patch(
                "api.routes.kai.shopping_memory.get_receipt_memory_preview_service",
                return_value=mock_svc,
            ),
        ):
            client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "uid_xyz", "consent_token": _make_token(user_id="uid_xyz")},
            )
        call_kwargs = mock_svc.build_preview.call_args.kwargs
        assert call_kwargs.get("user_id") == "uid_xyz"


# ---------------------------------------------------------------------------
# Consent validation failures → 403
# ---------------------------------------------------------------------------


class TestConsentValidationFailures:
    def test_expired_token_returns_403(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc", "consent_token": _expired_token()},
        )
        assert resp.status_code == 403

    def test_invalid_token_string_returns_403(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc", "consent_token": "not_a_real_token"},
        )
        assert resp.status_code == 403

    def test_wrong_scope_returns_403(self):
        # Token issued for financial, not shopping
        wrong_scope_token = _make_token(scope="attr.financial.*")
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc", "consent_token": wrong_scope_token},
        )
        assert resp.status_code == 403

    def test_403_body_contains_required_scope(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc", "consent_token": "bad_token"},
        )
        detail = resp.json().get("detail") or {}
        assert detail.get("required_scope") == "attr.shopping.*"

    def test_403_body_contains_remedy(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc", "consent_token": "bad_token"},
        )
        detail = resp.json().get("detail") or {}
        assert "remedy" in detail

    def test_403_body_contains_code(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc", "consent_token": "bad_token"},
        )
        detail = resp.json().get("detail") or {}
        assert detail.get("code") == "SHOPPING_MEMORY_ACCESS_DENIED"

    def test_db_denied_returns_403(self):
        with _patch_db_denied(reason="Token revoked"):
            resp = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            )
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# User-ID mismatch → 403
# ---------------------------------------------------------------------------


class TestUserIdMismatch:
    def test_mismatched_user_id_returns_403(self):
        # Token issued for user_A, request claims user_B
        with _patch_db_ok(user_id="user_A"):
            resp = client.post(
                "/api/consent/shopping-memory",
                json={
                    "user_id": "user_B",  # mismatch!
                    "consent_token": _make_token(user_id="user_A"),
                },
            )
        assert resp.status_code == 403

    def test_mismatch_detail_code(self):
        with _patch_db_ok(user_id="user_A"):
            resp = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_B", "consent_token": _make_token(user_id="user_A")},
            )
        detail = resp.json().get("detail") or {}
        assert detail.get("code") == "SHOPPING_MEMORY_USER_MISMATCH"

    def test_mismatch_detail_has_privacy_notice(self):
        with _patch_db_ok(user_id="user_A"):
            resp = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_B", "consent_token": _make_token(user_id="user_A")},
            )
        detail = resp.json().get("detail") or {}
        assert "privacy_notice" in detail


# ---------------------------------------------------------------------------
# Request validation (Pydantic schema)
# ---------------------------------------------------------------------------


class TestRequestValidation:
    def test_missing_user_id_returns_422(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"consent_token": _make_token()},
        )
        assert resp.status_code == 422

    def test_missing_consent_token_returns_422(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc"},
        )
        assert resp.status_code == 422

    def test_empty_user_id_returns_422(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "", "consent_token": _make_token()},
        )
        assert resp.status_code == 422

    def test_empty_consent_token_returns_422(self):
        resp = client.post(
            "/api/consent/shopping-memory",
            json={"user_id": "user_abc", "consent_token": ""},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Service errors → 503
# ---------------------------------------------------------------------------


class TestServiceErrors:
    def test_service_exception_returns_503(self):
        with _patch_db_ok(), _patch_service(raise_exc=RuntimeError("DB gone")):
            resp = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            )
        assert resp.status_code == 503

    def test_503_body_is_retryable(self):
        with _patch_db_ok(), _patch_service(raise_exc=Exception("timeout")):
            resp = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            )
        detail = resp.json().get("detail") or {}
        assert detail.get("retryable") is True

    def test_503_body_contains_code(self):
        with _patch_db_ok(), _patch_service(raise_exc=Exception("timeout")):
            resp = client.post(
                "/api/consent/shopping-memory",
                json={"user_id": "user_abc", "consent_token": _make_token()},
            )
        detail = resp.json().get("detail") or {}
        assert detail.get("code") == "SHOPPING_MEMORY_TEMPORARILY_UNAVAILABLE"
