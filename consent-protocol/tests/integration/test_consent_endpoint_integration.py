"""
Integration tests for lazy consent-export cache eviction through the live
request handler.

Canonical attach point:
    api.routes.consent.get_consent_export_data  ->  GET /api/consent/data

Why this is NOT a duplicate of tests/test_consent_exports_ttl_eviction.py:
    That suite is unit-level: it calls the module helper
    `_evict_stale_consent_exports()` directly and uses AST/monkeypatch guards to
    prove the helper is wired into the cache-write sites.

    These tests instead drive the *handler* end-to-end with a real FastAPI
    `TestClient`, proving the inline lazy-eviction branch in
    `get_consent_export_data` (lines that drop a stale `_consent_exports[token]`
    entry before falling through to the DB path) actually fires on a real
    request and does not leak the expired payload or raise an unhandled router
    exception.

Isolation:
    - Zero network sockets: FastAPI TestClient drives the ASGI app in-process.
    - `validate_token_with_db` (the DB-backed revocation check) is patched so no
      database connection is attempted for the auth gate.
    - `ConsentDBService.get_consent_export` is patched so the DB fallback path is
      deterministic and offline.
    - `_consent_exports` is cleared before and after each test for isolation.
"""

import time
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from api.routes.consent import (
    _CONSENT_EXPORT_TTL_MS,
    _consent_exports,
)
from server import app

EXPORT_PATH = "/api/consent/data"


def _entry(*, offset_ms: int, with_bundle: bool = True) -> dict:
    """Build a minimal cache entry with created_at = now + offset_ms."""
    entry = {
        "encrypted_data": b"ciphertext",
        "iv": b"iv",
        "tag": b"tag",
        "scope": "attr.financial.*",
        "export_revision": 1,
        "export_generated_at": "2024-01-01T00:00:00Z",
        "refresh_status": "current",
        "is_strict_zero_knowledge": True,
        "created_at": int(time.time() * 1000) + offset_ms,
    }
    if with_bundle:
        entry["wrapped_key_bundle"] = {"connector_key_id": "k1"}
    return entry


def _stale_entry() -> dict:
    return _entry(offset_ms=-(_CONSENT_EXPORT_TTL_MS + 1))


def _fresh_entry() -> dict:
    return _entry(offset_ms=0)


def _client() -> TestClient:
    # raise_server_exceptions=False so an unexpected 500 surfaces as a response
    # we can assert on, rather than bubbling out of the test as a raw exception.
    return TestClient(app, raise_server_exceptions=False)


class TestExportEndpointLazyEviction:
    """GET /api/consent/data must lazily drop a stale cache entry inline."""

    def test_stale_cache_entry_is_evicted_and_payload_not_leaked(self):
        """
        A cache entry older than the TTL must be removed by the handler's inline
        lazy-eviction branch, then fall through to the DB path (mocked empty),
        returning 404 — and the stale encrypted payload must NOT appear in the
        response body.
        """
        token = "tok_stale_integration"  # noqa: S105 - test fixture token id
        _consent_exports.clear()
        _consent_exports[token] = _stale_entry()

        with (
            patch(
                "api.routes.consent.validate_token_with_db",
                new=AsyncMock(return_value=(True, "ok", None)),
            ),
            patch(
                "hushh_mcp.services.consent_db.ConsentDBService.get_consent_export",
                new=AsyncMock(return_value=None),
            ),
        ):
            resp = _client().get(EXPORT_PATH, params={"consent_token": token})

        # DB fallback returns nothing for the expired token -> 404, not a 500.
        assert resp.status_code == 404, resp.text

        # The inline lazy-evict branch must have removed the stale entry.
        assert token not in _consent_exports, "Stale cache entry was not evicted by the handler"

        # The expired ciphertext must never be serialized back to the caller.
        assert "ciphertext" not in resp.text

        _consent_exports.clear()

    def test_fresh_cache_entry_is_served_and_preserved(self):
        """
        A non-expired cache entry must be served from cache (200) and must remain
        in the cache — proving the lazy-evict branch does not over-evict valid
        tokens.
        """
        token = "tok_fresh_integration"  # noqa: S105 - test fixture token id
        _consent_exports.clear()
        _consent_exports[token] = _fresh_entry()

        with (
            patch(
                "api.routes.consent.validate_token_with_db",
                new=AsyncMock(return_value=(True, "ok", None)),
            ),
            patch(
                "hushh_mcp.services.consent_db.ConsentDBService.get_consent_export",
                new=AsyncMock(return_value=None),
            ) as db_export,
        ):
            resp = _client().get(EXPORT_PATH, params={"consent_token": token})

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "success"
        assert body["scope"] == "attr.financial.*"

        # Fresh entry served from cache: DB fallback must not have been consulted.
        db_export.assert_not_awaited()
        # Fresh entry must survive — not evicted.
        assert token in _consent_exports

        _consent_exports.clear()

    def test_invalid_token_is_rejected_before_cache_lookup(self):
        """
        When token validation fails the handler must return 401 and must not
        touch / serve any cache entry for that token.
        """
        token = "tok_invalid_integration"  # noqa: S105 - test fixture token id
        _consent_exports.clear()
        _consent_exports[token] = _fresh_entry()

        with patch(
            "api.routes.consent.validate_token_with_db",
            new=AsyncMock(return_value=(False, "revoked", None)),
        ):
            resp = _client().get(EXPORT_PATH, params={"consent_token": token})

        assert resp.status_code == 401, resp.text
        assert "ciphertext" not in resp.text

        _consent_exports.clear()
