from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import connected_systems
from hushh_mcp.services.connected_systems_service import (
    ConnectedSystemBlockedError,
    ConnectedSystemConfigurationError,
)
from hushh_mcp.services.crm_schema_mapping_service import CrmSchemaMappingError


class FakeConnectedSystemsService:
    def __init__(self):
        self.created_payload = None
        self.read_payload = None
        self.updated_payload = None
        self.deleted_payload = None
        self.binding_payload = None
        self.search_payload = None
        self.disconnected_payload = None
        self.schema_calls = 0

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

    def registry_revision(self):
        return 7

    def get_system(self, system_id):
        return SimpleNamespace(registry_id="crm_001", system_id=system_id)

    def list_record_binding_statuses(self, **kwargs):
        self.binding_payload = kwargs
        return {
            "bindings": [
                {
                    "systemId": "salesforce-fsc-customer0",
                    "objectType": "Contact",
                    "status": "unbound",
                }
            ]
        }

    async def get_schema(self, **kwargs):
        self.schema_calls += 1
        return {
            "systemId": kwargs["system_id"],
            "objectType": kwargs.get("object_type") or "Contact",
            "fields": [],
            "effectiveActions": {"schema": True},
        }

    async def create_record_intent_for_verified_user(self, **kwargs):
        self.created_payload = kwargs
        return {
            "intentId": "csi_test",
            "systemId": kwargs["system_id"],
            "action": "create",
            "status": "pending",
            "fieldNames": ["Email", "Phone", "LastName"],
        }

    async def read_bound_record(self, **kwargs):
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

    def disconnect_record_binding(self, **kwargs):
        self.disconnected_payload = kwargs
        return {
            "systemId": kwargs["system_id"],
            "target": "Macys",
            "objectType": kwargs["object_type"],
            "status": "disconnected",
            "binding": {
                "systemId": kwargs["system_id"],
                "objectType": kwargs["object_type"],
                "recordId": "003gK00000demoQAA",
                "status": "disconnected",
            },
        }

    async def search_verified_record(self, **kwargs):
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

    async def update_record_intent_from_fields(self, **kwargs):
        self.updated_payload = kwargs
        return {
            "intentId": "csi_update_test",
            "systemId": kwargs["system_id"],
            "action": "update",
            "status": "pending",
            "fieldNames": ["MailingCity"],
        }

    def create_delete_intent(self, **kwargs):
        self.deleted_payload = kwargs
        return {
            "intentId": "csi_delete_test",
            "systemId": kwargs["system_id"],
            "action": "delete",
            "status": "pending",
            "recordId": kwargs.get("record_id"),
            "fieldNames": [],
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
    def create_delete_intent(self, **kwargs):
        self.deleted_payload = kwargs
        raise ConnectedSystemBlockedError(
            "Delete is blocked for this connected system.",
            code="CRM_DELETE_BLOCKED",
        )


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(connected_systems.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    # The list endpoint accepts signed-in users (Firebase ID token) without
    # vault unlock; record-level routes still require the vault owner token.
    app.dependency_overrides[connected_systems._require_signed_in_lister] = lambda: "user_123"
    return app


class FakeSchemaMappingService:
    def __init__(self):
        self.crm_ids = []

    async def resolve(self, **kwargs):
        self.crm_ids.append(kwargs["crm_id"])
        return SimpleNamespace(
            mapping={
                "email": "Email",
                "phone": "Phone",
                "firstName": "FirstName",
                "lastName": "LastName",
            }
        )

    def invalidate(self, **_kwargs):
        return None


class FakeUnavailableSchemaMappingService:
    async def resolve(self, **_kwargs):
        raise CrmSchemaMappingError("Schema mapping is unavailable.")


@pytest.fixture(autouse=True)
def schema_mapping_service(monkeypatch):
    monkeypatch.setattr(
        connected_systems,
        "get_crm_schema_mapping_service",
        lambda: FakeSchemaMappingService(),
    )


def test_list_connected_systems_route_returns_salesforce_registry_entry(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.get("/api/connected-systems", headers={"Authorization": "Bearer HCT:test"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["registryRevision"] == 7
    assert payload["systems"][0]["systemId"] == "salesforce-fsc-customer0"
    assert payload["systems"][0]["displayName"] == "Macy's"
    assert payload["systems"][0]["customerDisplayName"] == "Macy's"
    assert payload["systems"][0]["systemType"] == "Salesforce"
    assert payload["systems"][0]["systemName"] == "FSC"


def test_list_connected_systems_returns_typed_registry_unavailable_error(monkeypatch):
    monkeypatch.setattr(
        connected_systems,
        "get_connected_systems_service",
        lambda: (_ for _ in ()).throw(
            ConnectedSystemConfigurationError(
                "Connected Systems configuration is temporarily unavailable.",
                code="CONNECTED_SYSTEM_REGISTRY_UNAVAILABLE",
            )
        ),
    )
    client = TestClient(_build_app())

    response = client.get("/api/connected-systems", headers={"Authorization": "Bearer HCT:test"})

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "CONNECTED_SYSTEM_REGISTRY_UNAVAILABLE",
        "message": "Connected Systems configuration is temporarily unavailable.",
    }


def test_schema_mapping_failure_reuses_the_single_catalogue_fetch(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    monkeypatch.setattr(
        connected_systems,
        "get_crm_schema_mapping_service",
        lambda: FakeUnavailableSchemaMappingService(),
    )
    client = TestClient(_build_app())

    response = client.get(
        "/api/connected-systems/salesforce-fsc-customer0/schema?objectType=Contact",
        headers={"Authorization": "Bearer HCT:test"},
    )

    assert response.status_code == 200
    assert response.json()["schemaMappingStatus"] == "unavailable"
    assert service.schema_calls == 1


def test_schema_mapping_uses_internal_registry_parent_key(monkeypatch):
    service = FakeConnectedSystemsService()
    mapping_service = FakeSchemaMappingService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    monkeypatch.setattr(
        connected_systems,
        "get_crm_schema_mapping_service",
        lambda: mapping_service,
    )
    client = TestClient(_build_app())

    response = client.get(
        "/api/connected-systems/salesforce-fsc-customer0/schema?objectType=Contact",
        headers={"Authorization": "Bearer HCT:test"},
    )

    assert response.status_code == 200
    assert response.json()["schemaMappingStatus"] == "ready"
    assert mapping_service.crm_ids == ["crm_001"]


def test_create_intent_route_accepts_no_browser_identity_fields(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/create-intents",
        headers={"Authorization": "Bearer HCT:test"},
        json={"objectType": "Contact"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert service.created_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "profile_field_mappings": {
            "email": "Email",
            "phone": "Phone",
            "firstName": "FirstName",
            "lastName": "LastName",
        },
    }


def test_read_route_uses_bound_record(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/read",
        headers={"Authorization": "Bearer HCT:test"},
        json={"objectType": "Contact", "returnFields": ["LeadSource", "MailingCity"]},
    )

    assert response.status_code == 200
    assert response.json()["resultClass"] == "succeeded"
    assert service.read_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
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


def test_disconnect_binding_route_is_owner_scoped_and_record_id_free(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.delete(
        "/api/connected-systems/salesforce-fsc-customer0/record-binding?objectType=Contact",
        headers={"Authorization": "Bearer HCT:test"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "disconnected"
    assert service.disconnected_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
    }


def test_batch_record_binding_statuses_are_owner_scoped_and_identifier_free(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.get(
        "/api/connected-systems/record-bindings",
        headers={"Authorization": "Bearer HCT:test"},
    )

    assert response.status_code == 200
    assert service.binding_payload == {"user_id": "user_123"}
    assert response.json()["bindings"] == [
        {
            "systemId": "salesforce-fsc-customer0",
            "objectType": "Contact",
            "status": "unbound",
        }
    ]
    assert "recordId" not in response.text


def test_search_route_uses_verified_owner_identity(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/search",
        headers={"Authorization": "Bearer HCT:test"},
        json={"objectType": "Contact", "returnFields": ["LeadSource", "MailingCity"]},
    )

    assert response.status_code == 200
    assert response.json()["bindingStatus"] == "active"
    assert service.search_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "return_fields": ["LeadSource", "MailingCity"],
        "force_refresh": False,
    }


def test_update_intent_route_resolves_bound_record_id(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/update-intents",
        headers={"Authorization": "Bearer HCT:test"},
        json={
            "objectType": "Contact",
            "additionalFields": {"MailingCity": "New York"},
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert service.updated_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "record_id": None,
        "record_fields": {"MailingCity": "New York"},
        "readback_locator": None,
        "locked_field_names": {"Email", "Phone", "FirstName", "LastName"},
    }


def test_delete_route_resolves_bound_record_id(monkeypatch):
    service = FakeConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/delete",
        headers={"Authorization": "Bearer HCT:test"},
        json={"objectType": "Contact"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    assert response.json()["action"] == "delete"
    assert service.deleted_payload == {
        "user_id": "user_123",
        "system_id": "salesforce-fsc-customer0",
        "object_type": "Contact",
        "record_id": None,
    }


def test_delete_route_returns_403_when_service_blocks_delete(monkeypatch):
    service = FakeBlockedDeleteConnectedSystemsService()
    monkeypatch.setattr(connected_systems, "get_connected_systems_service", lambda: service)
    client = TestClient(_build_app())

    response = client.post(
        "/api/connected-systems/salesforce-fsc-customer0/records/delete",
        headers={"Authorization": "Bearer HCT:test"},
        json={"objectType": "Contact"},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "CRM_DELETE_BLOCKED"
