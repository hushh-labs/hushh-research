from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from mcp_modules.tools import data_tools


@pytest.mark.asyncio
async def test_get_scoped_data_returns_decrypted_payload(monkeypatch):
    async def _resolve(user_id: str) -> str:
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
                scope=SimpleNamespace(value="pkm.read"),
            ),
        )

    async def _fetch(token: str):
        assert token == "token_123"  # noqa: S105
        return {"financial": {"risk_profile": "balanced"}}

    monkeypatch.setattr(data_tools, "resolve_email_to_uid", _resolve)
    monkeypatch.setattr(data_tools, "validate_token_with_db", _validate)
    monkeypatch.setattr(data_tools, "_fetch_decrypted_export", _fetch)

    result = await data_tools.handle_get_scoped_data(
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
    assert payload["data"]["financial"]["risk_profile"] == "balanced"


@pytest.mark.asyncio
async def test_fetch_decrypted_export_unwraps_wrapped_key(monkeypatch):
    connector_private_key = x25519.X25519PrivateKey.generate()
    sender_private_key = x25519.X25519PrivateKey.generate()
    shared_secret = connector_private_key.exchange(sender_private_key.public_key())
    digest = hashes.Hash(hashes.SHA256())
    digest.update(shared_secret)
    wrapping_key = digest.finalize()

    export_key_bytes = bytes.fromhex("00" * 32)
    wrapped_iv = b"123456789012"
    wrapped_combined = AESGCM(wrapping_key).encrypt(wrapped_iv, export_key_bytes, None)
    wrapped_ciphertext = wrapped_combined[:-16]
    wrapped_tag = wrapped_combined[-16:]

    payload_bytes = b'{"health":{"activities":{"entities":{}}}}'
    payload_iv = b"abcdefghijkl"
    payload_combined = AESGCM(export_key_bytes).encrypt(payload_iv, payload_bytes, None)
    payload_ciphertext = payload_combined[:-16]
    payload_tag = payload_combined[-16:]

    class _FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            import base64

            return {
                "wrapped_key_bundle": {
                    "wrapped_export_key": base64.b64encode(wrapped_ciphertext).decode("utf-8"),
                    "wrapped_key_iv": base64.b64encode(wrapped_iv).decode("utf-8"),
                    "wrapped_key_tag": base64.b64encode(wrapped_tag).decode("utf-8"),
                    "sender_public_key": base64.b64encode(
                        sender_private_key.public_key().public_bytes(
                            encoding=serialization.Encoding.Raw,
                            format=serialization.PublicFormat.Raw,
                        )
                    ).decode("utf-8"),
                },
                "encrypted_data": base64.b64encode(payload_ciphertext).decode("utf-8"),
                "iv": base64.b64encode(payload_iv).decode("utf-8"),
                "tag": base64.b64encode(payload_tag).decode("utf-8"),
            }

    class _FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, *_args, **_kwargs):
            return _FakeResponse()

    monkeypatch.setattr(data_tools, "load_connector_private_key", lambda: connector_private_key)
    monkeypatch.setattr(data_tools.httpx, "AsyncClient", lambda: _FakeClient())

    result = await data_tools._fetch_decrypted_export("token_123")

    assert result == {"health": {"activities": {"entities": {}}}}
