from __future__ import annotations

import base64
import json
import os
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from mcp.types import ResourceLink

from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    canonical_envelope_submission_bytes,
    ciphertext_digest_from_base64,
    connector_key_fingerprint,
    digest_bytes,
)
from mcp_modules.tools import data_tools


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode()


def _token_obj():
    return SimpleNamespace(
        user_id="user_123",
        scope_str="attr.financial.portfolio.*",
        scope=SimpleNamespace(value="attr.financial.portfolio.*"),
    )


def _resource_metadata(**overrides):
    payload = {
        "status": "success",
        "granted_scope": "attr.financial.portfolio.*",
        "coverage_kind": "exact",
        "expires_at": 1_800_000_000_000,
        "export_revision": 1,
        "export_generated_at": "2026-07-10T12:00:00Z",
        "export_refresh_status": "current",
        "iv": _b64(b"i" * 12),
        "tag": _b64(b"t" * 16),
        "wrapped_key_bundle": {"connector_key_id": "connector_demo"},
        "export_envelope": {"version": 2},
        "resource_link": {
            "uri": "https://api.example.test/api/v1/scoped-export/resources/"
            "123e4567-e89b-12d3-a456-426614174000/revisions/1",
            "name": "Hussh encrypted export revision 1",
            "mime_type": "application/octet-stream",
            "size": 42,
        },
        "message": "Encrypted scoped export ready.",
    }
    payload.update(overrides)
    return payload


def _install_common(monkeypatch, *, payload=None, local=False):
    async def _validate(_token, expected_scope=None):  # noqa: ANN001
        return True, None, _token_obj()

    async def _resolve(user_id, **_kwargs):  # noqa: ANN001
        return user_id

    async def _fetch(**_kwargs):
        return payload or _resource_metadata()

    monkeypatch.setattr(data_tools, "validate_token_with_db", _validate)
    monkeypatch.setattr(data_tools, "resolve_email_to_uid", _resolve)
    monkeypatch.setattr(data_tools, "_fetch_encrypted_export_package", _fetch)
    monkeypatch.setattr(data_tools, "is_local_stdio_transport", lambda: local)


@pytest.mark.asyncio
async def test_hosted_tool_returns_real_resource_link_and_no_ciphertext(monkeypatch):
    _install_common(monkeypatch)

    content = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user_123", "consent_token": "consent_token_demo"}
    )

    assert len(content) == 2
    metadata = json.loads(content[0].text)
    assert metadata["status"] == "success"
    assert metadata["delivery"] == "resource_link"
    assert "encrypted_data" not in metadata
    assert "download" not in metadata
    assert isinstance(content[1], ResourceLink)
    assert str(content[1].uri).startswith("https://api.example.test/")


@pytest.mark.asyncio
async def test_hosted_tool_ignores_removed_inline_and_raw_escape_hatches(monkeypatch):
    _install_common(monkeypatch)

    content = await data_tools.handle_get_encrypted_scoped_export(
        {
            "user_id": "user_123",
            "consent_token": "consent_token_demo",
            "delivery": "inline",
            "raw": True,
        }
    )

    metadata = json.loads(content[0].text)
    assert metadata["delivery"] == "resource_link"
    assert "encrypted_data" not in metadata


@pytest.mark.asyncio
async def test_export_state_error_is_forwarded_without_resource(monkeypatch):
    _install_common(
        monkeypatch,
        payload={
            "status": "error",
            "error_code": "EXPORT_REFRESH_PENDING",
            "error": "Refresh pending.",
        },
    )

    content = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user_123", "consent_token": "consent_token_demo"}
    )

    assert len(content) == 1
    assert json.loads(content[0].text)["error_code"] == "EXPORT_REFRESH_PENDING"


