"""Strict contracts for the isolated ``crm-zk.v1`` Connected Systems protocol.

This module is deliberately independent from ``consent.connector_crypto_profiles``.
The existing consent-export X25519 profile hashes a shared secret directly and
must remain byte-for-byte compatible.  CRM ZK instead uses X25519, HKDF-SHA256
with an all-zero salt and ``info=b"crm-zk.v1:key-wrap"``, and two AES-256-GCM
operations implemented by the browser and MuleSoft.

The API never decrypts CRM values.  It authenticates a browser-produced opaque
envelope against a short-lived server-issued binding context before persistence
or relay, and it verifies owner approval proofs before issuing a mutation.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

CRM_ZK_V1_PROFILE = "crm-zk.v1"
CRM_ZK_V1_HKDF_INFO = "crm-zk.v1:key-wrap"
CRM_ZK_V1_HKDF_ZERO_SALT_BYTES = 32
CRM_ZK_V1_MAX_ENVELOPE_BYTES = 1_000_000
_SHA256_PATTERN = r"^sha256:[0-9a-f]{64}$"
_B64_MAX = 1_400_000


class CrmZkValidationError(ValueError):
    """A deliberately value-free validation error safe to return to a client."""


def _b64(value: str, *, name: str, expected_bytes: int | None = None) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise CrmZkValidationError(f"crm_zk_invalid_{name}") from exc
    if expected_bytes is not None and len(decoded) != expected_bytes:
        raise CrmZkValidationError(f"crm_zk_invalid_{name}")
    return decoded


def _assert_json_wire_value(value: Any) -> None:
    """Reject non-portable JSON before producing bytes shared with Java/JS."""

    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, float):
        raise CrmZkValidationError("crm_zk_non_portable_json_number")
    if isinstance(value, str):
        return
    if isinstance(value, list):
        for item in value:
            _assert_json_wire_value(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise CrmZkValidationError("crm_zk_non_string_json_key")
            _assert_json_wire_value(item)
        return
    raise CrmZkValidationError("crm_zk_non_json_value")


def canonical_json_bytes(value: Any) -> bytes:
    """The byte contract shared by browser, Python, and MuleSoft Java.

    JSON is recursively key-sorted, compact, UTF-8 encoded and ASCII escaped.
    The protocol permits only integer numeric metadata, avoiding JavaScript
    float formatting ambiguity. Browser code must use the same key comparator
    and ``JSON.stringify`` output after recursively sorting keys.
    """

    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json", by_alias=True, exclude_none=False)
    _assert_json_wire_value(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "utf-8"
    )


def sha256_digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _fingerprint_base64_key(value: str, *, expected_bytes: int, name: str) -> str:
    return sha256_digest(_b64(value, name=name, expected_bytes=expected_bytes))


class CrmZkBindingContext(BaseModel):
    """Server-issued, short-lived authority used to construct request AAD."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    profile: Literal["crm-zk.v1"] = CRM_ZK_V1_PROFILE
    context_id: str = Field(
        validation_alias=AliasChoices("contextId", "context_id"), min_length=16, max_length=160
    )
    system_id: str = Field(
        validation_alias=AliasChoices("systemId", "system_id"), min_length=1, max_length=128
    )
    operation: Literal["read", "update"]
    object_type: str = Field(
        validation_alias=AliasChoices("objectType", "object_type"), min_length=1, max_length=80
    )
    record_id: str = Field(
        validation_alias=AliasChoices("recordId", "record_id"), min_length=1, max_length=128
    )
    field_names: tuple[str, ...] = Field(
        validation_alias=AliasChoices("fieldNames", "field_names"), max_length=128
    )
    schema_fingerprint: str | None = Field(
        default=None,
        validation_alias=AliasChoices("schemaFingerprint", "schema_fingerprint"),
        max_length=128,
    )
    configuration_revision: int = Field(
        validation_alias=AliasChoices("configurationRevision", "configuration_revision"), ge=1
    )
    recipient_key_id: str = Field(
        validation_alias=AliasChoices("recipientKeyId", "recipient_key_id"),
        min_length=1,
        max_length=160,
    )
    recipient_key_fingerprint: str = Field(
        validation_alias=AliasChoices("recipientKeyFingerprint", "recipient_key_fingerprint"),
        pattern=_SHA256_PATTERN,
    )
    client_operation_id: str = Field(
        validation_alias=AliasChoices("clientOperationId", "client_operation_id"),
        min_length=16,
        max_length=160,
    )
    expires_at_ms: int = Field(validation_alias=AliasChoices("expiresAtMs", "expires_at_ms"), gt=0)

    @field_validator("field_names")
    @classmethod
    def _field_names_are_unique(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        cleaned = tuple(str(name).strip() for name in value)
        if any(not name or len(name) > 80 for name in cleaned) or len(set(cleaned)) != len(cleaned):
            raise ValueError("crm_zk_invalid_field_names")
        return cleaned


class CrmZkEncryptedFields(BaseModel):
    """The only value-bearing field accepted by CRM ZK routes.

    It contains opaque bytes and authenticated protocol metadata. Plain CRM
    values, raw CRM identifiers, CRM credentials, URLs, and targets are not
    legal members of this object.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    profile: Literal["crm-zk.v1"] = CRM_ZK_V1_PROFILE
    direction: Literal["read_request", "update_request"]
    recipient_key_id: str = Field(
        validation_alias=AliasChoices("recipientKeyId", "recipient_key_id"),
        min_length=1,
        max_length=160,
    )
    recipient_key_fingerprint: str = Field(
        validation_alias=AliasChoices("recipientKeyFingerprint", "recipient_key_fingerprint"),
        pattern=_SHA256_PATTERN,
    )
    client_ephemeral_public_key: str = Field(
        validation_alias=AliasChoices("clientEphemeralPublicKey", "client_ephemeral_public_key"),
        min_length=1,
        max_length=128,
    )
    envelope_id: str = Field(
        validation_alias=AliasChoices("envelopeId", "envelope_id"), min_length=16, max_length=160
    )
    context_id: str = Field(
        validation_alias=AliasChoices("contextId", "context_id"), min_length=16, max_length=160
    )
    context_digest: str = Field(
        validation_alias=AliasChoices("contextDigest", "context_digest"), pattern=_SHA256_PATTERN
    )
    client_operation_id: str = Field(
        validation_alias=AliasChoices("clientOperationId", "client_operation_id"),
        min_length=16,
        max_length=160,
    )
    expires_at_ms: int = Field(validation_alias=AliasChoices("expiresAtMs", "expires_at_ms"), gt=0)
    wrapped_payload_key: str = Field(
        validation_alias=AliasChoices("wrappedPayloadKey", "wrapped_payload_key"),
        min_length=1,
        max_length=256,
    )
    wrapped_key_iv: str = Field(
        validation_alias=AliasChoices("wrappedKeyIv", "wrapped_key_iv"), min_length=1, max_length=64
    )
    wrapped_key_tag: str = Field(
        validation_alias=AliasChoices("wrappedKeyTag", "wrapped_key_tag"),
        min_length=1,
        max_length=64,
    )
    payload_iv: str = Field(
        validation_alias=AliasChoices("payloadIv", "payload_iv"), min_length=1, max_length=64
    )
    payload_tag: str = Field(
        validation_alias=AliasChoices("payloadTag", "payload_tag"), min_length=1, max_length=64
    )
    ciphertext: str = Field(min_length=1, max_length=_B64_MAX)
    aad_sha256: str = Field(
        validation_alias=AliasChoices("aadSha256", "aad_sha256"), pattern=_SHA256_PATTERN
    )
    owner_signer_key_id: str = Field(
        validation_alias=AliasChoices("ownerSignerKeyId", "owner_signer_key_id"),
        min_length=1,
        max_length=160,
    )
    owner_signature: str = Field(
        validation_alias=AliasChoices("ownerSignature", "owner_signature"),
        min_length=1,
        max_length=256,
    )
    read_nonce: str | None = Field(
        default=None, validation_alias=AliasChoices("readNonce", "read_nonce"), max_length=256
    )

    @model_validator(mode="after")
    def _validate_binary_shape(self) -> "CrmZkEncryptedFields":
        _b64(
            self.client_ephemeral_public_key, name="client_ephemeral_public_key", expected_bytes=32
        )
        _b64(self.wrapped_payload_key, name="wrapped_payload_key", expected_bytes=32)
        _b64(self.wrapped_key_iv, name="wrapped_key_iv", expected_bytes=12)
        _b64(self.wrapped_key_tag, name="wrapped_key_tag", expected_bytes=16)
        _b64(self.payload_iv, name="payload_iv", expected_bytes=12)
        _b64(self.payload_tag, name="payload_tag", expected_bytes=16)
        ciphertext = _b64(self.ciphertext, name="ciphertext")
        if not ciphertext or len(ciphertext) > CRM_ZK_V1_MAX_ENVELOPE_BYTES:
            raise CrmZkValidationError("crm_zk_invalid_ciphertext")
        _b64(self.owner_signature, name="owner_signature", expected_bytes=64)
        if self.direction == "read_request":
            _b64(str(self.read_nonce or ""), name="read_nonce", expected_bytes=32)
        elif self.read_nonce is not None:
            raise CrmZkValidationError("crm_zk_update_must_not_include_read_nonce")
        return self

    def unsigned_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude={"owner_signature"})

    def digest(self) -> str:
        return sha256_digest(canonical_json_bytes(self.unsigned_dict()))


class CrmZkApprovalProof(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    intent_id: str = Field(
        validation_alias=AliasChoices("intentId", "intent_id"), min_length=16, max_length=160
    )
    envelope_digest: str = Field(
        validation_alias=AliasChoices("envelopeDigest", "envelope_digest"), pattern=_SHA256_PATTERN
    )
    challenge_id: str = Field(
        validation_alias=AliasChoices("challengeId", "challenge_id"), min_length=16, max_length=160
    )
    nonce: str = Field(min_length=1, max_length=256)
    expires_at_ms: int = Field(validation_alias=AliasChoices("expiresAtMs", "expires_at_ms"), gt=0)
    owner_signer_key_id: str = Field(
        validation_alias=AliasChoices("ownerSignerKeyId", "owner_signer_key_id"),
        min_length=1,
        max_length=160,
    )
    signature: str = Field(min_length=1, max_length=256)

    @model_validator(mode="after")
    def _validate_shape(self) -> "CrmZkApprovalProof":
        _b64(self.nonce, name="approval_nonce", expected_bytes=32)
        _b64(self.signature, name="approval_signature", expected_bytes=64)
        return self

    def unsigned_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude={"signature"})


class CrmZkPartnerResponseEnvelope(BaseModel):
    """Opaque MuleSoft result; the browser verifies this before decrypting."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    profile: Literal["crm-zk.v1"] = CRM_ZK_V1_PROFILE
    direction: Literal["read_response", "update_response"]
    context_id: str = Field(
        validation_alias=AliasChoices("contextId", "context_id"), min_length=16, max_length=160
    )
    context_digest: str = Field(
        validation_alias=AliasChoices("contextDigest", "context_digest"), pattern=_SHA256_PATTERN
    )
    envelope_id: str = Field(
        validation_alias=AliasChoices("envelopeId", "envelope_id"), min_length=16, max_length=160
    )
    client_operation_id: str = Field(
        validation_alias=AliasChoices("clientOperationId", "client_operation_id"),
        min_length=16,
        max_length=160,
    )
    expires_at_ms: int = Field(validation_alias=AliasChoices("expiresAtMs", "expires_at_ms"), gt=0)
    recipient_client_ephemeral_public_key: str = Field(
        validation_alias=AliasChoices(
            "recipientClientEphemeralPublicKey", "recipient_client_ephemeral_public_key"
        ),
        min_length=1,
        max_length=128,
    )
    wrapped_payload_key: str = Field(
        validation_alias=AliasChoices("wrappedPayloadKey", "wrapped_payload_key"),
        min_length=1,
        max_length=256,
    )
    wrapped_key_iv: str = Field(
        validation_alias=AliasChoices("wrappedKeyIv", "wrapped_key_iv"), min_length=1, max_length=64
    )
    wrapped_key_tag: str = Field(
        validation_alias=AliasChoices("wrappedKeyTag", "wrapped_key_tag"),
        min_length=1,
        max_length=64,
    )
    payload_iv: str = Field(
        validation_alias=AliasChoices("payloadIv", "payload_iv"), min_length=1, max_length=64
    )
    payload_tag: str = Field(
        validation_alias=AliasChoices("payloadTag", "payload_tag"), min_length=1, max_length=64
    )
    ciphertext: str = Field(min_length=1, max_length=_B64_MAX)
    aad_sha256: str = Field(
        validation_alias=AliasChoices("aadSha256", "aad_sha256"), pattern=_SHA256_PATTERN
    )
    response_signer_key_id: str = Field(
        validation_alias=AliasChoices("responseSignerKeyId", "response_signer_key_id"),
        min_length=1,
        max_length=160,
    )
    response_signature: str = Field(
        validation_alias=AliasChoices("responseSignature", "response_signature"),
        min_length=1,
        max_length=256,
    )

    @model_validator(mode="after")
    def _validate_binary_shape(self) -> "CrmZkPartnerResponseEnvelope":
        _b64(
            self.recipient_client_ephemeral_public_key,
            name="recipient_client_ephemeral_public_key",
            expected_bytes=32,
        )
        _b64(self.wrapped_payload_key, name="response_wrapped_payload_key", expected_bytes=32)
        _b64(self.wrapped_key_iv, name="response_wrapped_key_iv", expected_bytes=12)
        _b64(self.wrapped_key_tag, name="response_wrapped_key_tag", expected_bytes=16)
        _b64(self.payload_iv, name="response_payload_iv", expected_bytes=12)
        _b64(self.payload_tag, name="response_payload_tag", expected_bytes=16)
        if not _b64(self.ciphertext, name="response_ciphertext"):
            raise CrmZkValidationError("crm_zk_invalid_response_ciphertext")
        _b64(self.response_signature, name="response_signature", expected_bytes=64)
        return self

    def unsigned_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude={"response_signature"})


