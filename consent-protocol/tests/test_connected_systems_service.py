from __future__ import annotations

import json

import pytest

from hushh_mcp.services.connected_systems_service import (
    CONNECTED_SYSTEM_SALESFORCE_ID,
    EXTERNAL_CRM_TOOL_CATALOG,
    REGISTRY_MCP_ENDPOINT,
    SALESFORCE_CRM_SYSTEM,
    ConnectedSystemBlockedError,
    ConnectedSystemConfigurationError,
    ConnectedSystemDefinition,
    ConnectedSystemNotFoundError,
    ConnectedSystemsService,
    ConnectedSystemValidationError,
    ExternalCrmStreamableMcpAdapter,
    InMemoryConnectedSystemIntentStore,
)


class FakeExternalCrmAdapter:
    configured = True

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.readback_records: list[dict] = [
            {
                "Id": "003gK00000demoQAA",
                "FirstName": "John",
                "LastName": "Doe",
                "Email": "doe.john@abc.com",
                "Phone": "1234567899",
                "Title": "VP Sales",
                "MailingCity": "Dallas",
            }
        ]

    async def object_schema(self, payload: dict) -> dict:
        self.calls.append(("object-schema", payload))
        return {
            "isError": False,
            "payload": {
                "fields": [
                    "Email",
                    "Phone",
                    {"name": "MobilePhone"},
                    {"apiName": "MailingCity"},
                    "Unsupported__c",
                ],
                "required": ["LastName"],
            },
        }

    async def read_record(self, payload: dict) -> dict:
        self.calls.append(("read-crm-record", payload))
        return {"isError": False, "payload": {"Contact": self.readback_records}}

    async def create_record(self, payload: dict) -> dict:
        self.calls.append(("create-crm-record", payload))
        return {"isError": False, "payload": {"id": "003gK00000demoQAA"}}

    async def update_record(self, payload: dict) -> dict:
        self.calls.append(("update-crm-record", payload))
        return {"isError": False, "payload": {"success": True}}

    async def delete_record(self, payload: dict) -> dict:
        self.calls.append(("delete-crm-record", payload))
        self.readback_records = []
        return {"isError": False, "payload": {"deleted": True}}


class GenericCrmAdapter:
    configured = True

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None, dict]] = []

    async def call_operation(self, *, operation, tool_name, endpoint, arguments, **_kwargs):
        self.calls.append((operation, tool_name, endpoint, arguments))
        if operation == "schema":
            return {
                "isError": False,
                "schema": {
                    "fields": [
                        {"name": "companyId", "identityField": True, "immutable": True},
                        {"name": "legalName", "required": True, "writable": True},
                        {"name": "domain", "required": True, "writable": True},
                        {"name": "tier", "writable": True},
                    ]
                },
            }
        return {"isError": False, "payload": {"id": "company-42"}}


class ContractMappedCrmAdapter:
    configured = True

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None, dict]] = []

    async def call_operation(self, *, operation, tool_name, endpoint, arguments, **_kwargs):
        self.calls.append((operation, tool_name, endpoint, arguments))
        if operation == "schema" and arguments["target"] == "Bluebird":
            return {
                "isError": False,
                "payload": {
                    "details": [
                        {
                            "apiName": "Account",
                            "label": "Account holder",
                            "fields": [
                                {
                                    "name": "externalId",
                                    "label": "External ID",
                                    "type": "string",
                                    "required": True,
                                    "readable": True,
                                    "identityField": True,
                                    "immutable": True,
                                    "createable": True,
                                    "updateable": False,
                                },
                                {
                                    "name": "publicName",
                                    "label": "Public name",
                                    "type": "string",
                                    "required": False,
                                    "readable": True,
                                    "identityField": False,
                                    "immutable": False,
                                    "createable": True,
                                    "updateable": True,
                                },
                            ],
                        }
                    ]
                },
            }
        if operation == "schema":
            return {
                "isError": False,
                "payload": {
                    "details": [
                        {
                            "fields": [
                                {"name": "candidateId", "label": "Candidate ID", "type": "string"}
                            ]
                        }
                    ]
                },
            }
        if operation == "read":
            return {
                "isError": False,
                "payload": {
                    "rows": [
                        {
                            "id": "blue-42",
                            "externalId": "external-42",
                            "publicName": "A. Example",
                            "privateNote": "must not be projected",
                        }
                    ]
                },
            }
        return {"isError": False, "payload": {"success": True, "id": "blue-42"}}


def enterprise_schema_contract() -> dict:
    return {
        "version": "crm-primary-object-schema.v1",
        "fieldsPath": ["payload", "details", 0, "fields"],
        "objectPath": ["payload", "details", 0],
        "requireFieldAccess": True,
    }


def enterprise_read_contract() -> dict:
    return {
        "version": "crm-record-collection.v1",
        "recordsPath": ["payload", "rows"],
        "recordIdPath": ["id"],
    }


def build_service(
    *, delete_enabled: bool = False
) -> tuple[ConnectedSystemsService, FakeExternalCrmAdapter]:
    adapter = FakeExternalCrmAdapter()
    service = ConnectedSystemsService(
        adapter=adapter,
        store=InMemoryConnectedSystemIntentStore(),
        delete_enabled=delete_enabled,
        registry=(SALESFORCE_CRM_SYSTEM,),
    )
    return service, adapter


