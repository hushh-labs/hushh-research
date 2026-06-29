from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import connected_systems
from hushh_mcp.services.connected_systems_service import ConnectedSystemBlockedError


class FakeConnectedSystemsService:
    def __init__(self):
        self.created_payload = None
        self.read_payload = None
        self.updated_payload = None
        self.deleted_payload = None
        self.binding_payload = None
        self.search_payload = None

    def list_systems(self):
        return [
            {
                "systemId": "salesforce-fsc-customer0",
                "displayName": "Macy's",
                "customerDisplayName": "Macy's",
                "systemType": "Salesforce",
                "systemName": "FSC",
                "status": "connected",
                "target": "Macys",
                "objectTypeDefault": "Contact",
                "transport": "external_crm_streamable_mcp",
            }
        ]

    def create_record_intent(self, **kwargs):
        self.created_payload = kwargs
        return {
            "intentId": "csi_test",
            "systemId": kwargs["system_id"],
            "action": "create",
            "status": "pending",
            "fieldNames": ["Email", "Phone", "LastName"],
        }

    async def read_record(self, **kwargs):
        self.read_payload = kwargs
        return {
            "systemId": kwargs["system_id"],
            "target": "Macys",
            "objectType": kwargs["object_type"],
            "resultClass": "succeeded",
            "mcp": {"isError": False, "payload": {"records": []}},
        }

    def get_record_binding(self, **kwargs):
        self.binding_payload = kwargs
        return {
            "systemId": kwargs["system_id"],
            "target": "Macys",
            "objectType": kwargs["object_type"],
            "status": "unbound",
            "binding": None,
        }

    async def search_record(self, **kwargs):
        self.search_payload = kwargs
        return {
            "systemId": kwargs["system_id"],
            "target": "Macys",
            "objectType": kwargs["object_type"],
            "recordId": "003gK00000demoQAA",
            "resultClass": "succeeded",
            "bindingStatus": "active",
            "binding": {
                "systemId": kwargs["system_id"],
                "target": "Macys",
                "objectType": kwargs["object_type"],
                "recordId": "003gK00000demoQAA",
                "status": "active",
            },
            "mcp": {"isError": False, "payload": {"Contact": [{"Id": "003gK00000demoQAA"}]}},
        }

    def update_record_intent(self, **kwargs):
        self.updated_payload = kwargs
        return {
            "intentId": "csi_update_test",
            "systemId": kwargs["system_id"],
            "action": "update",
            "status": "pending",
            "fieldNames": ["MailingCity"],
        }

    async def delete_record(self, **kwargs):
        self.deleted_payload = kwargs
        return {
            "systemId": kwargs["system_id"],
            "target": "Macys",
            "objectType": kwargs["object_type"],
            "recordId": kwargs["record_id"],
            "resultClass": "succeeded",
            "mcp": {"isError": False, "payload": {"deleted": True}},
            "binding": {"recordId": kwargs["record_id"], "status": "deleted"},
        }


class FakeBlockedDeleteConnectedSystemsService(FakeConnectedSystemsService):
    async def delete_record(self, **kwargs):
        self.deleted_payload = kwargs
        raise ConnectedSystemBlockedError(
            "Delete is blocked for this connected system.",
            code="CRM_DELETE_BLOCKED",
        )


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(connected_systems.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    return app


def test_list_connected_systems_route_returns_salesforce_registry_entry(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.get("/api/connected-systems", headers={"Authorization": "Bearer HCT:test"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["systems"][0]["systemId"] == "salesforce-fsc-customer0"
    assert payload["systems"][0]["displayName"] == "Macy's"
    assert payload["systems"][0]["customerDisplayName"] == "Macy's"
    assert payload["systems"][0]["systemType"] == "Salesforce"
    assert payload["systems"][0]["systemName"] == "FSC"


def test_create_intent_route_accepts_live_mcp_camel_case_shape(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/create-intents",
        headers={"Authorization": "Bearer HCT:test"},
        json={
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "1234567899",
            "firstName": "John",
            "lastName": "Doe",
            "additionalFields": {"Title": "VP Sales"},
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert service.created_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "email": "doe.john@abc.com",
        "phone": "1234567899",
        "first_name": "John",
        "last_name": "Doe",
        "additional_fields": {"Title": "VP Sales"},
    }


def test_read_route_accepts_updated_mcp_search_and_return_fields(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/read",
        headers={"Authorization": "Bearer HCT:test"},
        json={
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "1234567899",
            "searchFields": {"Title": "VP Sales"},
            "returnFields": ["LeadSource", "MailingCity"],
        },
    )

    assert response.status_code == 200
    assert response.json()["resultClass"] == "succeeded"
    assert service.read_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "email": "doe.john@abc.com",
        "phone": "1234567899",
        "search_fields": {"Title": "VP Sales"},
        "return_fields": ["LeadSource", "MailingCity"],
    }


def test_record_binding_route_returns_authenticated_user_binding(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.get(
        "/api/connected-systems/salesforce-fsc-customer0/record-binding?objectType=Contact",
        headers={"Authorization": "Bearer HCT:test"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "unbound"
    assert service.binding_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
    }


def test_search_route_binds_matching_crm_record(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/search",
        headers={"Authorization": "Bearer HCT:test"},
        json={
            "objectType": "Contact",
            "email": "doe.john@abc.com",
            "phone": "1234567899",
            "returnFields": ["LeadSource", "MailingCity"],
        },
    )

    assert response.status_code == 200
    assert response.json()["bindingStatus"] == "active"
    assert service.search_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "email": "doe.john@abc.com",
        "phone": "1234567899",
        "search_fields": None,
        "return_fields": ["LeadSource", "MailingCity"],
    }


def test_update_intent_route_accepts_updated_mcp_id_and_additional_fields(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/update-intents",
        headers={"Authorization": "Bearer HCT:test"},
        json={
            "objectType": "Contact",
            "id": "003gK00000m36zhQAA",
            "additionalFields": {"MailingCity": "New York"},
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert service.updated_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "record_id": "003gK00000m36zhQAA",
        "additional_fields": {"MailingCity": "New York"},
        "readback_locator": None,
    }


def test_delete_route_accepts_updated_mcp_id_shape(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/delete",
        headers={"Authorization": "Bearer HCT:test"},
        json={
            "objectType": "Contact",
            "id": "003gK00000m36zhQAA",
        },
    )

    assert response.status_code == 200
    assert response.json()["mcp"]["payload"]["deleted"] is True
    assert service.deleted_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "record_id": "003gK00000m36zhQAA",
    }


def test_delete_route_returns_403_when_service_blocks_delete(monkeypatch):
    service = FakeBlockedDeleteConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/delete",
        headers={"Authorization": "Bearer HCT:test"},
        json={
            "objectType": "Contact",
            "id": "003gK00000m36zhQAA",
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "CRM_DELETE_BLOCKED"
