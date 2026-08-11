"""Conformance-critical unit checks for the isolated CRM ZK v1 envelope."""

from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from hushh_mcp.services import connected_systems_service
from hushh_mcp.services.connected_systems_service import (
    SALESFORCE_CRM_SYSTEM,
    ConnectedSystemsService,
    InMemoryConnectedSystemIntentStore,
)
from hushh_mcp.services.crm_zk_v1 import (
    CrmZkBindingContext,
    CrmZkEncryptedFields,
    CrmZkValidationError,
    aad_for_context,
    canonical_json_bytes,
    sha256_digest,
    validate_encrypted_fields,
)


def _b64(size: int, byte: int = 1) -> str:
    return base64.b64encode(bytes([byte]) * size).decode("ascii")


def _context() -> CrmZkBindingContext:
    return CrmZkBindingContext(
        contextId="czkc_" + "a" * 32,
        systemId="crm-1",
        operation="update",
        objectType="Contact",
        recordId="backend-bound-record",
        fieldNames=["Title"],
        schemaFingerprint="sha256:" + "c" * 64,
        configurationRevision=7,
        recipientKeyId="mulesoft-x25519-1",
        recipientKeyFingerprint="sha256:" + "d" * 64,
        clientOperationId="czko_" + "b" * 32,
        expiresAtMs=4_102_444_800_000,
    )


