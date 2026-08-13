from __future__ import annotations

import base64
import hashlib
import json

import pytest

from hushh_mcp.services.crm_registry_descriptor import (
    CrmRegistryDescriptorError,
    load_and_validate_descriptor,
    redacted_summary,
)


def _descriptor(*, crm_id: str = "crm_alpha", read_only: bool = True) -> dict:
    operations = {
        "schema": {
            "toolName": "describe-person",
            "responseContract": {
                "version": "crm-primary-object-schema.v1",
                "fieldsPath": ["payload", "objects", 0, "fields"],
                "objectPath": ["payload", "objects", 0],
            },
        },
        "read": {
            "toolName": "find-person",
            "responseContract": {
                "version": "crm-record-collection.v1",
                "recordsPath": ["payload", "records"],
                "recordIdPath": ["id"],
            },
        },
    }
    capabilities = ["schema", "read"]
    probe = {"read": {"searchFields": {"Email": "fixture@example.invalid"}}}
    if not read_only:
        capabilities.extend(["create", "update", "delete"])
        operations.update(
            {
                "create": {
                    "toolName": "create-person",
                    "responseContract": {
                        "version": "crm-mutation-result.v1",
                        "successPolicy": "mcp_is_error_false",
                        "recordIdPath": ["payload", "id"],
                    },
                },
                "update": {
                    "toolName": "update-person",
                    "responseContract": {
                        "version": "crm-mutation-result.v1",
                        "successPolicy": "mcp_is_error_false",
                    },
                },
                "delete": {
                    "toolName": "delete-person",
                    "responseContract": {
                        "version": "crm-mutation-result.v1",
                        "successPolicy": "mcp_is_error_false",
                    },
                },
            }
        )
        probe = {
            "lifecycle": {
                "create": {"recordFields": {"LastName": "Hussh Fixture"}},
                "read": {"id": "{{recordId}}"},
                "update": {"id": "{{recordId}}", "recordFields": {"LastName": "Updated"}},
                "delete": {"id": "{{recordId}}"},
            }
        }
    return {
        "version": "crm-registry.v1",
        "crmId": crm_id,
        "displayName": "Alpha CRM",
        "crmType": "Example",
        "environment": "sandbox",
        "primaryObject": "Person",
        "baseUrl": "https://crm.example.invalid",
        "mcpEndpoint": "https://gateway.example.invalid/mcp",
        "credentials": {
            "clientIdEnv": "CRM_ALPHA_CLIENT_ID",
            "clientSecretEnv": "CRM_ALPHA_CLIENT_SECRET",
        },
        "capabilities": capabilities,
        "operations": operations,
        "probe": probe,
    }


def _recipient_key() -> dict[str, str]:
    public_key = base64.b64encode(bytes([7]) * 32).decode("ascii")
    return {
        "keyId": "mulesoft-sandbox-key-1",
        "publicKey": public_key,
        "publicKeyFingerprint": f"sha256:{hashlib.sha256(bytes([7]) * 32).hexdigest()}",
    }


@pytest.mark.parametrize("read_only", [True, False])
def test_descriptor_validates_structurally_different_capability_sets(
    tmp_path, monkeypatch, read_only
):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "runtime-only-id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "runtime-only-secret")
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(_descriptor(read_only=read_only)))

    descriptor = load_and_validate_descriptor(path)
    summary = redacted_summary(descriptor)

    assert descriptor.crm_id == "crm_alpha"
    assert summary["credentialsPresent"] is True
    assert "runtime-only" not in json.dumps(summary)


def test_descriptor_fails_closed_when_operation_contract_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "secret")
    raw = _descriptor()
    raw["operations"]["read"].pop("responseContract")
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(raw))

    with pytest.raises(CrmRegistryDescriptorError, match="read.responseContract"):
        load_and_validate_descriptor(path)


