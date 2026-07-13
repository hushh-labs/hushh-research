"""Authenticated consent-export envelope v2 contracts.

The ciphertext digest is intentionally carried beside the AES-GCM associated
data instead of inside it: ciphertext is a function of the associated data, so
including its own digest in that input would be circular.  The digest protects
resource transfer integrity; the AES-GCM tag binds the ciphertext to every
identity and lifecycle field in :class:`ConsentExportAadV2`.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONSENT_EXPORT_ENVELOPE_VERSION = 2
CONSENT_EXPORT_PAYLOAD_ALGORITHM = "AES-256-GCM"
CONSENT_EXPORT_WRAPPING_ALGORITHM = "X25519-AES256-GCM"
CONSENT_EXPORT_REFRESH_POLICIES = frozenset({"snapshot", "continuous_until_expiry"})

_SHA256_PATTERN = r"^sha256:[0-9a-f]{64}$"
_OPAQUE_HANDLE_PATTERN = r"^(?:s|scope)_[A-Za-z0-9_-]{6,128}$"


class ConsentExportAadV2(BaseModel):
    """Canonical fields authenticated by AES-256-GCM for one export revision."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[2] = 2
    app_id: str = Field(..., min_length=1, max_length=128)
    grant_id: str = Field(..., min_length=1, max_length=128)
    export_id: str = Field(..., min_length=32, max_length=64)
    revision: int = Field(..., ge=1, le=10_000_000)
    machine_scope: str = Field(..., min_length=1, max_length=256)
    scope_handle: str = Field(..., pattern=_OPAQUE_HANDLE_PATTERN)
    recipient_key_fingerprint: str = Field(..., pattern=_SHA256_PATTERN)
    payload_algorithm: Literal["AES-256-GCM"] = CONSENT_EXPORT_PAYLOAD_ALGORITHM
    expires_at_ms: int = Field(..., gt=0)


class ConsentExportEnvelopeSubmissionV2(BaseModel):
    """Owner-produced metadata submitted beside encrypted export bytes."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[2] = 2
    export_id: str = Field(..., min_length=32, max_length=64)
    aad: ConsentExportAadV2
    aad_sha256: str = Field(..., pattern=_SHA256_PATTERN)
    ciphertext_sha256: str = Field(..., pattern=_SHA256_PATTERN)
    ciphertext_bytes: int = Field(..., ge=1, le=1_000_000_000)

    @model_validator(mode="after")
    def validate_internal_identity(self) -> ConsentExportEnvelopeSubmissionV2:
        if self.aad.export_id != self.export_id:
            raise ValueError("export_envelope_id_mismatch")
        if digest_bytes(canonical_aad_bytes(self.aad)) != self.aad_sha256:
            raise ValueError("export_aad_digest_mismatch")
        return self


def canonical_aad_bytes(aad: ConsentExportAadV2 | dict[str, Any]) -> bytes:
    """Serialize AAD deterministically across Python, browser, and Node clients."""

    model = aad if isinstance(aad, ConsentExportAadV2) else ConsentExportAadV2.model_validate(aad)
    return json.dumps(
        model.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def canonical_envelope_submission_bytes(
    envelope: ConsentExportEnvelopeSubmissionV2 | dict[str, Any],
) -> bytes:
    model = (
        envelope
        if isinstance(envelope, ConsentExportEnvelopeSubmissionV2)
        else ConsentExportEnvelopeSubmissionV2.model_validate(envelope)
    )
    return json.dumps(
        model.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def decode_base64_strict(value: str) -> bytes:
    try:
        return base64.b64decode(str(value or ""), validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise ValueError("invalid_base64_export_field") from exc


def ciphertext_digest_from_base64(ciphertext: str) -> tuple[str, int]:
    decoded = decode_base64_strict(ciphertext)
    if not decoded:
        raise ValueError("empty_export_ciphertext")
    return digest_bytes(decoded), len(decoded)


def connector_key_fingerprint(connector_public_key: str) -> str:
    key_bytes = decode_base64_strict(connector_public_key)
    if len(key_bytes) != 32:
        raise ValueError("connector_public_key_must_be_x25519_32_bytes")
    return digest_bytes(key_bytes)


def scope_handle_for_machine_scope(user_id: str, machine_scope: str) -> str:
    """Return an opaque deterministic fallback when a PKM registry handle is absent."""

    identity = f"{str(user_id).strip()}|{str(machine_scope).strip()}".encode()
    return f"s_{hashlib.sha256(identity).hexdigest()[:32]}"


def validate_export_envelope_submission(
    *,
    envelope: ConsentExportEnvelopeSubmissionV2,
    encrypted_data: str,
    expected_app_id: str,
    expected_grant_id: str,
    expected_revision: int,
    expected_scope: str,
    expected_scope_handle: str,
    expected_recipient_fingerprint: str,
    expected_expires_at_ms: int | None = None,
    expected_export_id: str | None = None,
) -> None:
    """Independently bind a submitted envelope to server-authoritative context."""

    aad = envelope.aad
    expected = {
        "app_id": expected_app_id,
        "grant_id": expected_grant_id,
        "revision": expected_revision,
        "machine_scope": expected_scope,
        "scope_handle": expected_scope_handle,
        "recipient_key_fingerprint": expected_recipient_fingerprint,
    }
    actual = {
        "app_id": aad.app_id,
        "grant_id": aad.grant_id,
        "revision": aad.revision,
        "machine_scope": aad.machine_scope,
        "scope_handle": aad.scope_handle,
        "recipient_key_fingerprint": aad.recipient_key_fingerprint,
    }
    if actual != expected:
        raise ValueError("export_aad_context_mismatch")
    if expected_export_id is not None and envelope.export_id != expected_export_id:
        raise ValueError("export_id_mismatch")
    if expected_expires_at_ms is not None and aad.expires_at_ms != expected_expires_at_ms:
        raise ValueError("export_aad_expiry_mismatch")

    ciphertext_sha256, ciphertext_bytes = ciphertext_digest_from_base64(encrypted_data)
    if ciphertext_sha256 != envelope.ciphertext_sha256:
        raise ValueError("export_ciphertext_digest_mismatch")
    if ciphertext_bytes != envelope.ciphertext_bytes:
        raise ValueError("export_ciphertext_size_mismatch")


def normalize_refresh_policy(value: object) -> str:
    normalized = str(value or "snapshot").strip().lower()
    return normalized if normalized in CONSENT_EXPORT_REFRESH_POLICIES else "snapshot"


def enforce_raw_byte_limit(ciphertext_bytes: int, maximum_raw_bytes: int) -> None:
    if ciphertext_bytes < 1:
        raise ValueError("empty_export_ciphertext")
    if ciphertext_bytes > maximum_raw_bytes:
        raise ValueError("PAYLOAD_TOO_LARGE")
