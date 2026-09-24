import base64
import hashlib
import time
import uuid
from typing import Any
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    scope_handle_for_machine_scope,
)
from hushh_mcp.services import information_request_service as information_request_module
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.information_request_service import (
    InformationRequestError,
    InformationRequestService,
)


@pytest.mark.asyncio
async def test_submission_receipt_requires_owner_bound_creation_key(monkeypatch):
    service = InformationRequestService()
    key = "synthetic-submission-key-123"
    owner = "owner-a"
    digest = hashlib.sha256(f"{owner}|{key}".encode()).hexdigest()
    bundle_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"hussh:information-request:{digest}"))
    read = AsyncMock(return_value={"bundleId": bundle_id})
    stored = AsyncMock(return_value=({"idempotency_hash": digest}, []))
    monkeypatch.setattr(service, "get", read)
    monkeypatch.setattr(service, "_bundle", stored)
    assert await service.verify_submission_receipt(
        requester_user_id=owner, bundle_id=bundle_id, idempotency_key=key
    ) == {"bundleId": bundle_id}
    read.assert_awaited_once_with(requester_user_id=owner, bundle_id=bundle_id)
    with pytest.raises(InformationRequestError):
        await service.verify_submission_receipt(
            requester_user_id="owner-b", bundle_id=bundle_id, idempotency_key=key
        )
    assert read.await_count == 1
    assert stored.await_count == 2


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
    """``events`` is the current state per request id; ``ledger`` is every row.

    Mirrors the real ledger's contract that EXPORT_READ is an audit trail, not
    a state transition: it lands in the ledger but never replaces the state.
    """

    def __init__(self) -> None:
        self.events: dict[str, dict[str, Any]] = {}
        self.ledger: list[dict[str, Any]] = []
        self.exports: dict[str, dict[str, Any]] = {}

    async def get_request_status(self, _user_id: str, request_id: str):
        return self.events.get(request_id)

    async def get_consent_export(self, token_id: str):
        return self.exports.get(token_id)

    async def record_export_read_once(self, **event):
        now = int(time.time() * 1000)
        if any(
            row["action"] == "EXPORT_READ"
            and row["user_id"] == event["user_id"]
            and row["request_id"] == event["request_id"]
            and now - row["issued_at"] < 3_600_000
            for row in self.ledger
        ):
            return None
        return await self.insert_event(action="EXPORT_READ", **event)

    async def insert_event(self, **event):
        row = {**event, "issued_at": int(time.time() * 1000)}
        self.ledger.append(row)
        if event["action"] != "EXPORT_READ":
            self.events[event["request_id"]] = row
        return len(self.ledger)


