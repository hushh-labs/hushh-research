"""Strict wire validation for the isolated ``crm-zk-uat.v1`` profile.

This compatibility profile is intentionally narrower than ``crm-zk.v1``. It
provides field-value confidentiality for a gated MuleSoft UAT connector using
X25519, SHA-256 of the shared secret, and AES-256-GCM without AAD. Hussh never
decrypts the envelope. Transport authentication and Hussh's owner approval are
the UAT authority; this module must not be presented as production-grade ZK.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

CRM_ZK_UAT_V1_PROFILE = "crm-zk-uat.v1"
CRM_ZK_UAT_V1_MAX_CIPHERTEXT_BYTES = 1_000_000
CRM_ZK_UAT_V1_MAX_TTL_MS = 5 * 60 * 1000
_B64_MAX = 1_400_000


class CrmZkUatValidationError(ValueError):
    """Value-free validation failure safe to map to a public error code."""


def _decode(value: str, *, name: str, expected_bytes: int | None = None) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise CrmZkUatValidationError(f"crm_zk_uat_invalid_{name}") from exc
    if expected_bytes is not None and len(decoded) != expected_bytes:
        raise CrmZkUatValidationError(f"crm_zk_uat_invalid_{name}")
    return decoded


class CrmZkUatEncryptedFields(BaseModel):
    """Opaque value envelope shared by browser, Hussh, and MuleSoft."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    profile: Literal["crm-zk-uat.v1"] = CRM_ZK_UAT_V1_PROFILE
    direction: Literal["read_request", "read_response", "update_request"]
    recipient_key_id: str = Field(
        validation_alias=AliasChoices("recipientKeyId", "recipient_key_id"),
        serialization_alias="recipientKeyId",
        min_length=1,
        max_length=160,
    )
    client_operation_id: str = Field(
        validation_alias=AliasChoices("clientOperationId", "client_operation_id"),
        serialization_alias="clientOperationId",
        min_length=16,
        max_length=160,
    )
    expires_at_ms: int = Field(
        validation_alias=AliasChoices("expiresAtMs", "expires_at_ms"),
        serialization_alias="expiresAtMs",
        gt=0,
    )
    client_public_key: str = Field(
        validation_alias=AliasChoices("clientPublicKey", "client_public_key"),
        serialization_alias="clientPublicKey",
        min_length=1,
        max_length=128,
    )
    wrapped_payload_key: str = Field(
        validation_alias=AliasChoices("wrappedPayloadKey", "wrapped_payload_key"),
        serialization_alias="wrappedPayloadKey",
        min_length=1,
        max_length=256,
    )
    wrapped_key_iv: str = Field(
        validation_alias=AliasChoices("wrappedKeyIv", "wrapped_key_iv"),
        serialization_alias="wrappedKeyIv",
        min_length=1,
        max_length=64,
    )
    wrapped_key_tag: str = Field(
        validation_alias=AliasChoices("wrappedKeyTag", "wrapped_key_tag"),
        serialization_alias="wrappedKeyTag",
        min_length=1,
        max_length=64,
    )
    payload_iv: str = Field(
        validation_alias=AliasChoices("payloadIv", "payload_iv"),
        serialization_alias="payloadIv",
        min_length=1,
        max_length=64,
    )
    payload_tag: str = Field(
        validation_alias=AliasChoices("payloadTag", "payload_tag"),
        serialization_alias="payloadTag",
        min_length=1,
        max_length=64,
    )
    ciphertext: str = Field(min_length=1, max_length=_B64_MAX)

    @model_validator(mode="after")
    def _validate_binary_shape(self) -> "CrmZkUatEncryptedFields":
        _decode(self.client_public_key, name="client_public_key", expected_bytes=32)
        _decode(self.wrapped_payload_key, name="wrapped_payload_key", expected_bytes=32)
        _decode(self.wrapped_key_iv, name="wrapped_key_iv", expected_bytes=12)
        _decode(self.wrapped_key_tag, name="wrapped_key_tag", expected_bytes=16)
        _decode(self.payload_iv, name="payload_iv", expected_bytes=12)
        _decode(self.payload_tag, name="payload_tag", expected_bytes=16)
        ciphertext = _decode(self.ciphertext, name="ciphertext")
        if not ciphertext or len(ciphertext) > CRM_ZK_UAT_V1_MAX_CIPHERTEXT_BYTES:
            raise CrmZkUatValidationError("crm_zk_uat_invalid_ciphertext")
        return self

    def digest(self) -> str:
        encoded = json.dumps(
            self.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def validate_crm_zk_uat_envelope(
    value: CrmZkUatEncryptedFields | dict[str, Any],
    *,
    expected_direction: Literal["read_request", "read_response", "update_request"],
    expected_key_id: str,
    now_ms: int,
) -> CrmZkUatEncryptedFields:
    envelope = (
        value
        if isinstance(value, CrmZkUatEncryptedFields)
        else CrmZkUatEncryptedFields.model_validate(value)
    )
    if envelope.direction != expected_direction:
        raise CrmZkUatValidationError("crm_zk_uat_direction_mismatch")
    if envelope.recipient_key_id != expected_key_id:
        raise CrmZkUatValidationError("crm_zk_uat_recipient_key_mismatch")
    if envelope.expires_at_ms <= now_ms:
        raise CrmZkUatValidationError("crm_zk_uat_envelope_expired")
    if envelope.expires_at_ms > now_ms + CRM_ZK_UAT_V1_MAX_TTL_MS:
        raise CrmZkUatValidationError("crm_zk_uat_expiry_too_far")
    return envelope
