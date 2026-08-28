from typing import Any

import pytest

from hushh_mcp.services.information_request_service import InformationRequestService


class _Profiles:
    def resolve_scope_refs(self, **_kwargs):
        return {"user_id": "subject"}, [
            {
                "scopeRef": "psr_opaque",
                "scope": "attr.identity.legal_name",
                "label": "Legal name",
                "description": "Name used on official records",
                "sensitivity": "sensitive",
            }
        ]


class _Consent:
    def __init__(self) -> None:
        self.events: dict[str, dict[str, Any]] = {}

    async def get_request_status(self, _user_id: str, request_id: str):
        return self.events.get(request_id)

    async def insert_event(self, **event):
        self.events[event["request_id"]] = {**event, "action": event["action"]}
        return 1


class _Service(InformationRequestService):
    def __init__(self) -> None:
        self.consent = _Consent()
        super().__init__(profiles=_Profiles(), consent_db=self.consent)
        self.bundle: dict[str, Any] | None = None
        self.items: list[dict[str, Any]] = []

    async def _viewer(self, _user_id: str):
        return {
            "public_person_ref": "22222222-2222-4222-8222-222222222222",
            "display_name": "Viewer",
        }

    async def _connector(self, _user_id: str, connector_key_id: str):
        return {
            "connector_key_id": connector_key_id,
            "connector_public_key": "public-key",
            "connector_wrapping_alg": "x25519-aes-gcm",
            "public_key_fingerprint": "fingerprint",
        }

    async def _rows(self, sql: str, params: dict[str, Any]):
        if "SELECT bundle_id, request_fingerprint FROM one_information_request_bundles" in sql:
            return (
                [
                    {
                        "bundle_id": self.bundle["bundle_id"],
                        "request_fingerprint": self.bundle["request_fingerprint"],
                    }
                ]
                if self.bundle
                else []
            )
        if "INSERT INTO one_information_request_bundles" in sql:
            self.bundle = {
                "bundle_id": params["bundle"],
                "requester_user_id": params["requester"],
                "subject_user_id": params["subject"],
                "requester_principal": params["principal"],
                "request_fingerprint": params["fingerprint"],
                "purpose": params["purpose"],
                "duration_seconds": params["duration"],
                "public_person_ref": "11111111-1111-4111-8111-111111111111",
                "cancelled_at": None,
            }
            return [{"bundle_id": params["bundle"]}]
        if "INSERT INTO one_information_request_items" in sql:
            if not any(item["request_id"] == params["request"] for item in self.items):
                self.items.append(
                    {
                        "request_id": params["request"],
                        "scope_ref": params["scope_ref"],
                        "scope": params["scope"],
                        "label": params["label"],
                        "sensitivity": params["sensitivity"],
                    }
                )
            return [{"request_id": params["request"]}]
        return []

    async def _bundle(self, requester_user_id: str, _bundle_id: str):
        assert self.bundle and self.bundle["requester_user_id"] == requester_user_id
        return self.bundle, self.items


@pytest.mark.asyncio
async def test_create_uses_person_specific_principal_and_is_idempotent() -> None:
    service = _Service()
    create = dict(
        requester_user_id="viewer",
        person_ref="11111111-1111-4111-8111-111111111111",
        scope_refs=["psr_opaque"],
        purpose="Complete an employment verification workflow",
        duration_seconds=604800,
        connector_key_id="client-key",
        idempotency_key="stable-idempotency-key",
    )
    first = await service.create(**create)
    second = await service.create(**create)
    assert first["bundleId"] == second["bundleId"]
    assert len(service.consent.events) == 1
    event = next(iter(service.consent.events.values()))
    assert event["agent_id"] == "one_person:22222222-2222-4222-8222-222222222222"
    assert event["scope"] == "attr.identity.legal_name"


@pytest.mark.asyncio
async def test_retry_repairs_missing_consent_event_after_item_insert() -> None:
    service = _Service()
    create = dict(
        requester_user_id="viewer",
        person_ref="11111111-1111-4111-8111-111111111111",
        scope_refs=["psr_opaque"],
        purpose="Complete an employment verification workflow",
        duration_seconds=604800,
        connector_key_id="client-key",
        idempotency_key="stable-idempotency-key",
    )
    await service.create(**create)
    service.consent.events.clear()
    await service.create(**create)
    assert len(service.consent.events) == 1


@pytest.mark.asyncio
async def test_cancel_repairs_scope_when_consent_event_is_missing() -> None:
    service = _Service()
    create = dict(
        requester_user_id="viewer",
        person_ref="11111111-1111-4111-8111-111111111111",
        scope_refs=["psr_opaque"],
        purpose="Complete an employment verification workflow",
        duration_seconds=604800,
        connector_key_id="client-key",
        idempotency_key="stable-idempotency-key",
    )
    created = await service.create(**create)
    request_id = created["items"][0]["requestId"]
    service.consent.events.clear()
    await service.cancel(requester_user_id="viewer", bundle_id=created["bundleId"])
    assert service.consent.events[request_id]["scope"] == "attr.identity.legal_name"
    assert service.consent.events[request_id]["action"] == "CONSENT_DENIED"


@pytest.mark.asyncio
async def test_idempotency_key_cannot_be_replayed_for_different_request() -> None:
    service = _Service()
    create = dict(
        requester_user_id="viewer",
        person_ref="11111111-1111-4111-8111-111111111111",
        scope_refs=["psr_opaque"],
        purpose="Complete an employment verification workflow",
        duration_seconds=604800,
        connector_key_id="client-key",
        idempotency_key="stable-idempotency-key",
    )
    await service.create(**create)
    with pytest.raises(ValueError, match="already bound"):
        await service.create(**{**create, "purpose": "A different approved business purpose"})