class _Service(InformationRequestService):
    def __init__(self) -> None:
        self.consent = _Consent()
        self.connector_public_key = base64.b64encode(bytes(range(32))).decode("ascii")
        super().__init__(profiles=_Profiles(), consent_db=self.consent)
        self.bundle: dict[str, Any] | None = None
        self.items: list[dict[str, Any]] = []

    async def _viewer(self, _user_id: str):
        return {
            "public_person_ref": "22222222-2222-4222-8222-222222222222",
            "display_name": "Viewer",
            "photo_url": "https://example.test/viewer.png",
        }

    async def _connector(self, _user_id: str, connector_key_id: str):
        return {
            "connector_key_id": connector_key_id,
            "connector_public_key": self.connector_public_key,
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
                "connector_key_id": params["key_id"],
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


_CREATE = dict(
    requester_user_id="viewer",
    person_ref="11111111-1111-4111-8111-111111111111",
    scope_refs=["psr_opaque"],
    purpose="Complete an employment verification workflow",
    duration_seconds=604800,
    connector_key_id="client-key",
    idempotency_key="stable-idempotency-key",
)

_CURRENT_STRICT_EXPORT = {
    "is_strict_zero_knowledge": True,
    "refresh_status": "current",
    "envelope_version": 2,
    "encrypted_data": "ciphertext",
    "iv": "iv",
    "tag": "tag",
    "wrapped_key_bundle": {"alg": "x25519-aes-gcm", "connector_key_id": "client-key"},
    "scope": "attr.identity.legal_name",
    "export_revision": 3,
    "export_generated_at": "2026-09-14T00:00:00Z",
    "export_id": "exp_1",
    "envelope_aad": "aad",
    "envelope_aad_sha256": "aad-sha",
    "ciphertext_sha256": "ct-sha",
    "ciphertext_bytes": 10,
    "payload_algorithm": "AES-256-GCM",
}


# What create() stamps on the REQUESTED row for the viewer fixture, and what
# every follow-on row written by the requester's actions must carry.
_REQUESTER_IDENTITY = {
    "requester_actor_type": "person",
    "requester_label": "Viewer",
    "requester_entity_id": "22222222-2222-4222-8222-222222222222",
    "requester_image_url": "https://example.test/viewer.png",
    "developer_app_id": "agent_one",
}


async def _granted_service() -> tuple[_Service, str, str]:
    """A created bundle whose single item the owner has approved."""
    service = _Service()
    created = await service.create(**_CREATE)
    request_id = created["items"][0]["requestId"]
    service.consent.events[request_id] = {
        **service.consent.events[request_id],
        "action": "CONSENT_GRANTED",
        "token_id": "tok_granted",
        # Approval replaces the request deadline with the grant's access expiry.
        "expires_at": 1_900_000_000_000,
    }
    metadata = service.consent.events[request_id]["metadata"]
    service.consent.exports["tok_granted"] = {
        **_CURRENT_STRICT_EXPORT,
        "consent_token": "tok_granted",
        "user_id": "subject",
        "grant_id": request_id,
        "app_id": "agent_one",
        "scope_handle": metadata["scope_handle"],
        "connector_key_id": "client-key",
        "recipient_key_fingerprint": metadata["recipient_key_fingerprint"],
        "envelope_aad": {
            "version": 2,
            "app_id": "agent_one",
            "grant_id": request_id,
            "export_id": "exp_1",
            "revision": 3,
            "machine_scope": service.items[0]["scope"],
            "scope_handle": metadata["scope_handle"],
            "recipient_key_fingerprint": metadata["recipient_key_fingerprint"],
            "expires_at_ms": 1_900_000_000_000,
            "payload_algorithm": "AES-256-GCM",
        },
    }
    return service, created["bundleId"], request_id


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
    metadata = event["metadata"]
    assert metadata["requester_actor_type"] == "person"
    assert metadata["requester_image_url"] == "https://example.test/viewer.png"
    assert metadata["developer_app_id"] == "agent_one"
    assert metadata["scope_handle"] == scope_handle_for_machine_scope(
        "subject", "attr.identity.legal_name"
    )
    assert metadata["expiry_hours"] == 168
    assert metadata["scope_contract_version"] == 2
    assert metadata["recipient_key_fingerprint"] == connector_key_fingerprint(
        service.connector_public_key
    )
    assert metadata["connector_public_key_fingerprint"] == "fingerprint"
    assert metadata["request_url"].endswith(
        f"requestId={event['request_id']}&bundleId={first['bundleId']}"
    )


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
    assert service.consent.events[request_id]["action"] == "CANCELLED"


@pytest.mark.asyncio
async def test_cancel_writes_cancelled_and_requester_reads_cancelled() -> None:
    service = _Service()
    created = await service.create(**_CREATE)
    request_id = created["items"][0]["requestId"]
    cancelled = await service.cancel(requester_user_id="viewer", bundle_id=created["bundleId"])
    event = service.consent.events[request_id]
    assert event["action"] == "CANCELLED"
    assert event["metadata"] == {
        **_REQUESTER_IDENTITY,
        "cancelled_by_requester": True,
        "bundle_id": created["bundleId"],
    }
    assert cancelled["items"][0]["status"] == "cancelled"
    refreshed = await service.get(requester_user_id="viewer", bundle_id=created["bundleId"])
    assert refreshed["items"][0]["status"] == "cancelled"


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


@pytest.mark.asyncio
async def test_duration_must_match_hour_based_approval_contract() -> None:
    service = _Service()
    with pytest.raises(ValueError, match="whole number of hours"):
        await service.create(
            requester_user_id="viewer",
            person_ref="11111111-1111-4111-8111-111111111111",
            scope_refs=["psr_opaque"],
            purpose="Complete an employment verification workflow",
            duration_seconds=3_601,
            connector_key_id="client-key",
            idempotency_key="stable-idempotency-key",
        )


@pytest.mark.asyncio
async def test_timeout_is_reported_as_expired() -> None:
    service = _Service()
    created = await service.create(
        requester_user_id="viewer",
        person_ref="11111111-1111-4111-8111-111111111111",
        scope_refs=["psr_opaque"],
        purpose="Complete an employment verification workflow",
        duration_seconds=604800,
        connector_key_id="client-key",
        idempotency_key="stable-idempotency-key",
    )
    request_id = created["items"][0]["requestId"]
    service.consent.events[request_id]["action"] = "TIMEOUT"
    refreshed = await service.get(requester_user_id="viewer", bundle_id=created["bundleId"])
    assert refreshed["items"][0]["status"] == "expired"


@pytest.mark.asyncio
async def test_expired_grant_is_not_reported_as_current_access() -> None:
    service = _Service()
    created = await service.create(
        requester_user_id="viewer",
        person_ref="11111111-1111-4111-8111-111111111111",
        scope_refs=["psr_opaque"],
        purpose="Complete an employment verification workflow",
        duration_seconds=604800,
        connector_key_id="client-key",
        idempotency_key="stable-idempotency-key",
    )
    request_id = created["items"][0]["requestId"]
    service.consent.events[request_id].update({"action": "CONSENT_GRANTED", "expires_at": 1})
    refreshed = await service.get(requester_user_id="viewer", bundle_id=created["bundleId"])
    assert refreshed["items"][0]["status"] == "expired"


@pytest.mark.asyncio
async def test_exports_records_export_read_once_per_hour_per_request(monkeypatch) -> None:
    service, bundle_id, request_id = await _granted_service()
    clock = {"now": 1_800_000_000.0}
    monkeypatch.setattr(information_request_module.time, "time", lambda: clock["now"])

    first = await service.exports(requester_user_id="viewer", bundle_id=bundle_id)
    assert first["exports"][0]["encryptedExport"]["encrypted_data"] == "ciphertext"
    clock["now"] += 30 * 60
    await service.exports(requester_user_id="viewer", bundle_id=bundle_id)

    reads = [row for row in service.consent.ledger if row["action"] == "EXPORT_READ"]
    assert len(reads) == 1
    assert reads[0]["user_id"] == "subject"
    assert reads[0]["agent_id"] == "one_person:22222222-2222-4222-8222-222222222222"
    assert reads[0]["scope"] == "attr.identity.legal_name"
    assert reads[0]["request_id"] == request_id
    # The person's name and picture travel with the row: the owner's history
    # must never headline a read with the raw principal id.
    assert reads[0]["metadata"] == {
        **_REQUESTER_IDENTITY,
        "bundle_id": bundle_id,
        "export_revision": 3,
    }

    clock["now"] += 31 * 60
    await service.exports(requester_user_id="viewer", bundle_id=bundle_id)
    reads = [row for row in service.consent.ledger if row["action"] == "EXPORT_READ"]
    assert len(reads) == 2

    # The audit row never demotes the grant the requester is reading.
    refreshed = await service.get(requester_user_id="viewer", bundle_id=bundle_id)
    assert refreshed["items"][0]["status"] == "granted"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("surface", "field", "invalid"),
    [
        ("status", "agent_id", "one_person:someone-else"),
        ("status", "scope", "attr.professional.other"),
        ("status", "expires_at", 1),
        ("metadata", "bundle_id", "another-bundle"),
        ("export", "user_id", "another-owner"),
        ("export", "scope", "attr.professional.other"),
        ("export", "grant_id", "another-request"),
        ("export", "app_id", "another-app"),
        ("export", "connector_key_id", "another-key"),
        ("export", "export_revision", 99),
        ("aad", "grant_id", "another-request"),
        ("aad", "expires_at_ms", 1),
        ("aad", "recipient_key_fingerprint", "another-key"),
        ("aad", "revision", "invalid"),
    ],
)
async def test_exports_rejects_swapped_or_expired_bindings_without_read_receipt(
    surface: str, field: str, invalid: object
) -> None:
    service, bundle_id, request_id = await _granted_service()
    if surface == "status":
        service.consent.events[request_id][field] = invalid
    elif surface == "metadata":
        service.consent.events[request_id]["metadata"][field] = invalid
    elif surface == "aad":
        service.consent.exports["tok_granted"]["envelope_aad"][field] = invalid
    else:
        service.consent.exports["tok_granted"][field] = invalid

    result = await service.exports(requester_user_id="viewer", bundle_id=bundle_id)
    assert result["exports"] == []
    assert not any(row["action"] == "EXPORT_READ" for row in service.consent.ledger)


