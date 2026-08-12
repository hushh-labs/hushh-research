"""Contract checks for the isolated CRM encrypted UAT profile."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path

import pytest
from pydantic import ValidationError

from hushh_mcp.services.connected_systems_service import (
    ConnectedSystemBlockedError,
    ConnectedSystemDefinition,
    ConnectedSystemsError,
    ConnectedSystemsService,
    InMemoryConnectedSystemIntentStore,
    _normalize_crm_zk_uat_ack,
)
from hushh_mcp.services.crm_zk_uat_v1 import (
    CRM_ZK_UAT_V1_PROFILE,
    CrmZkUatEncryptedFields,
    CrmZkUatValidationError,
    validate_crm_zk_uat_envelope,
)

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _uat_runtime(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")


def _b64(size: int, byte: int = 1) -> str:
    return base64.b64encode(bytes([byte]) * size).decode("ascii")


def _fingerprint(byte: int = 1) -> str:
    return f"sha256:{hashlib.sha256(bytes([byte]) * 32).hexdigest()}"


def _envelope(*, direction: str = "update_request", key_id: str = "mulesoft-uat-1") -> dict:
    return {
        "profile": CRM_ZK_UAT_V1_PROFILE,
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


def test_uat_envelope_accepts_only_exact_binary_shape_key_and_direction() -> None:
    value = _envelope()
    parsed = validate_crm_zk_uat_envelope(
        value,
        expected_direction="update_request",
        expected_key_id="mulesoft-uat-1",
        now_ms=value["expiresAtMs"] - 1,
    )
    assert parsed.digest().startswith("sha256:")
    assert parsed.model_dump(mode="json", by_alias=True)["clientPublicKey"] == _b64(32, 2)

    wrong_key = _envelope(key_id="untrusted")
    with pytest.raises(CrmZkUatValidationError, match="recipient_key_mismatch"):
        validate_crm_zk_uat_envelope(
            wrong_key,
            expected_direction="update_request",
            expected_key_id="mulesoft-uat-1",
            now_ms=wrong_key["expiresAtMs"] - 1,
        )


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
def test_uat_envelope_rejects_malformed_crypto_fields(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        CrmZkUatEncryptedFields.model_validate({**_envelope(), field: value})


@pytest.mark.asyncio
async def test_uat_partner_call_replaces_registry_arguments_and_sends_no_configuration(
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
                "crmZkUatToolName": "update-crm-record-zk-uat",
            },
        ),
        transport_tool_arguments={"connectorRef": "must-not-be-merged"},
        crm_zk_uat_v1_enabled=True,
        crm_zk_uat_recipient_key={
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
    payload = {
        "profile": CRM_ZK_UAT_V1_PROFILE,
        "operation": "update",
        "objectType": "Contact",
        "id": "backend-bound",
        "fieldNames": ["Title"],
        "encryptedFields": _envelope(),
    }
    await service._call_crm_zk_uat_partner(system=system, operation="update", payload=payload)

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


def test_uat_profile_migration_is_release_managed_and_default_off() -> None:
    migration = (ROOT / "db/migrations/143_crm_zk_uat_v1.sql").read_text("utf-8")
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text("utf-8"))

    assert "143_crm_zk_uat_v1.sql" in manifest["ordered_migrations"]
    assert "crm_zk_uat_v1_enabled BOOLEAN NOT NULL DEFAULT FALSE" in migration
    assert "NOT (crm_zk_v1_enabled AND crm_zk_uat_v1_enabled)" in migration
    assert "environment = 'sandbox'" in migration
    assert "crm-zk-uat.v1" in migration


def test_uat_profile_fails_closed_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
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
                "crmZkUatToolName": "read-crm-record-zk-uat",
            },
        ),
        crm_zk_uat_v1_enabled=True,
        crm_zk_uat_recipient_key={
            "keyId": "mulesoft-uat-1",
            "publicKey": _b64(32),
            "publicKeyFingerprint": _fingerprint(),
            "environment": "sandbox",
        },
    )

    assert system.crm_zk_uat_ready("read") is False


@pytest.mark.asyncio
async def test_uat_update_is_ciphertext_only_and_approval_is_idempotent(
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
                "crmZkUatToolName": "read-crm-record-zk-uat",
            },
            {
                "operation": "update",
                "name": "update-crm-record",
                "crmZkUatToolName": "update-crm-record-zk-uat",
            },
        ),
        crm_zk_uat_v1_enabled=True,
        crm_zk_uat_recipient_key={
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
    monkeypatch.setattr(service, "_call_crm_zk_uat_partner", fake_partner)

    prepared = await service.create_crm_zk_uat_update_intent(
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
        await service.approve_crm_zk_uat_intent(
            user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
        )
    retryable = store.get_intent(
        user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
    )
    assert retryable is not None and retryable["status"] == "approved"
    first = await service.approve_crm_zk_uat_intent(
        user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
    )
    second = await service.approve_crm_zk_uat_intent(
        user_id="owner-1", system_id="crm-uat", intent_id=prepared["intentId"]
    )
    assert first["status"] == second["status"] == "succeeded"
    assert len(partner_calls) == 2
    assert (
        partner_calls[0]["payload"]["clientOperationId"]
        == partner_calls[1]["payload"]["clientOperationId"]
    )
    assert partner_calls[1]["payload"]["id"] == "backend-bound-record"
    assert partner_calls[1]["payload"]["fieldNames"] == ["Title"]


@pytest.mark.parametrize(
    "unsafe_ack",
    [
        {"status": "Jane Doe", "accepted": True},
        {"status": "accepted", "accepted": True, "operationId": "Jane Doe"},
        {"status": "accepted", "accepted": "true"},
        {"status": "accepted", "accepted": True, "idempotent": "true"},
    ],
)
def test_uat_ack_rejects_plaintext_smuggling(unsafe_ack: dict) -> None:
    with pytest.raises(ConnectedSystemsError):
        _normalize_crm_zk_uat_ack(unsafe_ack)


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
            "intent_id": "intent-zk-uat",
            "user_id": "owner-1",
            "system_id": "crm-uat",
            "status": "pending",
            "delivery_mode": CRM_ZK_UAT_V1_PROFILE,
        }
    )
    service = ConnectedSystemsService(registry=(system,), store=store)

    with pytest.raises(ConnectedSystemsError, match="standard CRM intents"):
        await service.approve_intent(
            user_id="owner-1", system_id="crm-uat", intent_id="intent-zk-uat"
        )
    stored = store.get_intent(user_id="owner-1", system_id="crm-uat", intent_id="intent-zk-uat")
    assert stored is not None and stored["status"] == "pending"


@pytest.mark.asyncio
async def test_uat_profile_rejects_legacy_verified_search_before_loading_plaintext() -> None:
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
        tool_catalog=({"operation": "read", "name": "read-crm-record"},),
        crm_zk_uat_v1_enabled=True,
        crm_zk_uat_recipient_key={
            "keyId": "mulesoft-uat-1",
            "publicKey": _b64(32),
            "environment": "sandbox",
        },
    )

    class ExplodingIdentity:
        async def get_actor_identity(self, **_kwargs):
            raise AssertionError("legacy identity lookup must not run")

    service = ConnectedSystemsService(
        registry=(system,),
        store=InMemoryConnectedSystemIntentStore(),
        identity_service=ExplodingIdentity(),
    )
    with pytest.raises(ConnectedSystemBlockedError, match="encrypted UAT search"):
        await service.search_verified_record(
            user_id="owner-1",
            system_id="crm-uat",
            object_type="Contact",
            return_fields=["Title"],
        )