@pytest.mark.asyncio
async def test_generic_crm_uses_its_registered_schema_tool_endpoint_and_field_contract():
    definition = ConnectedSystemDefinition(
        system_id="hubspot-companies",
        display_name="HubSpot",
        customer_display_name="HubSpot",
        system_type="HubSpot",
        system_name="HubSpot",
        target="HubSpot",
        object_type_default="Company",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://example.invalid/mcp",
        registry_source="test",
        tool_catalog=(
            {
                "name": "describe-company",
                "operation": "schema",
                "mcpEndpoint": "https://example.invalid/schema",
            },
            {
                "name": "create-company",
                "operation": "create",
                "mcpEndpoint": "https://example.invalid/create",
            },
            {
                "name": "update-company",
                "operation": "update",
                "mcpEndpoint": "https://example.invalid/update",
            },
            {
                "name": "read-company",
                "operation": "read",
                "mcpEndpoint": "https://example.invalid/read",
            },
        ),
        capabilities=frozenset({"schema", "read", "create", "update"}),
    )
    adapter = GenericCrmAdapter()
    service = ConnectedSystemsService(
        adapter=adapter,
        store=InMemoryConnectedSystemIntentStore(),
        registry=(definition,),
    )

    intent = await service.create_record_intent_from_fields(
        user_id="user-1",
        system_id=definition.system_id,
        object_type=None,
        record_fields={"legalName": "Acme", "domain": "acme.example", "tier": "gold"},
    )
    assert intent["status"] == "pending"
    assert adapter.calls[0][:3] == ("schema", "describe-company", "https://example.invalid/schema")
    approved = await service.approve_intent(
        user_id="user-1", system_id=definition.system_id, intent_id=intent["intentId"]
    )
    assert adapter.calls[1][:3] == ("create", "create-company", "https://example.invalid/create")
    assert adapter.calls[1][3]["recordFields"] == {
        "legalName": "Acme",
        "domain": "acme.example",
        "tier": "gold",
    }
    assert approved["status"] in {"succeeded", "partial"}

    with pytest.raises(ConnectedSystemValidationError, match="Field cannot be updated"):
        await service.update_record_intent_from_fields(
            user_id="user-1",
            system_id=definition.system_id,
            object_type=None,
            record_id="company-42",
            record_fields={"companyId": "other"},
        )


@pytest.mark.asyncio
async def test_registry_contracts_keep_two_crms_isolated_and_sanitize_read_records():
    bluebird = ConnectedSystemDefinition(
        system_id="bluebird-accounts",
        display_name="Bluebird",
        customer_display_name="Bluebird",
        system_type="Bluebird CRM",
        system_name="Accounts",
        target="Bluebird",
        object_type_default="Account",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://example.invalid/bluebird",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {
                "name": "bluebird-schema",
                "operation": "schema",
                "mcpEndpoint": "https://example.invalid/bluebird/schema",
                "responseContract": enterprise_schema_contract(),
            },
            {
                "name": "bluebird-read",
                "operation": "read",
                "mcpEndpoint": "https://example.invalid/bluebird/read",
                "responseContract": enterprise_read_contract(),
            },
        ),
        capabilities=frozenset({"schema", "read"}),
    )
    greenhouse = ConnectedSystemDefinition(
        system_id="greenhouse-candidates",
        display_name="Greenhouse",
        customer_display_name="Greenhouse",
        system_type="Greenhouse CRM",
        system_name="Candidates",
        target="Greenhouse",
        object_type_default="Candidate",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://example.invalid/greenhouse",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {
                "name": "greenhouse-schema",
                "operation": "schema",
                "mcpEndpoint": "https://example.invalid/greenhouse/schema",
                "responseContract": enterprise_schema_contract(),
            },
        ),
        capabilities=frozenset({"schema"}),
    )
    adapter = ContractMappedCrmAdapter()
    service = ConnectedSystemsService(
        adapter=adapter,
        store=InMemoryConnectedSystemIntentStore(),
        registry=(bluebird, greenhouse),
    )

    summaries = {row["systemId"]: row for row in service.list_systems()}
    assert summaries[bluebird.system_id]["supportedActions"] == {
        "schema": True,
        "read": True,
        "create": False,
        "update": False,
        "delete": False,
    }
    assert summaries[greenhouse.system_id]["supportedActions"]["read"] is False
    assert "responseContract" not in str(summaries)

    schema = await service.get_schema(system_id=bluebird.system_id)
    assert schema["objectMetadata"] == {"name": "Account", "label": "Account holder"}
    assert schema["schemaStatus"] == "ready"
    read = await service.read_record(
        user_id="user-1",
        system_id=bluebird.system_id,
        object_type=None,
        email=None,
        phone=None,
        search_fields={"externalId": "external-42"},
        return_fields=["publicName"],
    )
    assert read["records"] == [{"recordId": "blue-42", "fields": {"publicName": "A. Example"}}]
    assert adapter.calls[-1][:3] == (
        "read",
        "bluebird-read",
        "https://example.invalid/bluebird/read",
    )

    greenhouse_schema = await service.get_schema(system_id=greenhouse.system_id)
    assert greenhouse_schema["schemaStatus"] == "ready"
    assert greenhouse_schema["accessMetadata"] == "partial"