@pytest.mark.asyncio
async def test_exports_writes_nothing_when_no_item_is_granted() -> None:
    service = _Service()
    created = await service.create(**_CREATE)
    result = await service.exports(requester_user_id="viewer", bundle_id=created["bundleId"])
    assert result["exports"] == []
    assert [row["action"] for row in service.consent.ledger] == ["REQUESTED"]


def test_owner_status_map_renders_export_read_as_opened() -> None:
    assert ConsentCenterService._map_action_to_status("EXPORT_READ") == "opened"
    assert ConsentCenterService._map_next_action("opened", "history") == "none"


def _history_row(action: str, issued_at: int, metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": issued_at,
        "request_id": "req_1",
        "action": action,
        "scope": "attr.identity.legal_name",
        "agent_id": "one_person:22222222-2222-4222-8222-222222222222",
        "issued_at": issued_at,
        "expires_at": None,
        "metadata": metadata,
    }


def test_trailing_export_read_does_not_headline_the_owner_history_group() -> None:
    """A read of a live grant is an event in the trail, never the trail's state.

    The owner's history takes the newest row as the group's face. If a read
    could be that row, the grant would render as "opened" instead of approved,
    lose its stop control, and (with thinner metadata) fall back to the raw
    principal id for the person's name.
    """
    identity = {"requester_actor_type": "person", "requester_label": "Priya"}
    rows = [
        # Newest first, as get_audit_log returns them. The read carries only
        # what the ledger write stamps, which here deliberately omits the
        # label, to prove the group does not depend on it.
        _history_row("EXPORT_READ", 300, {"bundle_id": "b1", "export_revision": 3}),
        _history_row("CONSENT_GRANTED", 200, {**identity, "bundle_id": "b1"}),
        _history_row("REQUESTED", 100, {**identity, "bundle_id": "b1"}),
    ]
    service = ConsentCenterService.__new__(ConsentCenterService)
    entries = [service._normalize_history(row) for row in rows]
    grouped = ConsentCenterService._group_history_identifier_trails(entries)

    assert len(grouped) == 1
    group = grouped[0]
    assert group["status"] == "approved"
    assert group["action"] == "CONSENT_GRANTED"
    assert group["counterpart_label"] == "Priya"
    assert group["identifier_label"] == "Priya"
    # The grant's own control survives; "opened" would have collapsed it.
    assert group["allowed_next_action"] == "open_workspace"
    assert len(group["consent_trails"]) == 1
    trail = group["consent_trails"][0]
    assert trail["status"] == "approved"
    assert trail["action"] == "CONSENT_GRANTED"
    assert [event["action"] for event in trail["events"]] == [
        "EXPORT_READ",
        "CONSENT_GRANTED",
        "REQUESTED",
    ]
    assert [event["status"] for event in trail["events"]] == [
        "opened",
        "approved",
        "request_pending",
    ]