def aad_for_context(
    *,
    context: CrmZkBindingContext,
    direction: str,
    client_ephemeral_public_key: str,
    read_nonce: str | None = None,
) -> dict[str, Any]:
    """Return all server- and client-bound AAD fields in one audited shape."""

    aad: dict[str, Any] = {
        "profile": CRM_ZK_V1_PROFILE,
        "direction": direction,
        "systemId": context.system_id,
        "operation": context.operation,
        "objectType": context.object_type,
        "fieldNames": list(context.field_names),
        "schemaFingerprint": context.schema_fingerprint,
        "configurationRevision": context.configuration_revision,
        "recipientKeyId": context.recipient_key_id,
        "recipientKeyFingerprint": context.recipient_key_fingerprint,
        "contextId": context.context_id,
        # The digest commits to the backend-resolved raw record id without
        # placing that id in a browser-controlled request field.
        "contextDigest": sha256_digest(canonical_json_bytes(context)),
        "clientOperationId": context.client_operation_id,
        "expiresAtMs": context.expires_at_ms,
        "clientEphemeralPublicKey": client_ephemeral_public_key,
    }
    if read_nonce is not None:
        aad["readNonce"] = read_nonce
    return aad


def validate_encrypted_fields(
    *,
    encrypted_fields: CrmZkEncryptedFields | dict[str, Any],
    context: CrmZkBindingContext | dict[str, Any],
    owner_signing_public_key_spki: str,
    now_ms: int | None = None,
) -> CrmZkEncryptedFields:
    """Verify complete request integrity without decrypting a CRM value."""

    envelope = (
        encrypted_fields
        if isinstance(encrypted_fields, CrmZkEncryptedFields)
        else CrmZkEncryptedFields.model_validate(encrypted_fields)
    )
    binding = (
        context
        if isinstance(context, CrmZkBindingContext)
        else CrmZkBindingContext.model_validate(context)
    )
    timestamp = int(time.time() * 1000) if now_ms is None else now_ms
    expected_direction = f"{binding.operation}_request"
    if envelope.direction != expected_direction:
        raise CrmZkValidationError("crm_zk_direction_mismatch")
    expected_context_digest = sha256_digest(canonical_json_bytes(binding))
    if (
        envelope.context_id != binding.context_id
        or envelope.context_digest != sha256_digest(canonical_json_bytes(binding))
        or envelope.context_digest != expected_context_digest
        or envelope.client_operation_id != binding.client_operation_id
    ):
        raise CrmZkValidationError("crm_zk_context_mismatch")
    if (
        envelope.recipient_key_id != binding.recipient_key_id
        or envelope.recipient_key_fingerprint != binding.recipient_key_fingerprint
    ):
        raise CrmZkValidationError("crm_zk_recipient_key_mismatch")
    if envelope.expires_at_ms != binding.expires_at_ms or envelope.expires_at_ms <= timestamp:
        raise CrmZkValidationError("crm_zk_envelope_expired")
    expected_aad = aad_for_context(
        context=binding,
        direction=envelope.direction,
        client_ephemeral_public_key=envelope.client_ephemeral_public_key,
        read_nonce=envelope.read_nonce,
    )
    if sha256_digest(canonical_json_bytes(expected_aad)) != envelope.aad_sha256:
        raise CrmZkValidationError("crm_zk_aad_mismatch")
    _verify_p256_signature(
        public_key_spki=owner_signing_public_key_spki,
        raw_signature_b64=envelope.owner_signature,
        message=canonical_json_bytes(envelope.unsigned_dict()),
        error_code="crm_zk_owner_signature_invalid",
    )
    return envelope