def _encrypted_local_fixture(*, key_id: str = "local-key", plaintext_size: int = 8):
    recipient_private = X25519PrivateKey.generate()
    recipient_public = recipient_private.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    sender_private = X25519PrivateKey.generate()
    sender_public = sender_private.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    digest = hashes.Hash(hashes.SHA256())
    digest.update(sender_private.exchange(recipient_private.public_key()))
    wrapping_key = digest.finalize()
    export_key = os.urandom(32)
    aad = ConsentExportAadV2(
        app_id="app_demo",
        grant_id="req_demo",
        export_id="123e4567-e89b-12d3-a456-426614174000",
        revision=1,
        machine_scope="attr.financial.portfolio.*",
        scope_handle="s_portfolio_demo",
        recipient_key_fingerprint=connector_key_fingerprint(_b64(recipient_public)),
        expires_at_ms=1_800_000_000_000,
    )
    plaintext = json.dumps(
        {
            "portfolio": {"note": "x" * plaintext_size},
            "__export_metadata": {"approved_paths": ["portfolio.note"]},
        }
    ).encode()
    payload_iv = os.urandom(12)
    encrypted_payload = AESGCM(export_key).encrypt(payload_iv, plaintext, canonical_aad_bytes(aad))
    ciphertext, tag = encrypted_payload[:-16], encrypted_payload[-16:]
    ciphertext_b64 = _b64(ciphertext)
    ciphertext_sha256, ciphertext_bytes = ciphertext_digest_from_base64(ciphertext_b64)
    envelope = ConsentExportEnvelopeSubmissionV2(
        export_id=aad.export_id,
        aad=aad,
        aad_sha256=digest_bytes(canonical_aad_bytes(aad)),
        ciphertext_sha256=ciphertext_sha256,
        ciphertext_bytes=ciphertext_bytes,
    )
    wrapped_iv = os.urandom(12)
    wrapped = AESGCM(wrapping_key).encrypt(
        wrapped_iv,
        export_key,
        canonical_envelope_submission_bytes(envelope),
    )
    metadata = _resource_metadata(
        iv=_b64(payload_iv),
        tag=_b64(tag),
        wrapped_key_bundle={
            "wrapped_export_key": _b64(wrapped[:-16]),
            "wrapped_key_iv": _b64(wrapped_iv),
            "wrapped_key_tag": _b64(wrapped[-16:]),
            "sender_public_key": _b64(sender_public),
            "wrapping_alg": "X25519-AES256-GCM",
            "connector_key_id": key_id,
        },
        export_envelope=envelope.model_dump(mode="json"),
        resource_link={
            "uri": "https://api.example.test/resource",
            "name": "Encrypted export",
            "size": len(ciphertext),
        },
    )
    keypair = SimpleNamespace(private_key=recipient_private, key_id=key_id)
    return metadata, ciphertext, keypair


@pytest.mark.asyncio
async def test_local_stdio_fetches_validates_decrypts_and_narrows_outside_model(monkeypatch):
    metadata, ciphertext, keypair = _encrypted_local_fixture()
    _install_common(monkeypatch, payload=metadata, local=True)

    async def _fetch_resource(_uri):
        return ciphertext, None

    monkeypatch.setattr(data_tools, "_fetch_resource_bytes", _fetch_resource)
    monkeypatch.setattr(data_tools, "get_or_create_local_connector_keypair", lambda: keypair)

    content = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user_123", "consent_token": "consent_token_demo"}
    )

    payload = json.loads(content[0].text)
    assert payload["status"] == "success"
    assert payload["delivery"] == "decrypted_local"
    assert payload["data"] == {"portfolio": {"note": "x" * 8}}
    assert "encrypted_data" not in payload


@pytest.mark.asyncio
async def test_local_stdio_key_mismatch_requires_rebind_without_raw_fallback(monkeypatch):
    metadata, ciphertext, keypair = _encrypted_local_fixture(key_id="approved-key")
    _install_common(monkeypatch, payload=metadata, local=True)
    keypair.key_id = "different-key"

    async def _fetch_resource(_uri):
        return ciphertext, None

    monkeypatch.setattr(data_tools, "_fetch_resource_bytes", _fetch_resource)
    monkeypatch.setattr(data_tools, "get_or_create_local_connector_keypair", lambda: keypair)

    content = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user_123", "consent_token": "consent_token_demo"}
    )
    payload = json.loads(content[0].text)
    assert payload["error_code"] == "CONNECTOR_KEY_REBIND_REQUIRED"
    assert "encrypted_data" not in payload


@pytest.mark.asyncio
async def test_local_oversized_plaintext_requires_narrower_scope(monkeypatch):
    metadata, ciphertext, keypair = _encrypted_local_fixture(plaintext_size=256)
    _install_common(monkeypatch, payload=metadata, local=True)

    async def _fetch_resource(_uri):
        return ciphertext, None

    monkeypatch.setattr(data_tools, "_fetch_resource_bytes", _fetch_resource)
    monkeypatch.setattr(data_tools, "get_or_create_local_connector_keypair", lambda: keypair)
    monkeypatch.setattr(data_tools, "DECRYPTED_LOCAL_MAX_JSON_CHARS", 64)

    content = await data_tools.handle_get_encrypted_scoped_export(
        {"user_id": "user_123", "consent_token": "consent_token_demo"}
    )
    payload = json.loads(content[0].text)
    assert payload["error_code"] == "RESULT_REQUIRES_NARROWER_SCOPE"
    assert "encrypted_data" not in payload