def test_trailing_export_read_does_not_headline_the_requestor_group() -> None:
    """The per-person group takes the newest state row, not the newest read."""
    identity = {"requester_actor_type": "person", "requester_label": "Priya"}
    rows = [
        _history_row("EXPORT_READ", 300, {**identity, "bundle_id": "b1"}),
        _history_row("CONSENT_GRANTED", 200, {**identity, "bundle_id": "b1"}),
        _history_row("REQUESTED", 100, {**identity, "bundle_id": "b1"}),
    ]
    service = ConsentCenterService.__new__(ConsentCenterService)
    entries = [service._normalize_history(row) for row in rows]

    # Order of arrival must not matter: the read is newest either way.
    for ordered in (entries, list(reversed(entries))):
        grouped = service._group_by_requestor(ordered)
        assert len(grouped) == 1
        group = grouped[0]
        assert group["status"] == "approved"
        assert group["latest_request_at"] == 300
        assert group["request_count"] == 3


def test_history_group_with_only_a_read_still_renders() -> None:
    """Nothing else in the trail: the read is all there is, so it is the face."""
    service = ConsentCenterService.__new__(ConsentCenterService)
    entries = [
        service._normalize_history(
            _history_row("EXPORT_READ", 300, {"requester_label": "Priya", "bundle_id": "b1"})
        )
    ]
    grouped = ConsentCenterService._group_history_identifier_trails(entries)
    assert len(grouped) == 1
    assert grouped[0]["status"] == "opened"


