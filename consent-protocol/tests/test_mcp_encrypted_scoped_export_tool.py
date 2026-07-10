from __future__ import annotations

import base64
import json
import os
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


def _wire_success(monkeypatch, *, encrypted_data: str) -> None:
    async def _resolve(user_id: str, **kwargs) -> str:  # noqa: ANN003
        return "user_123"

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
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
        return {
            "status": "success",
            "granted_scope": "attr.financial.*",
            "coverage_kind": "exact",
            "expires_at": 123456789,
            "export_revision": 4,
            "export_generated_at": "2026-03-24T18:30:00Z",
            "export_refresh_status": "current",
            "encrypted_data": encrypted_data,
            "iv": "iv",
            "tag": "tag",
            "wrapped_key_bundle": {"wrapped_export_key": "wrapped"},
        }

    monkeypatch.setattr(data_tools, "resolve_email_to_uid", _resolve)
    monkeypatch.setattr(data_tools, "validate_token_with_db", _validate)
    monkeypatch.setattr(data_tools, "_fetch_encrypted_export_package", _fetch)


@pytest.mark.asyncio
async def test_small_export_inlines_and_still_offers_download(monkeypatch):
    _wire_success(monkeypatch, encrypted_data="small_ciphertext")

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123"}
    )

    payload = json.loads(result[0].text)
    assert payload["delivery"] == "inline"
    assert payload["encrypted_data"] == "small_ciphertext"
    download = payload["download"]
    assert download["url"].endswith("/api/v1/scoped-export/download")
    assert download["method"] == "POST"
    assert download["json_body"] == {"user_id": "user_123", "consent_token": "token_123"}
    # The developer token must never be echoed into model context.
    assert "hdk_" not in result[0].text


@pytest.mark.asyncio
async def test_large_export_omits_inline_blob_and_directs_to_download(monkeypatch):
    big_blob = "A" * (data_tools.INLINE_EXPORT_MAX_BASE64_CHARS + 1)
    _wire_success(monkeypatch, encrypted_data=big_blob)

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123"}
    )

    payload = json.loads(result[0].text)
    assert payload["delivery"] == "download"
    assert payload["encrypted_data"] is None
    assert "delivery_note" in payload
    # Metadata needed for decryption still rides inline.
    assert payload["iv"] == "iv"
    assert payload["tag"] == "tag"
    assert payload["wrapped_key_bundle"] == {"wrapped_export_key": "wrapped"}
    # The tool result must be dramatically smaller than the blob itself.
    assert len(result[0].text) < len(big_blob)
    # Sandboxed connectors get an explicit escape hatch pointer.
    assert "delivery='inline'" in payload["delivery_note"]
    assert "if_unreachable" in payload["download"]


@pytest.mark.asyncio
async def test_forced_inline_delivery_returns_large_blob(monkeypatch):
    """delivery='inline' is the escape hatch for sandboxes that cannot reach
    the download endpoint (egress allowlists, localhost-only backends)."""
    big_blob = "A" * (data_tools.INLINE_EXPORT_MAX_BASE64_CHARS + 1)
    _wire_success(monkeypatch, encrypted_data=big_blob)

    result = await data_tools.handle_get_encrypted_scoped_export(
        {
            "user_id": "user@example.com",
            "consent_token": "token_123",
            "delivery": "inline",
        }
    )

    payload = json.loads(result[0].text)
    assert payload["delivery"] == "inline"
    assert payload["encrypted_data"] == big_blob
    assert "one step" in payload["delivery_note"].lower()


# ---------------------------------------------------------------------------
# Local stdio auto-decrypt (transport-gated default behavior)
# ---------------------------------------------------------------------------