def test_descriptor_requires_explicit_cross_object_probe_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "secret")
    raw = _descriptor(read_only=False)
    raw["operations"]["create"]["objectType"] = "Account"
    raw["operations"]["read"]["objectType"] = "Contact"
    raw["operations"]["update"]["objectType"] = "Contact"
    raw["operations"]["delete"]["objectType"] = "Contact"
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(raw))

    with pytest.raises(CrmRegistryDescriptorError, match="Person Account create id"):
        load_and_validate_descriptor(path)

    raw["probe"] = {"mode": "cross-object-bound-lifecycle.v1"}
    path.write_text(json.dumps(raw))
    assert load_and_validate_descriptor(path).crm_id == "crm_alpha"


def test_dynamic_registry_requires_external_gateway_and_crm_connection(tmp_path, monkeypatch):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "secret")
    raw = _descriptor()
    raw["authHeaderStyle"] = "bearer"
    raw["connectionMode"] = "dynamic_registry"
    raw["gatewayCredentialProfile"] = "external_crm"
    raw["crmConnection"] = {
        "baseUrl": "https://api.salesforce.example/platform",
        "mcpEndpoint": "/mcp/v1/sandbox/platform/sobject-all",
        "tokenUrl": "https://salesforce.example/services/oauth2/token",
    }
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(raw))

    descriptor = load_and_validate_descriptor(path)
    summary = redacted_summary(descriptor)

    assert descriptor.credential_env_names == (
        "CRM_ALPHA_CLIENT_ID",
        "CRM_ALPHA_CLIENT_SECRET",
    )
    assert summary["gatewayCredentialProfile"] == "external_crm"
    assert summary["connectionMode"] == "dynamic_registry"


def test_dynamic_registry_rejects_missing_crm_connection(tmp_path, monkeypatch):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "secret")
    raw = _descriptor()
    raw["authHeaderStyle"] = "bearer"
    raw["connectionMode"] = "dynamic_registry"
    raw["gatewayCredentialProfile"] = "external_crm"
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(raw))

    with pytest.raises(CrmRegistryDescriptorError, match="crmConnection is required"):
        load_and_validate_descriptor(path)


def test_encrypted_fields_can_reuse_standard_read_and_update_tool_names(tmp_path, monkeypatch):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "secret")
    raw = _descriptor(read_only=False)
    raw["encryptedFields"] = {
        "enabled": True,
        "recipientKey": _recipient_key(),
        "tools": {
            "read": "find-person",
            "update": "update-person",
        },
    }
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(raw))

    descriptor = load_and_validate_descriptor(path)

    assert descriptor.required_mcp_tool_names == (
        "create-person",
        "delete-person",
        "describe-person",
        "find-person",
        "update-person",
    )


def test_encrypted_fields_rejects_undeclared_operation_aliases(tmp_path, monkeypatch):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "secret")
    raw = _descriptor(read_only=False)
    raw["encryptedFields"] = {
        "enabled": True,
        "recipientKey": _recipient_key(),
        "tools": {
            "read": "find-person",
            "update": "update-person",
            "delete": "delete-person",
        },
    }
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(raw))

    with pytest.raises(CrmRegistryDescriptorError, match="only read and update"):
        load_and_validate_descriptor(path)


def test_encrypted_fields_rejects_a_key_and_fingerprint_mismatch(tmp_path, monkeypatch):
    monkeypatch.setenv("CRM_ALPHA_CLIENT_ID", "id")
    monkeypatch.setenv("CRM_ALPHA_CLIENT_SECRET", "secret")
    raw = _descriptor(read_only=False)
    raw["encryptedFields"] = {
        "enabled": True,
        "recipientKey": {**_recipient_key(), "publicKeyFingerprint": "sha256:wrong"},
        "tools": {"read": "find-person", "update": "update-person"},
    }
    path = tmp_path / "crm.json"
    path.write_text(json.dumps(raw))

    with pytest.raises(CrmRegistryDescriptorError, match="matching SHA-256 fingerprint"):
        load_and_validate_descriptor(path)
