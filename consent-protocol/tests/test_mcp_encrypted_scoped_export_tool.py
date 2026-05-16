from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from mcp_modules.tools import data_tools


@pytest.mark.asyncio
async def test_get_encrypted_scoped_export_returns_ciphertext_only(monkeypatch):
    async def _resolve(user_id: str, **kwargs) -> str:  # noqa: ANN003
        assert user_id == "user@example.com"
        return "user_123"

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        assert token == "token_123"  # noqa: S105
        assert expected_scope == "attr.financial.*"
        return (
            True,
            None,
            SimpleNamespace(
                user_id="user_123",
                scope_str="attr.financial.*",
                scope=SimpleNamespace(value="attr.financial.*"),
            ),
        )

    async def _fetch(*, user_id: str, consent_token: str, expected_scope: str | None):
        assert user_id == "user_123"
        assert consent_token == "token_123"  # noqa: S105
        assert expected_scope == "attr.financial.*"
        return {
            "status": "success",
            "granted_scope": "attr.financial.*",
            "coverage_kind": "exact",
            "expires_at": 123456789,
            "export_revision": 4,
            "export_generated_at": "2026-03-24T18:30:00Z",
            "export_refresh_status": "current",
            "encrypted_data": "ciphertext",
            "iv": "iv",
            "tag": "tag",
            "wrapped_key_bundle": {
                "wrapped_export_key": "wrapped",
                "wrapped_key_iv": "wrapped_iv",
                "wrapped_key_tag": "wrapped_tag",
                "sender_public_key": "sender_public_key",
                "wrapping_alg": "X25519-AES256-GCM",
                "connector_key_id": "connector_demo",
            },
        }

    monkeypatch.setattr(data_tools, "resolve_email_to_uid", _resolve)
    monkeypatch.setattr(data_tools, "validate_token_with_db", _validate)
    monkeypatch.setattr(data_tools, "_fetch_encrypted_export_package", _fetch)

    result = await data_tools.handle_get_encrypted_scoped_export(
        {
            "user_id": "user@example.com",
            "consent_token": "token_123",
            "expected_scope": "attr.financial.*",
        }
    )

    payload = json.loads(result[0].text)
    assert payload["status"] == "success"
    assert payload["user_id"] == "user_123"
    assert payload["scope"] == "attr.financial.*"
    assert payload["granted_scope"] == "attr.financial.*"
    assert payload["encrypted_data"] == "ciphertext"
    assert payload["wrapped_key_bundle"]["connector_key_id"] == "connector_demo"
    assert "data" not in payload


@pytest.mark.asyncio
async def test_get_encrypted_scoped_export_echoes_expected_scope_for_superset(monkeypatch):
    async def _resolve(user_id: str, **kwargs) -> str:  # noqa: ANN003
        assert user_id == "user@example.com"
        return "user_123"

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        assert token == "token_123"  # noqa: S105
        assert expected_scope == "attr.financial.analytics.quality_metrics"
        return (
            True,
            None,
            SimpleNamespace(
                user_id="user_123",
                scope_str="attr.financial.analytics.*",
                scope=SimpleNamespace(value="attr.financial.analytics.*"),
            ),
        )

    async def _fetch(*, user_id: str, consent_token: str, expected_scope: str | None):
        return {
            "status": "success",
            "granted_scope": "attr.financial.analytics.*",
            "coverage_kind": "superset",
            "expires_at": 123456789,
            "export_revision": 5,
            "export_generated_at": "2026-03-24T18:35:00Z",
            "export_refresh_status": "refresh_pending",
            "encrypted_data": "ciphertext",
            "iv": "iv",
            "tag": "tag",
            "wrapped_key_bundle": {
                "wrapped_export_key": "wrapped",
                "wrapped_key_iv": "wrapped_iv",
                "wrapped_key_tag": "wrapped_tag",
                "sender_public_key": "sender_public_key",
                "wrapping_alg": "X25519-AES256-GCM",
                "connector_key_id": "connector_demo",
            },
        }

    monkeypatch.setattr(data_tools, "resolve_email_to_uid", _resolve)
    monkeypatch.setattr(data_tools, "validate_token_with_db", _validate)
    monkeypatch.setattr(data_tools, "_fetch_encrypted_export_package", _fetch)

    result = await data_tools.handle_get_encrypted_scoped_export(
        {
            "user_id": "user@example.com",
            "consent_token": "token_123",
            "expected_scope": "attr.financial.analytics.quality_metrics",
        }
    )

    payload = json.loads(result[0].text)
    assert payload["status"] == "success"
    assert payload["scope"] == "attr.financial.analytics.*"
    assert payload["expected_scope"] == "attr.financial.analytics.quality_metrics"
    assert payload["coverage_kind"] == "superset"
    assert payload["export_refresh_status"] == "refresh_pending"
    assert payload["zero_knowledge"] is True


@pytest.mark.asyncio
async def test_get_encrypted_scoped_export_denies_invalid_token(monkeypatch):
    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        assert token == "invalid"  # noqa: S105
        return (False, "token revoked", None)

    monkeypatch.setattr(data_tools, "validate_token_with_db", _validate)

    result = await data_tools.handle_get_encrypted_scoped_export(
        {
            "user_id": "user_123",
            "consent_token": "invalid",
            "expected_scope": "attr.financial.*",
        }
    )

    payload = json.loads(result[0].text)
    assert payload["status"] == "access_denied"
    assert payload["required_scope"] == "attr.financial.*"
