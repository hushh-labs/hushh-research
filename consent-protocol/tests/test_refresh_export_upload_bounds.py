from __future__ import annotations

import base64

import pytest
from pydantic import ValidationError

from api.routes.consent import RefreshExportUploadRequest
from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    ciphertext_digest_from_base64,
    digest_bytes,
)


def _valid_payload(raw_ciphertext: bytes = b"ciphertext") -> dict:
    encrypted_data = base64.b64encode(raw_ciphertext).decode()
    aad = ConsentExportAadV2(
        app_id="app_demo",
        grant_id="req_demo",
        export_id="123e4567-e89b-12d3-a456-426614174000",
        revision=2,
        machine_scope="attr.financial.portfolio.*",
        scope_handle="s_portfolio_demo",
        recipient_key_fingerprint=f"sha256:{'a' * 64}",
        expires_at_ms=1_800_000_000_000,
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
        "userId": "user_abc",
        "jobClaimId": "123e4567-e89b-12d3-a456-426614174111",
        "expectedPriorRevision": 1,
        "encryptedData": encrypted_data,
        "encryptedIv": "a" * 16,
        "encryptedTag": "b" * 16,
        "wrappedExportKey": "c" * 44,
        "wrappedKeyIv": "d" * 16,
        "wrappedKeyTag": "e" * 16,
        "senderPublicKey": "f" * 44,
        "exportEnvelope": envelope.model_dump(mode="json"),
    }


def test_refresh_upload_accepts_envelope_v2_and_claim_contract() -> None:
    model = RefreshExportUploadRequest(**_valid_payload())
    assert model.expectedPriorRevision == 1
    assert model.exportEnvelope.aad.revision == 2


def test_refresh_upload_requires_claim_revision_and_envelope() -> None:
    payload = _valid_payload()
    for field in ("jobClaimId", "expectedPriorRevision", "exportEnvelope"):
        candidate = dict(payload)
        candidate.pop(field)
        with pytest.raises(ValidationError):
            RefreshExportUploadRequest(**candidate)


def test_refresh_upload_bounds_wrapped_key_fields() -> None:
    with pytest.raises(ValidationError) as exc_info:
        RefreshExportUploadRequest(**{**_valid_payload(), "wrappedExportKey": "x" * 8193})
    assert any(error["loc"] == ("wrappedExportKey",) for error in exc_info.value.errors())


def test_encrypted_data_has_a_bounded_transport_schema() -> None:
    schema = RefreshExportUploadRequest.model_json_schema()
    assert schema["properties"]["encryptedData"]["maxLength"] == 100_000_000