@pytest.mark.asyncio
async def test_registry_schema_catalogue_without_access_metadata_keeps_mapped_tools_available():
    class MetadataOnlyAdapter:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def call_operation(self, *, operation, **_kwargs):
            self.calls.append(operation)
            return {
                "isError": False,
                "payload": {
                    "details": [
                        {
                            "fields": [
                                {
                                    "name": "Email",
                                    "label": "Email",
                                    "type": "email",
                                    "required": False,
                                }
                            ]
                        }
                    ]
                },
            }

    definition = ConnectedSystemDefinition(
        system_id="metadata-only-crm",
        display_name="Metadata CRM",
        customer_display_name="Metadata CRM",
        system_type="CRM",
        system_name="CRM",
        target="Metadata CRM",
        object_type_default="Person",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://example.invalid/mcp",
        registry_source="enterprise_crm_registry",
        tool_catalog=(
            {
                "name": "describe-person",
                "operation": "schema",
                "mcpEndpoint": "https://example.invalid/mcp",
                "responseContract": {
                    "version": "crm-primary-object-schema.v1",
                    "fieldsPath": ["payload", "details", 0, "fields"],
                    "objectPath": ["payload", "details", 0],
                    "requireFieldAccess": True,
                },
            },
            {
                "name": "read-person",
                "operation": "read",
                "mcpEndpoint": "https://example.invalid/mcp",
            },
        ),
        capabilities=frozenset({"schema", "read"}),
    )
    adapter = MetadataOnlyAdapter()
    service = ConnectedSystemsService(
        adapter=adapter,
        store=InMemoryConnectedSystemIntentStore(),
        registry=(definition,),
    )

    schema = await service.get_schema(system_id=definition.system_id)
    assert schema["schemaStatus"] == "ready"
    assert schema["accessMetadata"] == "partial"
    assert schema["objectMetadata"] == {"name": "Person", "label": "Person"}
    assert schema["fields"][0]["readable"] is None
    assert schema["effectiveActions"] == {
        "schema": True,
        "read": False,
        "create": False,
        "update": False,
        "delete": False,
    }
    assert adapter.calls == ["schema"]


@pytest.mark.asyncio
async def test_missing_omni_gateway_headers_fail_before_streamable_http_call():
    adapter = ExternalCrmStreamableMcpAdapter(endpoint=REGISTRY_MCP_ENDPOINT)

    with pytest.raises(ConnectedSystemConfigurationError) as error:
        await adapter.call_operation(
            operation="schema",
            tool_name="object-schema",
            endpoint=REGISTRY_MCP_ENDPOINT,
            timeout_seconds=1,
            retry_count=0,
            arguments={"target": "Example", "objectType": "Person"},
        )

    assert error.value.code == "CONNECTED_SYSTEM_GATEWAY_AUTH_UNCONFIGURED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("gateway_status", "expected_code"),
    [
        (401, "CONNECTED_SYSTEM_MCP_AUTH_FAILED"),
        (403, "CONNECTED_SYSTEM_MCP_ACCESS_DENIED"),
    ],
)
async def test_gateway_auth_failures_return_safe_configuration_errors(
    monkeypatch, gateway_status, expected_code
):
    import contextlib

    import mcp.client.streamable_http as streamable_mod

    class GatewayStatusError(Exception):
        def __init__(self, status_code: int):
            self.response = type("Response", (), {"status_code": status_code})()
            super().__init__(f"HTTP {status_code}")

    @contextlib.asynccontextmanager
    async def rejected_streamable(*_args, **_kwargs):
        raise GatewayStatusError(gateway_status)
        yield  # pragma: no cover - required only to make this an async generator

    monkeypatch.setattr(streamable_mod, "streamablehttp_client", rejected_streamable)
    adapter = ExternalCrmStreamableMcpAdapter(
        endpoint="https://gateway.invalid/mcp",
        headers=(("client_id", "test-client"), ("client_secret", "test-secret")),
    )

    with pytest.raises(ConnectedSystemConfigurationError) as error:
        await adapter.call_operation(
            operation="schema",
            tool_name="object-schema",
            endpoint="https://gateway.invalid/mcp",
            timeout_seconds=1,
            retry_count=0,
            arguments={"target": "Example", "objectType": "Person"},
        )

    assert error.value.code == expected_code
    assert "gateway" in str(error.value).lower()


def test_default_service_lists_real_registry_backed_salesforce_endpoint_without_env_endpoint():
    service = ConnectedSystemsService(
        store=InMemoryConnectedSystemIntentStore(),
        delete_enabled=False,
        registry=(SALESFORCE_CRM_SYSTEM,),
    )

    systems = service.list_systems()
    assert systems[0]["systemId"] == CONNECTED_SYSTEM_SALESFORCE_ID
    assert systems[0]["status"] == "connected"
    assert systems[0]["registrySource"] == "customer0_connected_system_registry"
    assert {tool["name"] for tool in systems[0]["toolCatalog"]} >= {
        "object-schema",
        "read-crm-record",
        "update-crm-record",
    }