def _real_encrypted_export(payload: dict, *, connector_public_key) -> dict:
    """Build a genuinely decryptable export package for local-decrypt tests."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    export_key = os.urandom(32)
    export_iv = os.urandom(12)
    export_ciphertext = AESGCM(export_key).encrypt(export_iv, plaintext, None)

    sender_private = X25519PrivateKey.generate()
    shared_secret = sender_private.exchange(connector_public_key)
    digest = hashes.Hash(hashes.SHA256())
    digest.update(shared_secret)
    wrapping_key = digest.finalize()
    wrapped_iv = os.urandom(12)
    wrapped = AESGCM(wrapping_key).encrypt(wrapped_iv, export_key, None)
    sender_public_key = sender_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )

    return {
        "status": "success",
        "granted_scope": "attr.financial.*",
        "coverage_kind": "exact",
        "expires_at": 123456789,
        "export_revision": 4,
        "export_generated_at": "2026-03-24T18:30:00Z",
        "export_refresh_status": "current",
        "encrypted_data": _b64(export_ciphertext[:-16]),
        "iv": _b64(export_iv),
        "tag": _b64(export_ciphertext[-16:]),
        "wrapped_key_bundle": {
            "wrapped_export_key": _b64(wrapped[:-16]),
            "wrapped_key_iv": _b64(wrapped_iv),
            "wrapped_key_tag": _b64(wrapped[-16:]),
            "sender_public_key": _b64(sender_public_key),
            "wrapping_alg": "X25519-AES256-GCM",
        },
    }


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("utf-8")


def _wire_local_stdio_success(monkeypatch, *, export_payload: dict) -> None:
    async def _resolve(user_id: str, **kwargs) -> str:  # noqa: ANN003
        return "user_123"

    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
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
        return export_payload

    monkeypatch.setattr(data_tools, "resolve_email_to_uid", _resolve)
    monkeypatch.setattr(data_tools, "validate_token_with_db", _validate)
    monkeypatch.setattr(data_tools, "_fetch_encrypted_export_package", _fetch)
    monkeypatch.setattr(data_tools, "is_local_stdio_transport", lambda: True)


@pytest.mark.asyncio
async def test_local_stdio_default_returns_decrypted_data_and_omits_ciphertext(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    local_private = X25519PrivateKey.generate()
    plaintext_payload = {"financial": {"net_worth": 1656064.53}}
    export_payload = _real_encrypted_export(
        plaintext_payload, connector_public_key=local_private.public_key()
    )
    _wire_local_stdio_success(monkeypatch, export_payload=export_payload)

    local_keypair = SimpleNamespace(private_key=local_private)
    monkeypatch.setattr(data_tools, "get_or_create_local_connector_keypair", lambda: local_keypair)

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123"}
    )

    payload = json.loads(result[0].text)
    assert payload["status"] == "success"
    assert payload["delivery"] == "decrypted_local"
    assert payload["decrypted"] is True
    assert payload["data"] == plaintext_payload
    assert "encrypted_data" not in payload
    assert "wrapped_key_bundle" not in payload
    assert "iv" not in payload
    assert "tag" not in payload


@pytest.mark.asyncio
async def test_local_stdio_raw_true_opts_out_of_decryption(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    local_private = X25519PrivateKey.generate()
    plaintext_payload = {"financial": {"net_worth": 1656064.53}}
    export_payload = _real_encrypted_export(
        plaintext_payload, connector_public_key=local_private.public_key()
    )
    _wire_local_stdio_success(monkeypatch, export_payload=export_payload)
    monkeypatch.setattr(
        data_tools,
        "get_or_create_local_connector_keypair",
        lambda: (_ for _ in ()).throw(AssertionError("should not be called when raw=true")),
    )

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123", "raw": True}
    )

    payload = json.loads(result[0].text)
    assert payload["delivery"] == "inline"
    assert payload["encrypted_data"] == export_payload["encrypted_data"]
    assert payload["wrapped_key_bundle"] == export_payload["wrapped_key_bundle"]
    assert "data" not in payload


@pytest.mark.asyncio
async def test_remote_transport_unaffected_by_local_decrypt_default(monkeypatch):
    """is_local_stdio_transport() defaults to False; remote/hosted behavior
    must stay byte-for-byte identical to the pre-existing raw contract."""
    _wire_success(monkeypatch, encrypted_data="small_ciphertext")
    # Explicitly confirm the default (no monkeypatch of is_local_stdio_transport).
    assert data_tools.is_local_stdio_transport() is False

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123"}
    )

    payload = json.loads(result[0].text)
    assert payload["delivery"] == "inline"
    assert payload["encrypted_data"] == "small_ciphertext"
    assert "data" not in payload
    assert payload["zero_knowledge"] is True


@pytest.mark.asyncio
async def test_local_stdio_decrypt_failure_falls_back_to_raw_with_note(monkeypatch):
    """An older grant wrapped to a key this install no longer holds must
    fail closed to the raw ciphertext contract, not error out."""
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    stale_grant_private = X25519PrivateKey.generate()
    current_local_private = X25519PrivateKey.generate()
    export_payload = _real_encrypted_export(
        {"financial": {"net_worth": 1}},
        connector_public_key=stale_grant_private.public_key(),
    )
    _wire_local_stdio_success(monkeypatch, export_payload=export_payload)
    monkeypatch.setattr(
        data_tools,
        "get_or_create_local_connector_keypair",
        lambda: SimpleNamespace(private_key=current_local_private),
    )

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123"}
    )

    payload = json.loads(result[0].text)
    assert payload["delivery"] == "inline"
    assert payload["encrypted_data"] == export_payload["encrypted_data"]
    assert "data" not in payload
    assert "older connector key" in payload["delivery_note"]


@pytest.mark.asyncio
async def test_local_stdio_oversized_narrowed_result_falls_back_to_raw(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    local_private = X25519PrivateKey.generate()
    huge_payload = {"financial": {"blob": "A" * (data_tools.DECRYPTED_LOCAL_MAX_JSON_CHARS + 1)}}
    export_payload = _real_encrypted_export(
        huge_payload, connector_public_key=local_private.public_key()
    )
    _wire_local_stdio_success(monkeypatch, export_payload=export_payload)
    monkeypatch.setattr(
        data_tools,
        "get_or_create_local_connector_keypair",
        lambda: SimpleNamespace(private_key=local_private),
    )

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123"}
    )

    payload = json.loads(result[0].text)
    # The raw ciphertext itself is also large, so the fallback naturally
    # routes to download delivery (not inline) - the key assertions are that
    # decryption was abandoned and the oversized-result note is surfaced.
    assert payload["delivery"] in {"inline", "download"}
    assert "data" not in payload
    assert "too large" in payload["delivery_note"]


@pytest.mark.asyncio
async def test_local_stdio_decrypted_result_above_raw_threshold_still_succeeds(monkeypatch):
    """A decrypted result larger than the raw-ciphertext inline limit but under
    the (deliberately larger) decrypted-local limit must still return `data`
    directly. Regression guard for the local-decrypt threshold raise: a
    sandboxed LLM host with no localhost route needs single-domain scopes
    like attr.financial.profile.*/analytics.* to succeed inline even though
    they exceed the base64-ciphertext-oriented 16K limit.
    """
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    local_private = X25519PrivateKey.generate()
    assert data_tools.DECRYPTED_LOCAL_MAX_JSON_CHARS > data_tools.INLINE_EXPORT_MAX_BASE64_CHARS
    mid_sized_payload = {
        "financial": {"blob": "A" * (data_tools.INLINE_EXPORT_MAX_BASE64_CHARS + 1_000)}
    }
    export_payload = _real_encrypted_export(
        mid_sized_payload, connector_public_key=local_private.public_key()
    )
    _wire_local_stdio_success(monkeypatch, export_payload=export_payload)
    monkeypatch.setattr(
        data_tools,
        "get_or_create_local_connector_keypair",
        lambda: SimpleNamespace(private_key=local_private),
    )

    result = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user@example.com", "consent_token": "token_123"}
    )

    payload = json.loads(result[0].text)
    assert payload["delivery"] == "decrypted_local"
    assert payload["decrypted"] is True
    assert payload["data"] == mid_sized_payload
    assert "encrypted_data" not in payload
