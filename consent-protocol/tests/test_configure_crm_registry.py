from __future__ import annotations

import pytest

from hushh_mcp.services.connected_systems_service import ConnectedSystemDefinition
from hushh_mcp.services.crm_registry_descriptor import (
    CrmRegistryDescriptorError,
    ValidatedCrmRegistryDescriptor,
)
from scripts.ops.configure_crm_registry import (
    _probe_schema_object_types,
    _registry_kdf_parameters,
    _require_probe_coverage,
)


def test_cross_object_activation_probes_account_and_contact_schemas() -> None:
    definition = ConnectedSystemDefinition(
        system_id="crm_hussh",
        display_name="Hussh",
        customer_display_name="Hussh",
        system_type="Salesforce",
        system_name="Salesforce",
        target="Hussh",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://gateway.example.invalid/mcp",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {"operation": "schema", "name": "object-schema", "objectType": "Contact"},
            {"operation": "create", "name": "create-crm-record", "objectType": "Account"},
            {"operation": "read", "name": "read-crm-record", "objectType": "Contact"},
            {"operation": "update", "name": "update-crm-record", "objectType": "Contact"},
            {"operation": "delete", "name": "delete-crm-record", "objectType": "Contact"},
        ),
    )

    assert _probe_schema_object_types(definition) == ("Contact", "Account")


def test_registry_kdf_parameters_are_resolved_for_row_persistence(monkeypatch) -> None:
    monkeypatch.setenv("CONNECTOR_KDF_SALT", "uat-registry-salt")
    monkeypatch.setenv("CONNECTOR_KDF_ITERATIONS", "70000")

    assert _registry_kdf_parameters() == ("uat-registry-salt", 70000)


def test_activation_rejects_partial_cross_object_probe() -> None:
    descriptor = ValidatedCrmRegistryDescriptor(
        raw={"capabilities": ["schema", "read", "create", "update", "delete"]},
        fingerprint="fixture",
        credential_env_names=(None, None),
    )

    with pytest.raises(CrmRegistryDescriptorError, match="create, delete, read, update"):
        _require_probe_coverage(descriptor, {"verifiedOperations": ["schema"]})


def test_activation_accepts_complete_probe_coverage() -> None:
    descriptor = ValidatedCrmRegistryDescriptor(
        raw={"capabilities": ["schema", "read"]},
        fingerprint="fixture",
        credential_env_names=(None, None),
    )

    _require_probe_coverage(descriptor, {"verifiedOperations": ["schema", "read"]})
