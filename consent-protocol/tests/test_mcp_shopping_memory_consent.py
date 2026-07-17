"""Consent-gate proof tests for the get_shopping_memory MCP tool.

Canonical attach point: ``mcp_modules/tools/data_tools.handle_get_shopping_memory``
is invoked by ``mcp_server.py`` via the ``get_shopping_memory`` tool dispatch in
``mcp_modules/tools/__init__.py``. The upstream backend endpoint is
``POST /api/consent/shopping-memory`` (``api/routes/kai/shopping_memory.py``).

These tests assert the trust boundary contract for the shopping-memory tool:
  - A missing consent token is rejected before any data is fetched.
  - A token scoped to a different domain (wrong scope) is rejected.
  - A correctly scoped ``attr.shopping.*`` token allows data through.

All tests run without DB, network, Firebase, or LLM access.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from mcp_modules.tools import data_tools

# ---------------------------------------------------------------------------
# Shared stubs
# ---------------------------------------------------------------------------

_USER_UID = "uid_shopping_test_user"
_SHOPPING_TOKEN = "HCT:fake-shopping-token-for-testing"  # noqa: S105 (not a real secret)
_WRONG_SCOPE_TOKEN = "HCT:fake-financial-token-for-testing"  # noqa: S105

_PREVIEW_DATA = {
    "merchant_affinity": [{"merchant_id": "amazon", "label": "Amazon", "order_count": 5}],
    "purchase_patterns": [],
    "recent_highlights": [],
    "top_currency_summary": {"currency": "USD", "total": 250.00},
    "watermark": {"receipt_count": 10, "schema_version": 1},
}


def _make_resolve_stub(uid: str | None = _USER_UID):
    """Return an async callable that mimics resolve_email_to_uid."""

    async def _resolve(user_id: str, **kwargs):  # noqa: ANN003
        return uid, "test@example.com", "Test User"

    return _resolve


def _make_validate_stub(valid: bool, reason: str | None = None, scope: str = "attr.shopping.*"):
    """Return an async callable that mimics validate_token_with_db."""

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        tok_obj = SimpleNamespace(user_id=_USER_UID, scope_str=scope)
        return (valid, reason or ("ok" if valid else "rejected"), tok_obj)

    return _validate


def _make_wrong_scope_validate_stub():
    """Token is valid HMAC-wise but carries the wrong scope -- validation rejects it."""

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        return (
            False,
            f"scope mismatch: token scope 'attr.financial.*' does not satisfy '{expected_scope}'",
            None,
        )

    return _validate


def _make_http_stub(data: dict):
    """Return a context manager stub that mimics httpx.AsyncClient returning data."""

    class _FakeResp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return data

    class _FakeClient:
        def __init__(self, **kwargs):  # noqa: ANN003
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def post(self, *args, **kwargs):  # noqa: ANN002, ANN003
            return _FakeResp()

    return _FakeClient


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------


class TestShoppingMemoryConsentGate:
    """Proves that the get_shopping_memory tool enforces its consent boundary.

    Canonical attach point: ``mcp_modules.tools.data_tools.handle_get_shopping_memory``
    called from ``mcp_server.py`` tool dispatch.

    Trust boundary contract:
    1. Missing (None) consent token must be rejected before any backend I/O.
    2. A token with a wrong/insufficient scope is rejected with ``access_denied``.
    3. A token correctly scoped to ``attr.shopping.*`` returns ``status=success``.
    """

    @pytest.mark.asyncio
    async def test_missing_consent_token_returns_access_denied(self, monkeypatch):
        """Passing no consent_token must yield access_denied before the resolver is called."""
        resolve_call_count = []

        async def _tracking_resolve(user_id: str, **kwargs):  # noqa: ANN003
            resolve_call_count.append(user_id)
            return _USER_UID, "test@example.com", "Test User"

        monkeypatch.setattr(
            "mcp_modules.tools.consent_tools.resolve_email_to_uid",
            _tracking_resolve,
        )

        async def _reject_none(token, expected_scope=None):  # noqa: ANN001
            return (False, "token is None or missing", None)

        monkeypatch.setattr(data_tools, "validate_token_with_db", _reject_none)

        with patch("mcp_modules.tools.data_tools.get_developer_request_query", return_value={}):
            result = await data_tools.handle_get_shopping_memory(
                {
                    "user_id": _USER_UID,
                    "consent_token": None,
                }
            )

        payload = json.loads(result[0].text)
        assert payload["status"] == "access_denied"
        assert "required_scope" in payload
        assert payload["required_scope"] == "attr.shopping.*"
        assert len(resolve_call_count) == 0, (
            "Identifier resolver must not be called before consent validation"
        )

    @pytest.mark.asyncio
    async def test_wrong_scope_token_returns_access_denied(self, monkeypatch):
        """A wrong-scope token must be rejected before the resolver is called."""
        resolve_call_count = []

        async def _tracking_resolve(user_id: str, **kwargs):  # noqa: ANN003
            resolve_call_count.append(user_id)
            return _USER_UID, "test@example.com", "Test User"

        monkeypatch.setattr(
            "mcp_modules.tools.consent_tools.resolve_email_to_uid",
            _tracking_resolve,
        )
        monkeypatch.setattr(data_tools, "validate_token_with_db", _make_wrong_scope_validate_stub())

        with patch("mcp_modules.tools.data_tools.get_developer_request_query", return_value={}):
            result = await data_tools.handle_get_shopping_memory(
                {
                    "user_id": _USER_UID,
                    "consent_token": _WRONG_SCOPE_TOKEN,
                }
            )

        payload = json.loads(result[0].text)
        assert payload["status"] == "access_denied"
        assert "scope mismatch" in payload.get("error", "").lower() or "consent" in payload.get(
            "error", ""
        ).lower()
        assert payload.get("required_scope") == "attr.shopping.*"
        assert len(resolve_call_count) == 0, (
            "Identifier resolver must not be called before consent validation"
        )

    @pytest.mark.asyncio
    async def test_correct_scope_token_returns_data(self, monkeypatch):
        """A token scoped to attr.shopping.* must flow through to the backend and return data."""
        monkeypatch.setattr(
            "mcp_modules.tools.consent_tools.resolve_email_to_uid",
            _make_resolve_stub(),
        )
        monkeypatch.setattr(
            data_tools,
            "validate_token_with_db",
            _make_validate_stub(valid=True, scope="attr.shopping.*"),
        )

        with (
            patch("mcp_modules.tools.data_tools.get_developer_request_query", return_value={}),
            patch("httpx.AsyncClient", _make_http_stub(_PREVIEW_DATA)),
        ):
            result = await data_tools.handle_get_shopping_memory(
                {
                    "user_id": _USER_UID,
                    "consent_token": _SHOPPING_TOKEN,
                }
            )

        payload = json.loads(result[0].text)
        assert payload["status"] == "success"
        assert payload["user_id"] == _USER_UID
        assert payload["scope"] == "attr.shopping.*"
        assert payload["consent_verified"] is True
        assert "data" in payload
        assert payload["data"]["merchant_affinity"][0]["merchant_id"] == "amazon"

    @pytest.mark.asyncio
    async def test_user_id_mismatch_returns_access_denied(self, monkeypatch):
        """A valid shopping token belonging to a different user must be rejected."""
        # Resolve to uid_OTHER but token encodes _USER_UID
        async def _resolve_other(user_id: str, **kwargs):  # noqa: ANN003
            return "uid_OTHER", "other@example.com", "Other User"

        monkeypatch.setattr(
            "mcp_modules.tools.consent_tools.resolve_email_to_uid",
            _resolve_other,
        )

        # Token is valid but bound to _USER_UID, not uid_OTHER
        async def _validate_different_uid(token, expected_scope=None):  # noqa: ANN001
            tok_obj = SimpleNamespace(user_id=_USER_UID, scope_str="attr.shopping.*")
            return (True, "ok", tok_obj)

        monkeypatch.setattr(data_tools, "validate_token_with_db", _validate_different_uid)

        with patch("mcp_modules.tools.data_tools.get_developer_request_query", return_value={}):
            result = await data_tools.handle_get_shopping_memory(
                {
                    "user_id": "uid_OTHER",
                    "consent_token": _SHOPPING_TOKEN,
                }
            )

        payload = json.loads(result[0].text)
        assert payload["status"] == "access_denied"
        assert "does not match" in payload.get("error", "").lower()

    @pytest.mark.asyncio
    async def test_unresolvable_identifier_with_valid_token_returns_access_denied(
        self, monkeypatch
    ):
        """An email that does not resolve to any UID must yield access_denied, not user_not_found.

        Returning user_not_found would let an unauthenticated caller discover whether an
        email address is registered. With the consent-first order, this branch is only
        reached after a valid token is presented, and a generic access_denied is returned
        so no account existence is leaked.
        """

        async def _resolve_none(user_id: str, **kwargs):  # noqa: ANN003
            return None, None, None

        monkeypatch.setattr(
            "mcp_modules.tools.consent_tools.resolve_email_to_uid",
            _resolve_none,
        )
        monkeypatch.setattr(
            data_tools,
            "validate_token_with_db",
            _make_validate_stub(valid=True, scope="attr.shopping.*"),
        )

        with patch("mcp_modules.tools.data_tools.get_developer_request_query", return_value={}):
            result = await data_tools.handle_get_shopping_memory(
                {
                    "user_id": "nonexistent@example.com",
                    "consent_token": _SHOPPING_TOKEN,
                }
            )

        payload = json.loads(result[0].text)
        assert payload["status"] == "access_denied", (
            "Unresolvable identifier must return access_denied, not user_not_found, "
            "to prevent account enumeration"
        )

    @pytest.mark.asyncio
    async def test_scope_isolation_shopping_does_not_expose_financial_data(self, monkeypatch):
        """Data returned under attr.shopping.* scope must not contain raw financial fields."""
        monkeypatch.setattr(
            "mcp_modules.tools.consent_tools.resolve_email_to_uid",
            _make_resolve_stub(),
        )
        monkeypatch.setattr(
            data_tools,
            "validate_token_with_db",
            _make_validate_stub(valid=True, scope="attr.shopping.*"),
        )

        with (
            patch("mcp_modules.tools.data_tools.get_developer_request_query", return_value={}),
            patch("httpx.AsyncClient", _make_http_stub(_PREVIEW_DATA)),
        ):
            result = await data_tools.handle_get_shopping_memory(
                {
                    "user_id": _USER_UID,
                    "consent_token": _SHOPPING_TOKEN,
                }
            )

        payload = json.loads(result[0].text)
        assert payload["status"] == "success"
        # Shopping projection must not include raw financial fields
        data = payload.get("data", {})
        forbidden = {"portfolio", "holdings", "account_number", "routing_number", "export_key"}
        assert not forbidden.intersection(set(data.keys())), (
            f"Shopping projection exposed forbidden financial keys: {forbidden.intersection(set(data.keys()))}"
        )
