from __future__ import annotations

import json

import pytest

from hushh_mcp.services.connected_systems_service import (
    CONNECTED_SYSTEM_SALESFORCE_ID,
    EXTERNAL_CRM_TOOL_CATALOG,
    ConnectedSystemBlockedError,
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
        return {"isError": False, "payload": {"deleted": True}}


def build_service(
    *, delete_enabled: bool = False
) -> tuple[ConnectedSystemsService, FakeExternalCrmAdapter]:
    adapter = FakeExternalCrmAdapter()
    service = ConnectedSystemsService(
        adapter=adapter,
        store=InMemoryConnectedSystemIntentStore(),
        delete_enabled=delete_enabled,
    )
    return service, adapter


def test_default_service_lists_real_registry_backed_salesforce_endpoint_without_env_endpoint():
    service = ConnectedSystemsService(
        store=InMemoryConnectedSystemIntentStore(),
        delete_enabled=False,
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
    )

    schema = await service.get_schema(
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
    )
    assert schema["objectType"] == "Contact"
    assert schema["mcp"]["payload"]["source"] == "customer0_connected_system_registry"

    read = await service.read_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        email="maria.joe@abc.com",
        phone="123456789",
    )
    assert read["resultClass"] == "succeeded"
    assert read["mcp"]["payload"]["Contact"][0]["Id"] == "003gK00000jlmaLQAQ"


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
        "LastName",
    ]
    assert schema["fields"] == [
        {
            "key": "Email",
            "name": "Email",
            "label": "Email",
            "dataType": "email",
            "required": False,
            "identityField": True,
            "writable": False,
            "source": "mcp_schema",
        },
        {
            "key": "Phone",
            "name": "Phone",
            "label": "Phone",
            "dataType": "tel",
            "required": False,
            "identityField": True,
            "writable": False,
            "source": "mcp_schema",
        },
        {
            "key": "MobilePhone",
            "name": "MobilePhone",
            "label": "Mobile phone",
            "dataType": "tel",
            "required": False,
            "identityField": False,
            "writable": True,
            "source": "mcp_schema",
        },
        {
            "key": "MailingCity",
            "name": "MailingCity",
            "label": "Mailing city",
            "dataType": "string",
            "required": False,
            "identityField": False,
            "writable": True,
            "source": "mcp_schema",
        },
        {
            "key": "LastName",
            "name": "LastName",
            "label": "Last name",
            "dataType": "string",
            "required": True,
            "identityField": False,
            "writable": True,
            "source": "mcp_schema",
        },
    ]
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
            "searchFields": {"Title": "VP Sales"},
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
            "searchFields": {"Id": "003gK00000demoQAA"},
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
    assert all("body" not in payload for _name, payload in adapter.calls)
    assert approved["status"] == "partial"
    assert approved["binding"]["status"] == "active"
    assert approved["binding"]["recordId"] == "003gK00000demoQAA"


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

    approved = await service.approve_intent(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        intent_id=intent["intentId"],
    )

    assert approved["status"] == "failed"
    assert approved["errorMessage"] == "Duplicate Contact for [email] and [phone]"
    stored = service.store.intents[intent["intentId"]]
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
async def test_delete_is_blocked_unless_maintainer_flag_enabled():
    service, adapter = build_service(delete_enabled=False)

    with pytest.raises(ConnectedSystemBlockedError):
        await service.delete_record(
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type=None,
            record_id="003gK00000demoQAA",
        )
    assert adapter.calls == []

    enabled_service, enabled_adapter = build_service(delete_enabled=True)
    enabled_service.store.upsert_binding(
        {
            "binding_id": "csb_test",
            "user_id": "user_123",
            "system_id": CONNECTED_SYSTEM_SALESFORCE_ID,
            "target": "Macys",
            "object_type": "Contact",
            "record_id": "003gK00000demoQAA",
            "created_intent_id": None,
            "last_intent_id": None,
        }
    )
    result = await enabled_service.delete_record(
        user_id="user_123",
        system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
        object_type=None,
        record_id="003gK00000demoQAA",
    )

    assert result["mcp"]["payload"]["deleted"] is True
    assert result["resultClass"] == "succeeded"
    assert result["binding"]["status"] == "deleted"
    assert (
        enabled_service.store.get_binding(
            user_id="user_123",
            system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
            object_type="Contact",
        )
        is None
    )
    assert enabled_adapter.calls == [
        (
            "delete-crm-record",
            {
                "target": "Macys",
                "objectType": "Contact",
                "id": "003gK00000demoQAA",
            },
        )
    ]
