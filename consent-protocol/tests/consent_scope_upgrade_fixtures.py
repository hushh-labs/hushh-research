"""Shared free-schema and encrypted scope-approval fixtures."""

from __future__ import annotations

import base64
import time

import pytest
from asyncpg import UndefinedTableError
from fastapi import FastAPI

from api.routes import consent
from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    ciphertext_digest_from_base64,
    connector_key_fingerprint,
    digest_bytes,
)

_SCOPE_HANDLE = "s_scope_demo_123"


_CONNECTOR_PUBLIC_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="


@pytest.fixture(autouse=True)
def free_commerce_schema_is_absent(monkeypatch):
    """These characterize established free grants before the optional migration."""
    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService

    async def absent(self, **kwargs):
        raise UndefinedTableError()

    monkeypatch.setattr(ScopeCommerceService, "get_tariff", absent)
    from hushh_mcp.services import scope_commerce_requests

    async def registered(*args, **kwargs):
        return "s_scope_demo_123"

    monkeypatch.setattr(scope_commerce_requests, "authoritative_scope_handle", registered)
    from hushh_mcp.consent import paid_admission

    async def pool_port():
        return object()

    monkeypatch.setattr(paid_admission, "get_pool", pool_port)


def _developer_export_payload(
    *,
    request_id: str,
    scope: str,
    app_id: str = "app_demo_123",
    scope_handle: str = _SCOPE_HANDLE,
    expiry_hours: int = 24,
) -> dict:
    encrypted_data = base64.b64encode(b"ciphertext").decode()
    aad = ConsentExportAadV2(
        app_id=app_id,
        grant_id=request_id,
        export_id="123e4567-e89b-12d3-a456-426614174000",
        revision=1,
        machine_scope=scope,
        scope_handle=scope_handle,
        recipient_key_fingerprint=connector_key_fingerprint(_CONNECTOR_PUBLIC_KEY),
        expires_at_ms=int(time.time() * 1000) + expiry_hours * 60 * 60 * 1000,
    )
    ciphertext_sha256, ciphertext_bytes = ciphertext_digest_from_base64(encrypted_data)
    envelope = ConsentExportEnvelopeSubmissionV2(
        export_id=aad.export_id,
        aad=aad,
        aad_sha256=digest_bytes(canonical_aad_bytes(aad)),
        ciphertext_sha256=ciphertext_sha256,
        ciphertext_bytes=ciphertext_bytes,
    )
    return {
        "encryptedData": encrypted_data,
        "encryptedIv": "iv",
        "encryptedTag": "tag",
        "wrappedExportKey": "wrapped_key",
        "wrappedKeyIv": "wrapped_iv",
        "wrappedKeyTag": "wrapped_tag",
        "senderPublicKey": "sender_public",
        "connectorPublicKey": _CONNECTOR_PUBLIC_KEY,
        "connectorKeyId": "connector_demo",
        "wrappingAlg": "X25519-AES256-GCM",
        "exportEnvelope": envelope.model_dump(mode="json"),
    }


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent.router)
    app.dependency_overrides[consent.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    return app