def test_default_service_reloads_active_registry_for_each_list(monkeypatch):
    """A registry enable/disable is visible without recreating the service."""
    from hushh_mcp.services import crm_registry_repo

    active_definitions = (SALESFORCE_CRM_SYSTEM,)
    monkeypatch.setattr(
        crm_registry_repo,
        "load_active_definitions",
        lambda: active_definitions,
    )

    service = ConnectedSystemsService(
        store=InMemoryConnectedSystemIntentStore(),
        delete_enabled=False,
    )
    assert [system["systemId"] for system in service.list_systems()] == [
        CONNECTED_SYSTEM_SALESFORCE_ID,
    ]

    active_definitions = ()
    assert service.list_systems() == []


def test_relative_operation_endpoint_uses_registered_absolute_transport() -> None:
    definition = ConnectedSystemDefinition(
        system_id="legacy-relative-operation-endpoint",
        display_name="Legacy CRM",
        customer_display_name="Legacy CRM",
        system_type="Salesforce",
        system_name="Salesforce",
        target="Legacy CRM",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://gateway.example.test/mcp",
        registry_source="test",
        tool_catalog=(
            {
                "name": "object-schema",
                "operation": "schema",
                "mcpEndpoint": "/crm-connect/v1/mcp",
            },
        ),
        capabilities=frozenset({"schema"}),
    )

    assert definition.operation_endpoint("schema") == "https://gateway.example.test/mcp"


@pytest.mark.asyncio
async def test_registry_simulator_path_remains_available_for_deterministic_local_tests():
    adapter = ExternalCrmStreamableMcpAdapter(
        endpoint="registry://connected-systems/customer0/salesforce-fsc",
        tool_catalog=EXTERNAL_CRM_TOOL_CATALOG,
    )
    service = ConnectedSystemsService(
        adapter=adapter,
        store=InMemoryConnectedSystemIntentStore(),
        delete_enabled=False,
        registry=(SALESFORCE_CRM_SYSTEM,),
    )

    schema = await service.get_schema(
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
    )
    assert schema["objectType"] == "Contact"
    assert "mcp" not in schema
    assert schema["fields"]

    read = await service.read_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="maria.joe@abc.com",
        phone="123456789",
    )
    assert read["resultClass"] == "succeeded"
    assert "mcp" not in read
    assert read["records"][0]["recordId"] == "003gK00000jlmaLQAQ"


@pytest.mark.asyncio
async def test_search_found_record_creates_active_binding_without_raw_lookup_storage():
    service, _adapter = build_service()

    result = await service.search_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
        return_fields=["Title", "MailingCity"],
    )

    assert result["bindingStatus"] == "active"
    assert result["binding"]["recordId"] == "003gK00000demoQAA"
    binding = service.store.get_binding(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type="Contact",
    )
    serialized = json.dumps(binding, sort_keys=True)
    assert binding["record_id"] == "003gK00000demoQAA"
    assert "doe.john@abc.com" not in serialized
    assert "1234567899" not in serialized


@pytest.mark.asyncio
async def test_bound_read_skips_redundant_mcp_search():
    """Once a binding exists, a second search serves the bound id without an MCP call."""
    service, adapter = build_service()

    first = await service.search_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
    )
    assert first["bindingStatus"] == "active"
    assert first.get("servedFromBinding") is False
    calls_after_first = len(adapter.calls)

    # Second search for the same (user, system, object_type): no new MCP call.
    second = await service.search_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
    )
    assert second["servedFromBinding"] is True
    assert second["recordId"] == "003gK00000demoQAA"
    assert second["mcp"] is None
    assert len(adapter.calls) == calls_after_first  # no extra read-crm-record call


@pytest.mark.asyncio
async def test_verified_profile_create_uses_server_identity_and_never_writes_derived_full_name():
    class VerifiedIdentityService:
        async def get_many(self, _user_ids):
            return {
                "user_123": {
                    "display_name": "John Doe",
                    "email": "john@example.test",
                    "email_verified": True,
                    "phone_number": "+1 (415) 555-0100",
                    "phone_verified": True,
                }
            }

    service, _adapter = build_service()
    service.identity_service = VerifiedIdentityService()

    intent = await service.create_record_intent_for_verified_user(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
    )

    stored = service.store.intents[intent["intentId"]]["request_payload"]
    assert stored["email"] == "john@example.test"
    assert stored["phone"] == "4155550100"
    assert stored["lastName"] == "Doe"
    assert "Name" not in stored
    assert "firstName" not in stored