def _signed_envelope(context: CrmZkBindingContext) -> tuple[dict[str, str | int | None], str]:
    private = ec.generate_private_key(ec.SECP256R1())
    public = base64.b64encode(
        private.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    ).decode("ascii")
    client_public = _b64(32, 2)
    envelope: dict[str, str | int | None] = {
        "profile": "crm-zk.v1",
        "direction": "update_request",
        "recipientKeyId": context.recipient_key_id,
        "recipientKeyFingerprint": context.recipient_key_fingerprint,
        "clientEphemeralPublicKey": client_public,
        "envelopeId": "czke_" + "e" * 32,
        "contextId": context.context_id,
        "contextDigest": sha256_digest(canonical_json_bytes(context)),
        "clientOperationId": context.client_operation_id,
        "expiresAtMs": context.expires_at_ms,
        "wrappedPayloadKey": _b64(32, 3),
        "wrappedKeyIv": _b64(12, 4),
        "wrappedKeyTag": _b64(16, 5),
        "payloadIv": _b64(12, 6),
        "payloadTag": _b64(16, 7),
        "ciphertext": _b64(8, 8),
        "aadSha256": sha256_digest(
            canonical_json_bytes(
                aad_for_context(
                    context=context,
                    direction="update_request",
                    client_ephemeral_public_key=client_public,
                )
            )
        ),
        "ownerSignerKeyId": "owner-p256-1",
        "readNonce": None,
    }
    parsed = CrmZkEncryptedFields.model_validate({**envelope, "ownerSignature": _b64(64, 9)})
    der = private.sign(canonical_json_bytes(parsed.unsigned_dict()), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    envelope["ownerSignature"] = base64.b64encode(
        r.to_bytes(32, "big") + s.to_bytes(32, "big")
    ).decode("ascii")
    return envelope, public


def test_crm_zk_request_signature_and_aad_bind_the_server_context() -> None:
    context = _context()
    envelope, public_key = _signed_envelope(context)

    validated = validate_encrypted_fields(
        encrypted_fields=envelope,
        context=context,
        owner_signing_public_key_spki=public_key,
        now_ms=1,
    )

    assert validated.digest().startswith("sha256:")
    assert validated.context_digest == sha256_digest(canonical_json_bytes(context))


def test_crm_zk_rejects_tampered_context_or_ciphertext_signature() -> None:
    context = _context()
    envelope, public_key = _signed_envelope(context)
    envelope["ciphertext"] = _b64(8, 99)

    with pytest.raises(CrmZkValidationError, match="owner_signature_invalid"):
        validate_encrypted_fields(
            encrypted_fields=envelope,
            context=context,
            owner_signing_public_key_spki=public_key,
            now_ms=1,
        )


def test_canonical_json_is_stable_and_ascii_escaped() -> None:
    assert canonical_json_bytes({"z": "é", "a": [2, 1]}) == b'{"a":[2,1],"z":"\\u00e9"}'


def test_context_reload_excludes_durable_owner_metadata_from_the_signed_model() -> None:
    context = _context()
    store = InMemoryConnectedSystemIntentStore()
    store.create_zk_context(
        {
            "context_id": context.context_id,
            "user_id": "owner",
            "system_id": context.system_id,
            "action": context.operation,
            "object_type": context.object_type,
            "record_id": context.record_id,
            "field_names": list(context.field_names),
            "schema_fingerprint": context.schema_fingerprint,
            "configuration_revision": context.configuration_revision,
            "recipient_key_id": context.recipient_key_id,
            "recipient_key_fingerprint": context.recipient_key_fingerprint,
            "client_operation_id": context.client_operation_id,
            "context_digest": sha256_digest(canonical_json_bytes(context)),
            "context_signer_key_id": "backend-p256-1",
            "context_signature": _b64(64),
            "expires_at_ms": context.expires_at_ms,
        }
    )
    service = ConnectedSystemsService(store=store, registry=(SALESFORCE_CRM_SYSTEM,))

    stored, reloaded = service._load_crm_zk_context(
        user_id="owner",
        system_id=context.system_id,
        context_id=context.context_id,
        operation="update",
    )

    assert stored["record_id"] == "backend-bound-record"
    assert reloaded == context


@pytest.mark.asyncio
async def test_partner_payload_uses_registered_owner_public_key_without_crm_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = _context()
    envelope_data, owner_public_key_spki = _signed_envelope(context)
    envelope = CrmZkEncryptedFields.model_validate(envelope_data)
    system = connected_systems_service.ConnectedSystemDefinition(
        system_id=context.system_id,
        display_name="Test CRM",
        customer_display_name="Test CRM",
        system_type="CRM",
        system_name="Test CRM",
        target="not-tool-input",
        object_type_default=context.object_type,
        transport="external_crm_streamable_mcp",
        transport_endpoint="registry://crm-zk-test",
        registry_source="enterprise_crm_registry",
        tool_catalog=({"operation": "read", "crmZkToolName": "read-crm-record-zk"},),
        crm_zk_v1_enabled=True,
        mulesoft_connector_ref="mulesoft:crm-zk-test",
        crm_zk_recipient_key={
            "keyId": context.recipient_key_id,
            "publicKey": _b64(32, 7),
            "publicKeyFingerprint": context.recipient_key_fingerprint,
            "responseSigningKeyId": "mulesoft-response-p256-1",
            "responseSigningPublicKey": "unused-in-this-transport-test",
            "responseSigningKeyFingerprint": "sha256:" + "e" * 64,
        },
    )
    service = ConnectedSystemsService(
        store=InMemoryConnectedSystemIntentStore(), registry=(system,)
    )
    captured: dict[str, object] = {}

    async def fake_call_operation(**kwargs):
        captured.update(kwargs)
        return {"payload": {"encryptedFields": {"opaque": "partner-response"}}}

    monkeypatch.setattr(service, "_call_operation", fake_call_operation)
    monkeypatch.setattr(
        connected_systems_service,
        "validate_partner_response_envelope",
        lambda **_: SimpleNamespace(
            profile="crm-zk.v1",
            direction="read_response",
            context_id=context.context_id,
            context_digest=sha256_digest(canonical_json_bytes(context)),
            envelope_id="czkr_" + "r" * 32,
            client_operation_id=context.client_operation_id,
            expires_at_ms=context.expires_at_ms,
            recipient_client_ephemeral_public_key=envelope.client_ephemeral_public_key,
            wrapped_payload_key=_b64(32, 1),
            wrapped_key_iv=_b64(12, 1),
            wrapped_key_tag=_b64(16, 1),
            payload_iv=_b64(12, 1),
            payload_tag=_b64(16, 1),
            ciphertext=_b64(8, 1),
            aad_sha256="sha256:" + "f" * 64,
            response_signer_key_id="mulesoft-response-p256-1",
            response_signature=_b64(64, 1),
        ),
    )

    await service._call_crm_zk_partner(
        system=system,
        operation="read",
        binding=context,
        stored_context={
            "context_digest": sha256_digest(canonical_json_bytes(context)),
            "context_signer_key_id": "hussh-context-p256-1",
            "context_signature": _b64(64, 1),
        },
        envelope=envelope,
        owner_signing_public_key_spki=owner_public_key_spki,
    )

    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["connectorRef"] == "mulesoft:crm-zk-test"
    assert payload["ownerSignerPublicKeySpki"] == owner_public_key_spki
    assert not (
        {"target", "crmBaseUrl", "crmMcpEndpoint", "clientId", "clientSecret", "crmTokenUrl"}
        & payload.keys()
    )
