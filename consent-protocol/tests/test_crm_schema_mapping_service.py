from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.services.crm_schema_mapping_service import (
    CrmSchemaMappingError,
    CrmSchemaMappingService,
    InMemoryCrmSchemaMappingStore,
)


class FakeMapper:
    model_name = "gemini-3.5-flash"

    def __init__(self, response: dict | None):
        self.response = response
        self.calls: list[dict] = []

    async def map_schema(self, schema_projection: dict):
        self.calls.append(schema_projection)
        return self.response


def schema(*, additional_field: bool = False) -> dict:
    fields = [
        {"key": "Email", "label": "Email", "dataType": "email", "required": True},
        {"key": "Phone", "label": "Phone", "dataType": "phone", "required": True},
        {"key": "FirstName", "label": "First name", "dataType": "string"},
        {"key": "LastName", "label": "Last name", "dataType": "string", "required": True},
    ]
    if additional_field:
        fields.append({"key": "MailingStreet", "label": "Address", "dataType": "string"})
    return {
        "systemId": "crm_demo",
        "objectType": "Contact",
        "objectMetadata": {"name": "Contact", "label": "Contact"},
        "fields": fields,
    }


def mapping(*, email: str = "Email") -> dict:
    return {
        "mappings": {
            "email": {"fieldKey": email, "confidence": 0.99, "reason": "email field"},
            "phone": {"fieldKey": "Phone", "confidence": 0.99, "reason": "phone field"},
            "firstName": {"fieldKey": "FirstName", "confidence": 0.96, "reason": "given name"},
            "lastName": {"fieldKey": "LastName", "confidence": 0.96, "reason": "family name"},
            "fullName": None,
            "address": None,
        }
    }


def test_schema_mapping_cache_hits_and_fingerprint_refreshes() -> None:
    store = InMemoryCrmSchemaMappingStore()
    mapper = FakeMapper(mapping())
    service = CrmSchemaMappingService(store=store, mapper=mapper)

    first = asyncio.run(service.resolve(crm_id="crm_demo", schema=schema()))
    second = asyncio.run(service.resolve(crm_id="crm_demo", schema=schema()))
    refreshed = asyncio.run(
        service.resolve(crm_id="crm_demo", schema=schema(additional_field=True))
    )

    assert first.mapping["email"] == "Email"
    assert second.source == "cache"
    assert refreshed.schema_fingerprint != first.schema_fingerprint
    assert len(mapper.calls) == 2


def test_schema_mapper_receives_only_public_schema_metadata() -> None:
    mapper = FakeMapper(mapping())
    service = CrmSchemaMappingService(store=InMemoryCrmSchemaMappingStore(), mapper=mapper)

    asyncio.run(service.resolve(crm_id="crm_demo", schema=schema()))

    sent = json.dumps(mapper.calls[0], sort_keys=True)
    assert "user" not in sent.lower()
    assert "record" not in sent.lower()
    assert "credential" not in sent.lower()
    assert "consent" not in sent.lower()
    assert "vault" not in sent.lower()
    assert {"key", "label", "type", "required", "constraints"} <= set(mapper.calls[0]["fields"][0])


def test_hallucinated_or_incomplete_mapping_fails_closed() -> None:
    mapper = FakeMapper(mapping(email="NotARealField"))
    service = CrmSchemaMappingService(store=InMemoryCrmSchemaMappingStore(), mapper=mapper)

    with pytest.raises(CrmSchemaMappingError):
        asyncio.run(service.resolve(crm_id="crm_demo", schema=schema()))


def test_model_failure_keeps_the_crm_unavailable() -> None:
    mapper = FakeMapper(None)
    service = CrmSchemaMappingService(store=InMemoryCrmSchemaMappingStore(), mapper=mapper)

    with pytest.raises(CrmSchemaMappingError):
        asyncio.run(service.resolve(crm_id="crm_demo", schema=schema()))
    assert len(mapper.calls) == 1


def test_explicitly_unwriteable_onboarding_field_is_rejected() -> None:
    candidate = schema()
    candidate["fields"][0]["createable"] = False
    mapper = FakeMapper(mapping())
    service = CrmSchemaMappingService(store=InMemoryCrmSchemaMappingStore(), mapper=mapper)

    with pytest.raises(CrmSchemaMappingError):
        asyncio.run(service.resolve(crm_id="crm_demo", schema=candidate))