@pytest.mark.asyncio
async def test_bound_mutations_reject_other_record_ids_and_recheck_binding_on_approval():
    service, adapter = build_service()
    service.store.upsert_binding(
        {
            "binding_id": "binding-owner",
            "user_id": "user_123",
            "system_id": CONNECTED_SYSTEM_SALESFORCE_ID,
            "target": "Macys",
            "object_type": "Contact",
            "record_id": "003gK00000ownedQAA",
        }
    )

    with pytest.raises(ConnectedSystemBlockedError, match="not linked"):
        await service.update_record_intent_from_fields(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type=None,
            record_id="003gK00000otherQAA",
            record_fields={"MailingCity": "Dallas"},
        )

    intent = await service.update_record_intent_from_fields(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        record_id=None,
        record_fields={"MailingCity": "Dallas"},
    )
    service.store.mark_binding_deleted(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type="Contact",
        record_id="003gK00000ownedQAA",
    )

    with pytest.raises(ConnectedSystemBlockedError, match="Link your CRM record"):
        await service.approve_intent(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            intent_id=intent["intentId"],
        )
    assert not any(name == "update-crm-record" for name, _payload in adapter.calls)


@pytest.mark.asyncio
async def test_force_refresh_bypasses_binding_and_researches():
    """force_refresh=True re-runs the MCP search even when a binding exists."""
    service, adapter = build_service()

    await service.search_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
    )
    calls_after_first = len(adapter.calls)

    refreshed = await service.search_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
        force_refresh=True,
    )
    assert refreshed["servedFromBinding"] is False
    # A fresh schema validation and read-crm-record call were made.
    assert len(adapter.calls) == calls_after_first + 2
    assert adapter.calls[-1][0] == "read-crm-record"


@pytest.mark.asyncio
async def test_schema_read_and_create_payloads_match_live_mcp_contract():
    service, adapter = build_service()

    schema = await service.get_schema(
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
    )
    assert schema["objectType"] == "Contact"
    assert schema["supportedFields"] == [
        "Email",
        "Phone",
        "MobilePhone",
        "MailingCity",
        "Unsupported__c",
        "LastName",
    ]
    fields = {field["key"]: field for field in schema["fields"]}
    assert fields["Unsupported__c"]["writable"] is None
    assert fields["LastName"]["required"] is True
    assert fields["Email"]["readable"] is None
    assert adapter.calls[-1] == (
        "object-schema",
        {"target": "Macys", "objectType": "Contact"},
    )

    await service.read_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
        search_fields={"Title": "VP Sales"},
        return_fields=["LeadSource", "MailingCity"],
    )
    assert adapter.calls[-1] == (
        "read-crm-record",
        {
            "target": "Macys",
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "1234567899",
            "returnFields": ["LeadSource", "MailingCity"],
        },
    )

    await service.read_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
        search_fields={"Id": "003gK00000demoQAA"},
        return_fields=["MailingCity"],
    )
    assert adapter.calls[-1] == (
        "read-crm-record",
        {
            "target": "Macys",
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "1234567899",
            "returnFields": ["MailingCity"],
        },
    )

    intent = service.create_record_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
        first_name="John",
        last_name="Doe",
        additional_fields={"Title": "VP Sales", "MailingCity": "Dallas"},
    )
    assert intent["status"] == "pending"

    approved = await service.approve_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )
    assert approved["status"] == "succeeded"
    assert approved["binding"]["status"] == "active"
    assert approved["binding"]["recordId"] == "003gK00000demoQAA"
    binding = service.store.get_binding(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type="Contact",
    )
    assert binding["record_id"] == "003gK00000demoQAA"
    assert (
        "create-crm-record",
        {
            "target": "Macys",
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "1234567899",
            "lastName": "Doe",
            "firstName": "John",
            "additionalFields": {"Title": "VP Sales", "MailingCity": "Dallas"},
        },
    ) in adapter.calls


@pytest.mark.asyncio
async def test_mcp_payloads_strip_us_country_code_from_phone_values():
    service, adapter = build_service()

    await service.read_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="+1 (415) 555-1212",
        return_fields=["MailingCity"],
    )
    assert adapter.calls[-1] == (
        "read-crm-record",
        {
            "target": "Macys",
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "4155551212",
            "returnFields": ["MailingCity"],
        },
    )

    intent = service.create_record_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="+1 (415) 555-1212",
        first_name="John",
        last_name="Doe",
        additional_fields={"MailingCity": "Dallas"},
    )
    await service.approve_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )
    assert (
        "create-crm-record",
        {
            "target": "Macys",
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "4155551212",
            "lastName": "Doe",
            "firstName": "John",
            "additionalFields": {"MailingCity": "Dallas"},
        },
    ) in adapter.calls


@pytest.mark.asyncio
async def test_create_approval_binds_from_readback_when_mcp_create_omits_id():
    service, adapter = build_service()

    async def create_without_id(payload: dict) -> dict:
        adapter.calls.append(("create-crm-record", payload))
        return {"isError": False, "payload": {"success": True}}

    adapter.create_record = create_without_id
    intent = service.create_record_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
        first_name="John",
        last_name="Doe",
        additional_fields={"MailingCity": "Dallas"},
    )

    approved = await service.approve_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )

    assert approved["status"] == "succeeded"
    assert approved["recordId"] == "003gK00000demoQAA"
    assert approved["binding"]["status"] == "active"
    assert approved["binding"]["recordId"] == "003gK00000demoQAA"
    binding = service.store.get_binding(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type="Contact",
    )
    assert binding["record_id"] == "003gK00000demoQAA"


