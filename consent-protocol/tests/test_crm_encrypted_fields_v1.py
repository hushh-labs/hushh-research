"""Contract checks for the external CRM encrypted-fields profile."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path

import pytest
from pydantic import ValidationError

from hushh_mcp.services.connected_systems_service import (
    ConnectedSystemDefinition,
    ConnectedSystemsError,
    ConnectedSystemsService,
    ExternalCrmStreamableMcpAdapter,
    InMemoryConnectedSystemIntentStore,
    _normalize_crm_encrypted_fields_ack,
)
from hushh_mcp.services.crm_encrypted_fields_v1 import (
    CRM_ENCRYPTED_FIELDS_V1_PROFILE,
    CrmEncryptedFields,
    CrmEncryptedFieldsValidationError,
    validate_crm_encrypted_fields_envelope,
    validate_crm_encrypted_fields_recipient_key,
)

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _encrypted_fields_runtime(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")


def _b64(size: int, byte: int = 1) -> str:
    return base64.b64encode(bytes([byte]) * size).decode("ascii")


def _fingerprint(byte: int = 1) -> str:
    return f"sha256:{hashlib.sha256(bytes([byte]) * 32).hexdigest()}"


def _envelope(*, direction: str = "update_request", key_id: str = "mulesoft-uat-1") -> dict:
    return {
        "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
        "direction": direction,
        "recipientKeyId": key_id,
        "clientOperationId": "czku_" + "a" * 32,
        "expiresAtMs": int(time.time() * 1000) + 4 * 60 * 1000,
        "clientPublicKey": _b64(32, 2),
        "wrappedPayloadKey": _b64(32, 3),
        "wrappedKeyIv": _b64(12, 4),
        "wrappedKeyTag": _b64(16, 5),
        "payloadIv": _b64(12, 6),
        "payloadTag": _b64(16, 7),
        "ciphertext": _b64(8, 8),
    }


def test_encrypted_fields_envelope_accepts_only_exact_binary_shape_key_and_direction() -> None:
    value = _envelope()
    parsed = validate_crm_encrypted_fields_envelope(
        value,
        expected_direction="update_request",
        expected_key_id="mulesoft-uat-1",
        now_ms=value["expiresAtMs"] - 1,
    )
    assert parsed.digest().startswith("sha256:")
    assert parsed.model_dump(mode="json", by_alias=True)["clientPublicKey"] == _b64(32, 2)

    wrong_key = _envelope(key_id="untrusted")
    with pytest.raises(CrmEncryptedFieldsValidationError, match="recipient_key_mismatch"):
        validate_crm_encrypted_fields_envelope(
            wrong_key,
            expected_direction="update_request",
            expected_key_id="mulesoft-uat-1",
            now_ms=wrong_key["expiresAtMs"] - 1,
        )


def test_encrypted_fields_recipient_key_requires_a_matching_fingerprint() -> None:
    key = {
        "keyId": "mulesoft-uat-1",
        "publicKey": _b64(32),
        "publicKeyFingerprint": _fingerprint(),
    }
    validate_crm_encrypted_fields_recipient_key(key)

    with pytest.raises(CrmEncryptedFieldsValidationError, match="recipient_key_mismatch"):
        validate_crm_encrypted_fields_recipient_key({**key, "publicKeyFingerprint": "sha256:wrong"})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("clientPublicKey", _b64(31)),
        ("wrappedPayloadKey", _b64(31)),
        ("wrappedKeyIv", _b64(11)),
        ("wrappedKeyTag", _b64(15)),
        ("payloadIv", _b64(13)),
        ("payloadTag", _b64(15)),
        ("ciphertext", "not-base64"),
    ],
)
def test_encrypted_fields_envelope_rejects_malformed_crypto_fields(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        CrmEncryptedFields.model_validate({**_envelope(), field: value})


@pytest.mark.asyncio
async def test_encrypted_fields_partner_call_replaces_registry_arguments_and_sends_no_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    system = ConnectedSystemDefinition(
        system_id="crm-uat",
        display_name="CRM UAT",
        customer_display_name="CRM UAT",
        system_type="CRM",
        system_name="CRM",
        target="must-not-leave-hussh",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="registry://crm-uat",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {
                "operation": "update",
                "name": "update-crm-record",
                "crmEncryptedFieldsToolName": "update-crm-record-encrypted",
            },
        ),
        transport_tool_arguments={"legacyArgument": "must-not-be-merged"},
        crm_encrypted_fields_v1_enabled=True,
        crm_encrypted_fields_recipient_key={
            "keyId": "mulesoft-uat-1",
            "publicKey": _b64(32),
            "publicKeyFingerprint": _fingerprint(),
            "environment": "sandbox",
        },
    )
    service = ConnectedSystemsService(
        registry=(system,), store=InMemoryConnectedSystemIntentStore()
    )
    captured: dict = {}

    async def fake_call_operation(**kwargs):
        captured.update(kwargs)
        return {"isError": False, "payload": {"status": "accepted", "accepted": True}}

    monkeypatch.setattr(service, "_call_operation", fake_call_operation)
    wire_envelope = CrmEncryptedFields.model_validate(_envelope()).mulesoft_payload()
    payload = {
        "objectType": "Contact",
        "id": "backend-bound",
        "encryptedFields": wire_envelope,
    }
    await service._call_crm_encrypted_fields_partner(
        system=system, operation="update", payload=payload
    )

    assert captured["replace_tool_arguments"] is True
    assert captured["payload"] == payload
    assert not (
        {
            "connectorRef",
            "target",
            "crmBaseUrl",
            "crmMcpEndpoint",
            "clientId",
            "clientSecret",
            "crmTokenUrl",
        }
        & captured["payload"].keys()
    )


def test_encrypted_fields_profile_migration_is_release_managed_and_default_off() -> None:
    migration = (ROOT / "db/migrations/145_crm_encrypted_fields_v1.sql").read_text("utf-8")
    retirement = (ROOT / "db/migrations/147_retire_crm_zk_runtime_profiles.sql").read_text("utf-8")
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text("utf-8"))

    assert "145_crm_encrypted_fields_v1.sql" in manifest["ordered_migrations"]
    assert "147_retire_crm_zk_runtime_profiles.sql" in manifest["ordered_migrations"]
    assert "crm_encrypted_fields_v1_enabled BOOLEAN NOT NULL DEFAULT FALSE" in migration
    assert "environment = 'sandbox'" in migration
    assert "crm-encrypted-fields.v1" in migration
    assert "enterprise_crm_registry_legacy_crm_zk_profiles_retired" in retirement
    assert "non-terminal legacy encrypted intents" in retirement


def test_encrypted_call_keeps_only_registered_replacement_connection_arguments() -> None:
    adapter = ExternalCrmStreamableMcpAdapter(
        tool_arguments={"legacyArgument": "discarded"},
        replacement_tool_arguments={
            "crmBaseUrl": "https://crm.example.invalid",
            "clientSecret": "server-only",
        },
    )

    arguments = adapter._tool_arguments_for_call(
        {"encryptedFields": {"ciphertext": "opaque"}},
        replace_tool_arguments=True,
    )

    assert arguments == {
        "crmBaseUrl": "https://crm.example.invalid",
        "clientSecret": "server-only",
        "encryptedFields": {"ciphertext": "opaque"},
    }
    assert "legacyArgument" not in arguments


def test_mulesoft_response_is_bound_to_hussh_request_metadata() -> None:
    request = CrmEncryptedFields.model_validate(_envelope(direction="read_request"))
    response_wire = {
        **request.mulesoft_payload(),
        "ciphertext": _b64(8, 9),
    }

    response = request.with_mulesoft_response(response_wire)

    assert response.direction == "read_response"
    assert response.recipient_key_id == request.recipient_key_id
    assert response.client_operation_id == request.client_operation_id
    assert response.expires_at_ms == request.expires_at_ms
    assert response.ciphertext == _b64(8, 9)

    with pytest.raises(CrmEncryptedFieldsValidationError):
        request.with_mulesoft_response({**response_wire, "unexpected": "value"})


def test_encrypted_fields_profile_fails_closed_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    system = ConnectedSystemDefinition(
        system_id="crm-uat",
        display_name="CRM UAT",
        customer_display_name="CRM UAT",
        system_type="CRM",
        system_name="CRM",
        target="private-target",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="registry://crm-uat",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {
                "operation": "read",
                "name": "read-crm-record",
                "crmEncryptedFieldsToolName": "read-crm-record-encrypted",
            },
        ),
        crm_encrypted_fields_v1_enabled=True,
        crm_encrypted_fields_recipient_key={
            "keyId": "mulesoft-uat-1",
            "publicKey": _b64(32),
            "publicKeyFingerprint": _fingerprint(),
            "environment": "sandbox",
        },
    )

    assert system.crm_encrypted_fields_ready("read") is False


def test_registry_owned_operation_objects_keep_person_account_and_contact_bindings_separate() -> (
    None
):
    system = ConnectedSystemDefinition(
        system_id="crm-person-account",
        display_name="Hushh",
        customer_display_name="Hushh",
        system_type="Salesforce",
        system_name="Salesforce",
        target="Hushh",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="registry://crm-person-account",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {"operation": "create", "name": "create-crm-record", "objectType": "Account"},
            {"operation": "read", "name": "read-crm-record", "objectType": "Contact"},
            {"operation": "update", "name": "update-crm-record", "objectType": "Contact"},
        ),
    )
    store = InMemoryConnectedSystemIntentStore()
    store.upsert_binding(
        {
            "binding_id": "account-binding",
            "user_id": "owner-1",
            "system_id": system.system_id,
            "target": "Hushh",
            "object_type": "Account",
            "record_id": "001-person-account",
            "created_intent_id": "create-account",
            "last_intent_id": "create-account",
        }
    )
    service = ConnectedSystemsService(registry=(system,), store=store)

    assert system.object_type_for_operation("create") == "Account"
    assert system.object_type_for_operation("update") == "Contact"
    with pytest.raises(ConnectedSystemsError, match="Link your CRM record"):
        service._require_bound_record_id(
            user_id="owner-1",
            system_id=system.system_id,
            object_type=system.object_type_for_operation("update"),
        )


def test_registry_summary_exposes_safe_per_operation_object_types() -> None:
    system = ConnectedSystemDefinition(
        system_id="crm-person-account",
        display_name="Hushh",
        customer_display_name="Hushh",
        system_type="Salesforce",
        system_name="Salesforce",
        target="Hushh",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="registry://crm-person-account",
        registry_source="test",
        tool_catalog=(
            {"operation": "schema", "name": "object-schema", "objectType": "Contact"},
            {"operation": "create", "name": "create-crm-record", "objectType": "Account"},
            {"operation": "read", "name": "read-crm-record", "objectType": "Contact"},
            {"operation": "update", "name": "update-crm-record", "objectType": "Contact"},
            {"operation": "delete", "name": "delete-crm-record", "objectType": "Contact"},
        ),
    )

    summary = system.to_summary(endpoint_configured=True, delete_enabled=True)

    assert summary["operationObjectTypes"] == {
        "schema": "Contact",
        "read": "Contact",
        "create": "Account",
        "update": "Contact",
        "delete": "Contact",
    }
    assert "record_id" not in json.dumps(summary)


@pytest.mark.asyncio
async def test_encrypted_fields_update_is_ciphertext_only_and_approval_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    system = ConnectedSystemDefinition(
        system_id="crm-uat",
        display_name="CRM UAT",
        customer_display_name="CRM UAT",
        system_type="CRM",
        system_name="CRM",
        target="private-target",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="registry://crm-uat",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {"operation": "schema", "name": "object-schema"},
            {
                "operation": "read",
                "name": "read-crm-record",
                "crmEncryptedFieldsToolName": "read-crm-record",
            },
            {
                "operation": "update",
                "name": "update-crm-record",
                "crmEncryptedFieldsToolName": "update-crm-record",
            },
        ),
        crm_encrypted_fields_v1_enabled=True,
        crm_encrypted_fields_recipient_key={
            "keyId": "mulesoft-uat-1",
            "publicKey": _b64(32),
            "publicKeyFingerprint": _fingerprint(),
            "environment": "sandbox",
        },
    )
    store = InMemoryConnectedSystemIntentStore()
    store.upsert_binding(
        {
            "binding_id": "binding-1",
            "user_id": "owner-1",
            "system_id": "crm-uat",
            "target": "private-target",
            "object_type": "Contact",
            "record_id": "backend-bound-record",
            "created_intent_id": None,
            "last_intent_id": None,
        }
    )
    service = ConnectedSystemsService(registry=(system,), store=store)

    async def fake_schema(**_kwargs):
        return {
            "objectType": "Contact",
            "effectiveActions": {"read": True, "update": True},
            "fields": [
                {
                    "key": "Title",
                    "readable": True,
                    "updateable": True,
                    "writable": True,
                    "immutable": False,
                }
            ],
        }

    partner_calls: list[dict] = []

    async def fake_partner(**kwargs):
        partner_calls.append(kwargs)
        if len(partner_calls) == 1:
            raise ConnectedSystemsError("ack lost", code="PARTNER_ACK_LOST", status_code=502)
        return {
            "isError": False,
            "payload": {"status": "accepted", "accepted": True, "operationId": "op-1"},
        }

    monkeypatch.setattr(service, "get_schema", fake_schema)
    monkeypatch.setattr(service, "_call_crm_encrypted_fields_partner", fake_partner)

    prepared = await service.create_encrypted_fields_update_intent(
        user_id="owner-1",
        system_id="crm-uat",
        object_type="Contact",
        field_names=["Title"],
        encrypted_fields=_envelope(),
        locked_field_names=set(),
    )
    stored = store.get_intent(
        user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
    )
    assert stored is not None
    assert stored["request_payload"] == {}
    assert stored["readback_payload"] == {}
    assert stored["encrypted_fields"]["ciphertext"] == _b64(8, 8)
    assert "additionalFields" not in str(stored)

    with pytest.raises(ConnectedSystemsError, match="ack lost"):
        await service.approve_encrypted_fields_intent(
            user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
        )
    retryable = store.get_intent(
        user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
    )
    assert retryable is not None and retryable["status"] == "approved"
    first = await service.approve_encrypted_fields_intent(
        user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
    )
    second = await service.approve_encrypted_fields_intent(
        user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
    )
    assert first["status"] == second["status"] == "succeeded"
    assert len(partner_calls) == 2
    assert partner_calls[0]["payload"] == partner_calls[1]["payload"]
    assert partner_calls[1]["payload"]["id"] == "backend-bound-record"
    assert set(partner_calls[1]["payload"]) == {"objectType", "id", "encryptedFields"}
    assert partner_calls[1]["payload"]["encryptedFields"]["client_public_key"] == _b64(32, 2)
    assert "clientPublicKey" not in partner_calls[1]["payload"]["encryptedFields"]
    assert set(partner_calls[1]["payload"]["encryptedFields"]) == {
        "client_public_key",
        "wrapped_payload_key",
        "wrapped_key_iv",
        "wrapped_key_tag",
        "payload_iv",
        "payload_tag",
        "ciphertext",
    }


@pytest.mark.parametrize(
    "unsafe_ack",
    [
        {"status": "Jane Doe", "accepted": True},
        {"status": "accepted", "accepted": True, "operationId": "Jane Doe"},
        {"status": "accepted", "accepted": "true"},
        {"status": "accepted", "accepted": True, "idempotent": "true"},
    ],
)
def test_encrypted_fields_ack_rejects_plaintext_smuggling(unsafe_ack: dict) -> None:
    with pytest.raises(ConnectedSystemsError):
        _normalize_crm_encrypted_fields_ack(unsafe_ack)


@pytest.mark.asyncio
async def test_legacy_approval_cannot_consume_an_encrypted_intent() -> None:
    system = ConnectedSystemDefinition(
        system_id="crm-uat",
        display_name="CRM UAT",
        customer_display_name="CRM UAT",
        system_type="CRM",
        system_name="CRM",
        target="private-target",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="registry://crm-uat",
        registry_source="enterprise_crm_registry",
        tool_catalog=(),
    )
    store = InMemoryConnectedSystemIntentStore()
    store.create_intent(
        {
            "intent_id": "intent-encrypted",
            "user_id": "owner-1",
            "system_id": "crm-uat",
            "status": "pending",
            "delivery_mode": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
        }
    )
    service = ConnectedSystemsService(registry=(system,), store=store)

    with pytest.raises(ConnectedSystemsError, match="standard CRM intents"):
        await service.approve_intent(
            user_id="owner-1", system_id="crm-uat", intent_id="intent-encrypted"
        )
    stored = store.get_intent(user_id="owner-1", system_id="crm-uat", intent_id="intent-encrypted")
    assert stored is not None and stored["status"] == "pending"