def validate_approval_proof(
    *,
    proof: CrmZkApprovalProof | dict[str, Any],
    intent_id: str,
    envelope_digest: str,
    challenge_id: str,
    challenge_nonce: str,
    challenge_expires_at_ms: int,
    owner_signing_public_key_spki: str,
    now_ms: int | None = None,
) -> CrmZkApprovalProof:
    resolved = (
        proof if isinstance(proof, CrmZkApprovalProof) else CrmZkApprovalProof.model_validate(proof)
    )
    timestamp = int(time.time() * 1000) if now_ms is None else now_ms
    if (
        resolved.intent_id != intent_id
        or resolved.envelope_digest != envelope_digest
        or resolved.challenge_id != challenge_id
        or resolved.nonce != challenge_nonce
        or resolved.expires_at_ms != challenge_expires_at_ms
        or resolved.expires_at_ms <= timestamp
    ):
        raise CrmZkValidationError("crm_zk_approval_proof_mismatch")
    _verify_p256_signature(
        public_key_spki=owner_signing_public_key_spki,
        raw_signature_b64=resolved.signature,
        message=canonical_json_bytes(resolved.unsigned_dict()),
        error_code="crm_zk_approval_signature_invalid",
    )
    return resolved


def validate_partner_response_envelope(
    *,
    response: CrmZkPartnerResponseEnvelope | dict[str, Any],
    context: CrmZkBindingContext | dict[str, Any],
    expected_client_ephemeral_public_key: str,
    response_signing_key_id: str,
    response_signing_public_key_spki: str,
    now_ms: int | None = None,
) -> CrmZkPartnerResponseEnvelope:
    """Authenticate a partner response before it is relayed to the browser.

    Browser verification is still mandatory: it is the decrypting endpoint and
    treats this server check as defense in depth, not a replacement for its
    pinned response-signing key verification.
    """

    envelope = (
        response
        if isinstance(response, CrmZkPartnerResponseEnvelope)
        else CrmZkPartnerResponseEnvelope.model_validate(response)
    )
    binding = (
        context
        if isinstance(context, CrmZkBindingContext)
        else CrmZkBindingContext.model_validate(context)
    )
    timestamp = int(time.time() * 1000) if now_ms is None else now_ms
    if (
        envelope.context_id != binding.context_id
        or envelope.client_operation_id != binding.client_operation_id
        or envelope.recipient_client_ephemeral_public_key != expected_client_ephemeral_public_key
        or envelope.response_signer_key_id != response_signing_key_id
        or envelope.expires_at_ms <= timestamp
    ):
        raise CrmZkValidationError("crm_zk_partner_response_mismatch")
    expected_aad = aad_for_context(
        context=binding,
        direction=envelope.direction,
        client_ephemeral_public_key=envelope.recipient_client_ephemeral_public_key,
    )
    if sha256_digest(canonical_json_bytes(expected_aad)) != envelope.aad_sha256:
        raise CrmZkValidationError("crm_zk_partner_response_aad_mismatch")
    _verify_p256_signature(
        public_key_spki=response_signing_public_key_spki,
        raw_signature_b64=envelope.response_signature,
        message=canonical_json_bytes(envelope.unsigned_dict()),
        error_code="crm_zk_partner_response_signature_invalid",
    )
    return envelope