def test_create_requires_last_name_from_live_schema():
    service, _adapter = build_service()

    with pytest.raises(ConnectedSystemValidationError) as error:
        service.create_record_intent(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type=None,
            email="doe.john@abc.com",
            phone="1234567899",
            first_name="John",
            last_name="",
            additional_fields=None,
        )

    assert error.value.code == "CONNECTED_SYSTEM_VALIDATION_FAILED"


def test_unsupported_fields_fail_before_mcp_call():
    service, adapter = build_service()

    with pytest.raises(ConnectedSystemValidationError) as error:
        service.create_record_intent(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type="Contact",
            email="doe.john@abc.com",
            phone="1234567899",
            first_name="John",
            last_name="Doe",
            additional_fields={"NotAContactField": "x"},
        )

    assert error.value.code == "UNSUPPORTED_CRM_FIELD"
    assert adapter.calls == []

    with pytest.raises(ConnectedSystemValidationError) as update_error:
        service.update_record_intent(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type="Contact",
            record_id="003gK00000demoQAA",
            additional_fields={"Id": "003gK00000otherQAA"},
        )

    assert update_error.value.code == "UNSUPPORTED_CRM_FIELD"
    assert adapter.calls == []


@pytest.mark.asyncio
async def test_rejected_intent_never_calls_mcp():
    service, adapter = build_service()
    intent = service.update_record_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        record_id="003gK00000demoQAA",
        additional_fields={"MailingCity": "New York"},
    )

    rejected = service.reject_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )

    assert rejected["status"] == "rejected"
    assert adapter.calls == []
    stored = service.store.intents[intent["intentId"]]
    assert stored["request_payload"]["additionalFieldNames"] == ["MailingCity"]
    assert "New York" not in json.dumps(stored, sort_keys=True)


@pytest.mark.asyncio
async def test_update_uses_additional_fields_and_marks_readback_mismatch_partial():
    service, adapter = build_service()
    service.store.upsert_binding(
        {
            "binding_id": "binding-test",
            "user_id": "user_123",
            "system_id": CONNECTED_SYSTEM_SALESFORCE_ID,
            "target": "Macys",
            "object_type": "Contact",
            "record_id": "003gK00000demoQAA",
        }
    )
    adapter.readback_records = [
        {
            "Id": "003gK00000demoQAA",
            "Email": "maria.joe@abc.com",
            "Phone": "123456789",
            "MailingCity": "Dallas",
        }
    ]

    intent = service.update_record_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        record_id="003gK00000demoQAA",
        additional_fields={"MailingCity": "New York"},
        readback_locator={"email": "maria.joe@abc.com", "phone": "123456789"},
    )

    approved = await service.approve_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )

    assert (
        "update-crm-record",
        {
            "target": "Macys",
            "objectType": "Contact",
            "id": "003gK00000demoQAA",
            "additionalFields": {"MailingCity": "New York"},
        },
    ) in adapter.calls
    read_calls = [payload for name, payload in adapter.calls if name == "read-crm-record"]
    assert read_calls[-1]["id"] == "003gK00000demoQAA"
    assert "email" not in read_calls[-1]
    assert "phone" not in read_calls[-1]
    assert all("body" not in payload for _name, payload in adapter.calls)
    assert approved["status"] == "partial"
    assert approved["binding"]["status"] == "active"
    assert approved["binding"]["recordId"] == "003gK00000demoQAA"


@pytest.mark.asyncio
async def test_delete_readback_uses_bound_id_and_clears_binding_only_after_absence():
    service, adapter = build_service(delete_enabled=True)
    service.store.upsert_binding(
        {
            "binding_id": "binding-delete-test",
            "user_id": "user_123",
            "system_id": CONNECTED_SYSTEM_SALESFORCE_ID,
            "target": "Macys",
            "object_type": "Contact",
            "record_id": "003gK00000demoQAA",
        }
    )

    intent = service.create_delete_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type="Contact",
    )
    approved = await service.approve_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )

    assert approved["status"] == "succeeded"
    assert approved["binding"]["status"] == "deleted"
    read_calls = [payload for name, payload in adapter.calls if name == "read-crm-record"]
    assert read_calls[-1] == {
        "target": "Macys",
        "objectType": "Contact",
        "id": "003gK00000demoQAA",
        "returnFields": [],
    }


@pytest.mark.asyncio
async def test_failed_create_intent_returns_sanitized_mcp_error_message():
    service, adapter = build_service()

    async def create_record_error(payload: dict) -> dict:
        adapter.calls.append(("create-crm-record", payload))
        return {
            "isError": True,
            "payload": {
                "errors": [
                    {"message": ("Duplicate Contact for doe.john@abc.com and +1 (415) 555-1212")}
                ]
            },
        }

    adapter.create_record = create_record_error
    intent = service.create_record_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="+1 (415) 555-1212",
        first_name="John",
        last_name="Doe",
        additional_fields={"MailingCity": "Dallas"},
    )

    with pytest.raises(Exception, match=r"Duplicate Contact for \[email\] and \[phone\]"):
        await service.approve_intent(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            intent_id=intent["intentId"],
        )
    stored = service.store.intents[intent["intentId"]]
    assert stored["status"] == "failed"
    assert stored["error_message"] == "Duplicate Contact for [email] and [phone]"
    serialized = json.dumps(stored, sort_keys=True)
    assert "doe.john@abc.com" not in serialized
    assert "+1 (415) 555-1212" not in serialized


