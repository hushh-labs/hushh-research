from __future__ import annotations

import base64
import hashlib

import pytest
from pydantic import ValidationError

from hushh_mcp.consent.export_envelope import (
    ConsentExportAadV2,
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    ciphertext_digest_from_base64,
    connector_key_fingerprint,
    digest_bytes,
    enforce_raw_byte_limit,
    normalize_refresh_policy,
    scope_handle_for_machine_scope,
    validate_export_envelope_submission,
)


def _aad() -> ConsentExportAadV2:
    return ConsentExportAadV2(
        app_id="app_hushh",
        grant_id="req_grant_123",
        export_id="123e4567-e89b-12d3-a456-426614174000",
        revision=1,
        machine_scope="attr.financial.portfolio.*",
        scope_handle="s_portfolio_123",
        recipient_key_fingerprint=f"sha256:{'a' * 64}",
        expires_at_ms=1_800_000_000_000,
    )


def test_canonical_aad_is_stable_and_sorted() -> None:
    encoded = canonical_aad_bytes(_aad())
    assert encoded.startswith(b'{"app_id":"app_hushh"')
    assert b" " not in encoded
    assert digest_bytes(encoded) == f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def test_submission_validates_ciphertext_and_server_context() -> None:
    ciphertext = base64.b64encode(b"encrypted-payload").decode()
    ciphertext_digest, ciphertext_bytes = ciphertext_digest_from_base64(ciphertext)
    aad = _aad()
    envelope = ConsentExportEnvelopeSubmissionV2(
        export_id=aad.export_id,
        aad=aad,
        aad_sha256=digest_bytes(canonical_aad_bytes(aad)),
        ciphertext_sha256=ciphertext_digest,
        ciphertext_bytes=ciphertext_bytes,
    )

    validate_export_envelope_submission(
        envelope=envelope,
        encrypted_data=ciphertext,
        expected_app_id=aad.app_id,
        expected_grant_id=aad.grant_id,
        expected_revision=1,
        expected_scope=aad.machine_scope,
        expected_scope_handle=aad.scope_handle,
        expected_recipient_fingerprint=aad.recipient_key_fingerprint,
        expected_expires_at_ms=aad.expires_at_ms,
    )

    with pytest.raises(ValueError, match="export_ciphertext_digest_mismatch"):
        validate_export_envelope_submission(
            envelope=envelope,
            encrypted_data=base64.b64encode(b"tampered").decode(),
            expected_app_id=aad.app_id,
            expected_grant_id=aad.grant_id,
            expected_revision=1,
            expected_scope=aad.machine_scope,
            expected_scope_handle=aad.scope_handle,
            expected_recipient_fingerprint=aad.recipient_key_fingerprint,
            expected_expires_at_ms=aad.expires_at_ms,
        )


def test_envelope_rejects_aad_digest_or_export_identity_mismatch() -> None:
    aad = _aad()
    with pytest.raises(ValidationError, match="export_envelope_id_mismatch"):
        ConsentExportEnvelopeSubmissionV2(
            export_id="123e4567-e89b-12d3-a456-426614174999",
            aad=aad,
            aad_sha256=digest_bytes(canonical_aad_bytes(aad)),
            ciphertext_sha256=f"sha256:{'b' * 64}",
            ciphertext_bytes=1,
        )


def test_connector_fingerprint_is_sha256_of_raw_x25519_key() -> None:
    raw = bytes(range(32))
    encoded = base64.b64encode(raw).decode()
    assert connector_key_fingerprint(encoded) == f"sha256:{hashlib.sha256(raw).hexdigest()}"

    with pytest.raises(ValueError, match="connector_public_key_must_be_x25519_32_bytes"):
        connector_key_fingerprint(base64.b64encode(b"short").decode())


def test_unproven_refresh_policy_fails_closed_to_snapshot() -> None:
    assert normalize_refresh_policy("continuous_until_expiry") == "continuous_until_expiry"
    assert normalize_refresh_policy("unknown") == "snapshot"
    assert normalize_refresh_policy(None) == "snapshot"


def test_scope_handle_fallback_is_stable_and_subject_bound() -> None:
    first = scope_handle_for_machine_scope("user_a", "attr.financial.*")
    assert first == scope_handle_for_machine_scope("user_a", "attr.financial.*")
    assert first != scope_handle_for_machine_scope("user_b", "attr.financial.*")
    assert first.startswith("s_")


@pytest.mark.parametrize("raw_bytes", [1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1])
def test_one_megabyte_is_not_a_protocol_split_boundary(raw_bytes: int) -> None:
    encoded = base64.b64encode(b"x" * raw_bytes).decode()
    _digest, measured = ciphertext_digest_from_base64(encoded)
    enforce_raw_byte_limit(measured, 2 * 1024 * 1024)
    assert measured == raw_bytes


def test_configured_raw_byte_maximum_is_inclusive_and_max_plus_one_fails() -> None:
    enforce_raw_byte_limit(1024, 1024)
    with pytest.raises(ValueError, match="PAYLOAD_TOO_LARGE"):
        enforce_raw_byte_limit(1025, 1024)