class _AuditQuery:
    """In-memory consent_audit query honoring the filters the ledger reads apply."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self._filters: list[tuple[str, str, Any]] = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self._filters.append(("eq", key, value))
        return self

    def neq(self, key, value):
        self._filters.append(("neq", key, value))
        return self

    def in_(self, key, values):
        self._filters.append(("in", key, list(values)))
        return self

    def gt(self, key, value):
        self._filters.append(("gt", key, value))
        return self

    def order(self, key, desc=False):
        self._rows = sorted(self._rows, key=lambda row: row[key], reverse=desc)
        return self

    def limit(self, count):
        self._limit = count
        return self

    def execute(self):
        rows = list(self._rows)
        for kind, key, value in self._filters:
            if kind == "eq":
                rows = [row for row in rows if row.get(key) == value]
            elif kind == "neq":
                rows = [row for row in rows if row.get(key) != value]
            elif kind == "in":
                rows = [row for row in rows if row.get(key) in value]
            elif kind == "gt":
                rows = [row for row in rows if (row.get(key) or 0) > value]
        rows = rows[: getattr(self, "_limit", None)]

        class _Result:
            data = rows
            count = None

        return _Result()


class _AuditDb:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def table(self, name):
        assert name == "consent_audit"
        return _AuditQuery(self._rows)


@pytest.mark.asyncio
async def test_ledger_keeps_granted_current_under_a_later_export_read(monkeypatch) -> None:
    rows = [
        {
            "id": 1,
            "token_id": "tok_granted",
            "request_id": "req_1",
            "action": "CONSENT_GRANTED",
            "scope": "attr.identity.legal_name",
            "agent_id": "one_person:22222222-2222-4222-8222-222222222222",
            "user_id": "subject",
            "issued_at": 100,
            "metadata": '{"bundle_id": "bundle_1"}',
        },
        {
            "id": 2,
            "token_id": "evt_200",
            "request_id": "req_1",
            "action": "EXPORT_READ",
            "scope": "attr.identity.legal_name",
            "agent_id": "one_person:22222222-2222-4222-8222-222222222222",
            "user_id": "subject",
            "issued_at": 200,
            "metadata": '{"bundle_id": "bundle_1", "export_revision": 3}',
        },
    ]
    monkeypatch.setattr(ConsentDBService, "_get_db", lambda self: _AuditDb(rows))
    status = await ConsentDBService().get_request_status("subject", "req_1")
    assert status is not None
    assert status["action"] == "CONSENT_GRANTED"
    assert status["token_id"] == "tok_granted"


def _requested_row(request_id: str, issued_at: int, poll_timeout_at: int) -> dict[str, Any]:
    return {
        "id": issued_at,
        "token_id": f"evt_{issued_at}",
        "request_id": request_id,
        "action": "REQUESTED",
        "scope": "attr.identity.legal_name",
        "agent_id": "one_person:22222222-2222-4222-8222-222222222222",
        "user_id": "subject",
        "issued_at": issued_at,
        "poll_timeout_at": poll_timeout_at,
        "expires_at": None,
        "metadata": '{"bundle_id": "bundle_1", "requester_actor_type": "person"}',
    }


@pytest.mark.asyncio
async def test_requester_cancel_stops_owner_reminders(monkeypatch) -> None:
    """A withdrawn request must not keep paging the owner until it times out."""
    far_future_ms = int(time.time() * 1000) + 60 * 60 * 1000
    rows = [
        _requested_row("req_open", 100, far_future_ms),
        _requested_row("req_withdrawn", 100, far_future_ms),
        {
            **_requested_row("req_withdrawn", 200, far_future_ms),
            "action": "CANCELLED",
            "metadata": '{"bundle_id": "bundle_1", "cancelled_by_requester": true}',
        },
    ]
    monkeypatch.setattr(ConsentDBService, "_get_db", lambda self: _AuditDb(rows))
    candidates = await ConsentDBService().get_pending_notification_candidates()
    assert [row["request_id"] for row in candidates] == ["req_open"]


@pytest.mark.asyncio
async def test_stream_backfill_replays_the_grant_not_the_read(monkeypatch) -> None:
    """The stream consumer dedupes by request id, so a later read must not shadow the grant."""
    rows = [
        {
            **_requested_row("req_1", 100, 0),
            "token_id": "tok_granted",
            "action": "CONSENT_GRANTED",
        },
        {
            **_requested_row("req_1", 200, 0),
            "action": "EXPORT_READ",
            "metadata": '{"bundle_id": "bundle_1", "export_revision": 3}',
        },
    ]
    monkeypatch.setattr(ConsentDBService, "_get_db", lambda self: _AuditDb(rows))
    events = await ConsentDBService().get_recent_consent_events("subject", after_timestamp_ms=0)
    assert [event["action"] for event in events] == ["CONSENT_GRANTED"]


@pytest.mark.asyncio
async def test_export_read_notify_is_not_pushed_to_the_owner(monkeypatch) -> None:
    """The ledger row is the owner's record; a push would read as a resolution."""
    import json
    from unittest.mock import AsyncMock

    from api import consent_listener

    enrich = AsyncMock(side_effect=lambda data: data)
    developer_queue = AsyncMock()
    dispatch = AsyncMock()
    monkeypatch.setattr(consent_listener, "_enrich_notify_payload", enrich)
    monkeypatch.setattr(consent_listener, "_push_to_developer_consent_queues", developer_queue)
    monkeypatch.setattr(consent_listener, "_dispatch_notification_for_user", dispatch)

    base = {"user_id": "subject", "request_id": "req_1", "scope": "attr.identity.legal_name"}
    await consent_listener._handle_notify(json.dumps({**base, "action": "EXPORT_READ"}))
    assert dispatch.await_count == 0
    assert developer_queue.await_count == 0

    await consent_listener._handle_notify(json.dumps({**base, "action": "CONSENT_GRANTED"}))
    assert dispatch.await_count == 1
    assert developer_queue.await_count == 1