@pytest.mark.asyncio
async def test_terminal_intent_scrubs_raw_payload_values_after_approval():
    service, _adapter = build_service()

    intent = service.create_record_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="doe.john@abc.com",
        phone="1234567899",
        first_name="John",
        last_name="Doe",
        additional_fields={"Title": "VP Sales", "MailingCity": "Dallas"},
    )
    pending = service.store.intents[intent["intentId"]]
    assert pending["request_payload"]["email"] == "doe.john@abc.com"

    approved = await service.approve_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )

    assert approved["status"] == "succeeded"
    stored = service.store.intents[intent["intentId"]]
    serialized = json.dumps(stored, sort_keys=True)
    assert stored["request_payload"]["emailPresent"] is True
    assert stored["request_payload"]["phonePresent"] is True
    assert stored["request_payload"]["additionalFieldNames"] == ["MailingCity", "Title"]
    assert stored["readback_payload"]["emailLocatorPresent"] is True
    assert stored["readback_payload"]["phoneLocatorPresent"] is True
    assert stored["result_payload"]["recordId"] == "003gK00000demoQAA"
    assert stored["readback_result"]["recordCount"] == 1
    assert "doe.john@abc.com" not in serialized
    assert "1234567899" not in serialized
    assert "Dallas" not in serialized
    assert "VP Sales" not in serialized


@pytest.mark.asyncio
async def test_delete_requires_the_intent_lifecycle_even_when_enabled():
    service, adapter = build_service(delete_enabled=False)

    with pytest.raises(ConnectedSystemBlockedError):
        await service.delete_record(
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type=None,
            record_id="003gK00000demoQAA",
        )
    assert adapter.calls == []

    enabled_service, enabled_adapter = build_service(delete_enabled=True)
    with pytest.raises(ConnectedSystemBlockedError) as error:
        await enabled_service.delete_record(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type=None,
            record_id="003gK00000demoQAA",
        )
    assert error.value.code == "CONNECTED_SYSTEM_DELETE_INTENT_REQUIRED"
    assert enabled_adapter.calls == []


def test_definition_default_transport_headers_empty_and_not_in_summary():
    """Hardcoded definitions carry no headers and never leak headers via summary."""
    from hushh_mcp.services.connected_systems_service import SALESFORCE_CRM_SYSTEM

    assert SALESFORCE_CRM_SYSTEM.transport_headers == ()
    summary = SALESFORCE_CRM_SYSTEM.to_summary(endpoint_configured=True, delete_enabled=False)
    serialized = json.dumps(summary)
    assert "transport_headers" not in serialized
    assert "client_secret" not in serialized
    assert "client_id" not in serialized