def _verify_p256_signature(
    *, public_key_spki: str, raw_signature_b64: str, message: bytes, error_code: str
) -> None:
    try:
        public_key = serialization.load_der_public_key(
            _b64(public_key_spki, name="owner_public_key_spki")
        )
        if not isinstance(public_key, ec.EllipticCurvePublicKey) or not isinstance(
            public_key.curve, ec.SECP256R1
        ):
            raise TypeError("unsupported key")
        raw = _b64(raw_signature_b64, name="p256_signature", expected_bytes=64)
        signature = encode_dss_signature(
            int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
        )
        public_key.verify(signature, message, ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, TypeError, ValueError, CrmZkValidationError) as exc:
        raise CrmZkValidationError(error_code) from exc


def public_key_fingerprint(public_key_b64: str, *, expected_bytes: int = 32) -> str:
    return _fingerprint_base64_key(public_key_b64, expected_bytes=expected_bytes, name="public_key")


def p256_spki_fingerprint(public_key_spki_b64: str) -> str:
    """Validate an owner/partner P-256 SPKI and return its pinned digest."""
    try:
        encoded = _b64(public_key_spki_b64, name="p256_public_key_spki")
        key = serialization.load_der_public_key(encoded)
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(
            key.curve, ec.SECP256R1
        ):
            raise TypeError("unsupported key")
    except (TypeError, ValueError, CrmZkValidationError) as exc:
        raise CrmZkValidationError("crm_zk_invalid_owner_signing_key") from exc
    return sha256_digest(encoded)


def sign_server_context(*, context: CrmZkBindingContext, private_key_pkcs8_b64: str) -> str:
    """Sign the complete (including backend-bound record id) context for MuleSoft."""
    try:
        key = serialization.load_der_private_key(
            _b64(private_key_pkcs8_b64, name="context_signing_private_key"), password=None
        )
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(
            key.curve, ec.SECP256R1
        ):
            raise TypeError("unsupported key")
        der = key.sign(canonical_json_bytes(context), ec.ECDSA(hashes.SHA256()))
        # cryptography produces DER; browser/WebCrypto and the Java contract use
        # the portable fixed-width P1363 r||s representation.
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

        r, s = decode_dss_signature(der)
        return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode("ascii")
    except (TypeError, ValueError, CrmZkValidationError) as exc:
        raise CrmZkValidationError("crm_zk_context_signing_unconfigured") from exc