def test_adapter_passes_transport_headers_into_streamable_client(monkeypatch):
    """client_id/client_secret from the definition reach streamablehttp_client(headers=...)."""
    import contextlib

    from hushh_mcp.services.connected_systems_service import ConnectedSystemDefinition

    captured: dict = {}

    @contextlib.asynccontextmanager
    async def fake_streamable(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs

        class _Reader:
            pass

        yield (_Reader(), _Reader(), None)

    class _FakeSession:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def initialize(self):
            return None

        async def call_tool(self, name, arguments):
            class _Result:
                isError = False
                content = []

            return _Result()

    import mcp.client.session as session_mod
    import mcp.client.streamable_http as streamable_mod

    monkeypatch.setattr(streamable_mod, "streamablehttp_client", fake_streamable)
    monkeypatch.setattr(session_mod, "ClientSession", _FakeSession)

    definition = ConnectedSystemDefinition(
        system_id="crm-x",
        display_name="X",
        customer_display_name="X",
        system_type="Salesforce",
        system_name="X",
        target="X",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://gateway.invalid/crm-connect/v1/mcp",
        registry_source="enterprise_crm_registry",
        tool_catalog=({"name": "object-schema", "operation": "schema"},),
        transport_headers=(("client_id", "cid-1"), ("client_secret", "secret-1")),
    )

    adapter = ExternalCrmStreamableMcpAdapter.from_registry(definition)

    import asyncio

    asyncio.run(adapter.object_schema({"target": "X", "objectType": "Contact"}))

    assert captured["url"] == "https://gateway.invalid/crm-connect/v1/mcp"
    assert captured["kwargs"]["headers"] == {"client_id": "cid-1", "client_secret": "secret-1"}


def test_adapter_passes_gateway_headers_and_private_tool_arguments(monkeypatch):
    """Gateway auth stays in headers; registry private args are merged into tool args."""
    import contextlib

    captured: dict = {}

    @contextlib.asynccontextmanager
    async def fake_streamable(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs

        class _R:
            pass

        yield (_R(), _R(), None)

    class _FakeSession:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def initialize(self):
            return None

        async def call_tool(self, name, arguments):
            captured["tool_name"] = name
            captured["arguments"] = arguments

            class _Result:
                isError = False
                content = []

            return _Result()

    import mcp.client.session as session_mod
    import mcp.client.streamable_http as streamable_mod

    monkeypatch.setattr(streamable_mod, "streamablehttp_client", fake_streamable)
    monkeypatch.setattr(session_mod, "ClientSession", _FakeSession)

    definition = ConnectedSystemDefinition(
        system_id="crm-x",
        display_name="X",
        customer_display_name="X",
        system_type="Salesforce",
        system_name="X",
        target="X",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://gateway.invalid/crm-connect/v1/mcp",
        registry_source="enterprise_crm_registry",
        tool_catalog=({"name": "object-schema", "operation": "schema"},),
        transport_headers=(("client_id", "gateway-client"), ("client_secret", "gateway-secret")),
        transport_tool_arguments={
            "crmBaseUrl": "https://example.my.salesforce.com",
            "crmMcpEndpoint": "/services/mcp/v1",
            "clientId": "plain-salesforce-client-id",
            "clientSecret": "encrypted-salesforce-client-secret",
            "crmTokenUrl": "https://example.my.salesforce.com/services/oauth2/token",
            "objectType": "Contact",
        },
    )

    adapter = ExternalCrmStreamableMcpAdapter.from_registry(definition)

    import asyncio

    asyncio.run(adapter.object_schema({"target": "X", "objectType": "Contact"}))

    assert captured["kwargs"]["headers"] == {
        "client_id": "gateway-client",
        "client_secret": "gateway-secret",
    }
    assert captured["arguments"]["clientId"] == "plain-salesforce-client-id"
    assert captured["arguments"]["clientSecret"] == "encrypted-salesforce-client-secret"
    assert captured["arguments"]["crmBaseUrl"] == "https://example.my.salesforce.com"
    assert captured["arguments"]["crmMcpEndpoint"] == "/services/mcp/v1"
    assert (
        captured["arguments"]["crmTokenUrl"]
        == "https://example.my.salesforce.com/services/oauth2/token"
    )
    assert captured["arguments"]["objectType"] == "Contact"
    assert captured["arguments"]["target"] == "X"


def test_adapter_without_headers_omits_headers_kwarg(monkeypatch):
    """Legacy in-code definitions (no headers) pass no headers kwarg."""
    import contextlib

    captured: dict = {}

    @contextlib.asynccontextmanager
    async def fake_streamable(url, **kwargs):
        captured["kwargs"] = kwargs

        class _R:
            pass

        yield (_R(), _R(), None)

    class _FakeSession:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def initialize(self):
            return None

        async def call_tool(self, name, arguments):
            class _Result:
                isError = False
                content = []

            return _Result()

    import mcp.client.session as session_mod
    import mcp.client.streamable_http as streamable_mod

    monkeypatch.setattr(streamable_mod, "streamablehttp_client", fake_streamable)
    monkeypatch.setattr(session_mod, "ClientSession", _FakeSession)

    adapter = ExternalCrmStreamableMcpAdapter(
        endpoint="https://gateway.invalid/mcp",
        tool_catalog=({"name": "object-schema", "operation": "schema"},),
    )

    import asyncio

    asyncio.run(adapter.object_schema({"target": "X", "objectType": "Contact"}))

    assert "headers" not in captured["kwargs"]


def test_resolve_system_uses_db_registry_by_default(monkeypatch):
    """Runtime resolution always uses the DB-backed definition."""
    from hushh_mcp.services import connected_systems_service as svc

    db_definition = svc.ConnectedSystemDefinition(
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        display_name="Macy's",
        customer_display_name="Macy's",
        system_type="Salesforce",
        system_name="Salesforce",
        target="Macy's",
        object_type_default="Contact",
        transport="external_crm_streamable_mcp",
        transport_endpoint="https://gateway.invalid/crm-connect/v1/mcp",
        registry_source="enterprise_crm_registry",
        tool_catalog=tuple(EXTERNAL_CRM_TOOL_CATALOG),
        transport_headers=(("client_id", "cid"), ("client_secret", "sec")),
    )

    import hushh_mcp.services.crm_registry_repo as repo

    monkeypatch.setattr(repo, "load_active_definition", lambda system_id, db=None: db_definition)
    monkeypatch.setattr(repo, "load_active_definitions", lambda db=None: (db_definition,))

    service = ConnectedSystemsService(
        adapter=FakeExternalCrmAdapter(), store=InMemoryConnectedSystemIntentStore()
    )
    resolved = service.get_system(CONNECTED_SYSTEM_SALESFORCE_ID)
    assert resolved.registry_source == "enterprise_crm_registry"
    assert dict(resolved.transport_headers)["client_id"] == "cid"


def test_resolve_system_raises_when_db_row_missing(monkeypatch):
    """A missing DB row produces no-data; runtime never falls back to code."""

    import hushh_mcp.services.crm_registry_repo as repo

    monkeypatch.setattr(repo, "load_active_definition", lambda system_id, db=None: None)
    monkeypatch.setattr(repo, "load_active_definitions", lambda db=None: ())

    service = ConnectedSystemsService(
        adapter=FakeExternalCrmAdapter(), store=InMemoryConnectedSystemIntentStore()
    )
    with pytest.raises(ConnectedSystemNotFoundError):
        service.get_system(CONNECTED_SYSTEM_SALESFORCE_ID)
