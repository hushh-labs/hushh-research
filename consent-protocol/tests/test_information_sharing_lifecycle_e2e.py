"""Deterministic end-to-end proof that consent and information sharing work.

Two people, one app. The requester (a signed-in person with a client-held
X25519 connector key) asks the owner for records through
``/api/one/information-requests``; the owner decides through ``/api/consent``.
Both routers are mounted on one FastAPI app and the acting user is a
``ContextVar`` the dependency overrides read, so a test switches sides the way
two phones would.

Everything below the routes is real: the request service, the approval route's
envelope and connector verification, token issuance, the lifecycle service for
deny and revoke, and the consent center's projections. Only the ledger
(``consent_audit`` + ``consent_exports``), the two correlation tables the
request service owns, the identity cache, and the scope catalogue are
in-memory fakes, and the fake ledger is SHARED by every service so the trail a
test reads is the trail the routes wrote.

The cryptography is real too: the owner side encrypts under a fresh export key
wrapped to the requester's connector key (``tests.helpers.consent_export_crypto``),
and the requester side decrypts with the private key that never left the test.
Offline by construction: no database, no network, no clock control.
"""

from __future__ import annotations

import contextvars
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import pytest_asyncio
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import FastAPI
from httpx import ASGITransport

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import consent
from api.routes.one import information_requests
from hushh_mcp.consent.export_envelope import ConsentExportAadV2, connector_key_fingerprint
from hushh_mcp.consent.export_projection import decrypt_scoped_export_package
from hushh_mcp.services import consent_center_service
from hushh_mcp.services.consent_lifecycle_service import ConsentLifecycleService
from hushh_mcp.services.information_request_service import (
    InformationRequestError,
    InformationRequestService,
)
from tests.helpers.consent_export_crypto import (
    encrypt_export_for_connector,
    generate_connector_key,
)
from tests.test_consent_handshake import _FakeConsentDBService, _NoOpRIAIAMService

REQUESTER = "e2e-requester"
OWNER = "e2e-owner"
REQUESTER_PERSON_REF = "22222222-2222-4222-8222-222222222222"
OWNER_PERSON_REF = "11111111-1111-4111-8111-111111111111"
REQUESTER_LABEL = "Priya Raman"
REQUESTER_PRINCIPAL = f"one_person:{REQUESTER_PERSON_REF}"
CONNECTOR_KEY_ID = "requester-phone-key-1"
PURPOSE = "Confirm the name on the lease before we sign it"
HOUR_MS = 60 * 60 * 1000

# The opaque references the requester's screen would hold, and what they
# resolve to. The real resolver reads the owner's catalogue; this one is the
# only seam the test fakes on the request side.
_CATALOGUE = {
    "psr_legal_name": {
        "scopeRef": "psr_legal_name",
        "scope": "attr.identity.legal_name",
        "label": "Legal name",
        "description": "Name used on official records",
        "sensitivity": "sensitive",
    },
    "psr_job_title": {
        "scopeRef": "psr_job_title",
        "scope": "attr.professional.employment.title",
        "label": "Job title",
        "description": "Current job title",
        "sensitivity": "standard",
    },
}

# Identifiers that must never cross the requester-facing export boundary.
_INTERNAL_IDENTIFIER_KEYS = {"token_id", "consent_token", "user_id", "grant_id", "app_id"}

_acting_user: contextvars.ContextVar[str] = contextvars.ContextVar("acting_user", default=OWNER)


# ============================================================================
# Fakes: one ledger shared by every service
# ============================================================================


class _Ledger(_FakeConsentDBService):
    """The handshake fake, extended with everything the sharing lifecycle reads.

    ``events`` is the append-only ``consent_audit`` (every row carries ``id``
    and a strictly increasing ``issued_at``); ``pending`` and ``active`` are
    the derived views the base class maintains; ``exports`` is
    ``consent_exports`` keyed by consent token.
    """

    def __init__(self) -> None:
        super().__init__()
        self.exports: dict[str, dict[str, Any]] = {}
        self._last_issued_at = 0

    def _next_issued_at(self) -> int:
        now_ms = int(time.time() * 1000)
        self._last_issued_at = max(self._last_issued_at + 1, now_ms)
        return self._last_issued_at

    async def insert_event(self, **kwargs):
        row = {"id": len(self.events) + 1, "issued_at": self._next_issued_at(), **kwargs}
        count = await super().insert_event(**row)
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        if row.get("action") == "REQUESTED" and row.get("request_id"):
            self._add_pending(
                str(row["request_id"]),
                {
                    "request_id": row["request_id"],
                    "user_id": row.get("user_id"),
                    "agent_id": row.get("agent_id"),
                    "scope": row.get("scope"),
                    "scope_description": row.get("scope_description"),
                    "issued_at": row["issued_at"],
                    "poll_timeout_at": row.get("poll_timeout_at"),
                    "metadata": metadata,
                    "requester_label": metadata.get("requester_label"),
                    "requester_image_url": metadata.get("requester_image_url"),
                    "request_url": metadata.get("request_url"),
                    "reason": metadata.get("reason"),
                    "bundle_id": metadata.get("bundle_id"),
                    "bundle_scope_count": metadata.get("bundle_scope_count"),
                },
            )
        return count

    async def record_export_read_once(
        self,
        *,
        user_id: str,
        agent_id: str,
        scope: str,
        request_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> int | None:
        # Model the ledger port here; database concurrency is proved by the
        # ConsentDBService tests rather than this in-memory lifecycle fixture.
        recent = [
            event["issued_at"]
            for event in self.events
            if event.get("action") == "EXPORT_READ"
            and event.get("user_id") == user_id
            and event.get("request_id") == request_id
        ]
        if recent and int(time.time() * 1000) - max(recent) < HOUR_MS:
            return None
        return await self.insert_event(
            user_id=user_id,
            agent_id=agent_id,
            scope=scope,
            action="EXPORT_READ",
            request_id=request_id,
            metadata=metadata,
        )

    async def get_request_status(self, user_id: str, request_id: str):
        # Mirrors the real query: EXPORT_READ is a trail row, never the state.
        rows = [
            event
            for event in self.events
            if self._normalize_identifier(event.get("user_id"))
            == self._normalize_identifier(user_id)
            and event.get("request_id") == request_id
            and event.get("action") != "EXPORT_READ"
        ]
        if not rows:
            return None
        latest = max(rows, key=lambda event: event["issued_at"])
        return {**latest, "bundle_id": (latest.get("metadata") or {}).get("bundle_id")}

    async def get_audit_log(self, user_id, page=1, limit=50, *, user_ids=None):
        result = await super().get_audit_log(user_id, page=page, limit=limit, user_ids=user_ids)
        items = sorted(result["items"], key=lambda event: event["issued_at"], reverse=True)
        start = (page - 1) * limit
        return {**result, "items": items[start : start + limit]}

    async def store_consent_export(self, **kwargs):
        await super().store_consent_export(**kwargs)
        bundle = kwargs.get("wrapped_key_bundle") or {}
        self.exports[kwargs["consent_token"]] = {
            "consent_token": kwargs["consent_token"],
            "user_id": kwargs["user_id"],
            "encrypted_data": kwargs["encrypted_data"],
            "iv": kwargs["iv"],
            "tag": kwargs["tag"],
            "scope": kwargs["scope"],
            "expires_at": kwargs["expires_at_ms"],
            "wrapped_key_bundle": bundle,
            "connector_key_id": bundle.get("connector_key_id"),
            "connector_wrapping_alg": bundle.get("wrapping_alg"),
            "export_revision": int(kwargs.get("export_revision") or 1),
            "export_generated_at": kwargs.get("export_generated_at") or "2026-09-14T00:00:00Z",
            "source_content_revision": kwargs.get("source_content_revision"),
            "source_manifest_revision": kwargs.get("source_manifest_revision"),
            "refresh_status": kwargs.get("refresh_status") or "current",
            "refresh_policy": kwargs.get("refresh_policy") or "snapshot",
            "export_id": kwargs.get("export_id"),
            "envelope_version": int(kwargs.get("envelope_version") or 1),
            "grant_id": kwargs.get("grant_id"),
            "app_id": kwargs.get("app_id"),
            "scope_handle": kwargs.get("scope_handle"),
            "recipient_key_fingerprint": kwargs.get("recipient_key_fingerprint"),
            "payload_algorithm": kwargs.get("payload_algorithm") or "AES-256-GCM",
            "envelope_aad": kwargs.get("envelope_aad"),
            "envelope_aad_sha256": kwargs.get("envelope_aad_sha256"),
            "ciphertext_sha256": kwargs.get("ciphertext_sha256"),
            "ciphertext_bytes": kwargs.get("ciphertext_bytes"),
            "is_strict_zero_knowledge": bool(bundle.get("wrapped_export_key")),
            "legacy_export_key_present": False,
        }
        return True

    async def get_consent_export(self, consent_token: str):
        export = self.exports.get(consent_token)
        if not export or int(export["expires_at"]) <= int(time.time() * 1000):
            return None
        return dict(export)

    async def get_consent_export_metadata(self, consent_token: str):
        export = await self.get_consent_export(consent_token)
        if not export:
            return None
        return {key: value for key, value in export.items() if key not in {"encrypted_data"}}

    async def delete_consent_export(self, consent_token: str):
        return self.exports.pop(consent_token, None) is not None


class _Identity:
    """The identity cache: one account per person, nothing to hydrate."""

    async def list_account_identifiers(self, user_id: str) -> list[str]:
        return [user_id]

    async def ensure_many(self, user_ids) -> dict[str, dict[str, Any]]:
        return {}


class _Connections:
    def list_requests(self, *_args, **_kwargs):
        return []


class _Profiles:
    def resolve_scope_refs(self, *, viewer_user_id: str, public_person_ref: str, scope_refs):
        assert viewer_user_id == REQUESTER
        assert public_person_ref == OWNER_PERSON_REF
        unknown = [ref for ref in scope_refs if ref not in _CATALOGUE]
        if unknown:
            raise ValueError("One or more requested fields are unavailable.")
        return {"user_id": OWNER}, [dict(_CATALOGUE[ref]) for ref in scope_refs]


@dataclass
class _World:
    ledger: _Ledger
    connector_private: X25519PrivateKey
    connector_public_b64: str
    bundles: dict[str, dict[str, Any]] = field(default_factory=dict)
    items: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


class _RequestService(InformationRequestService):
    """The real service over in-memory correlation tables and the shared ledger."""

    def __init__(self, world: _World) -> None:
        super().__init__(profiles=_Profiles(), consent_db=world.ledger)
        self._world = world

    async def _viewer(self, user_id: str):
        if user_id != REQUESTER:
            raise InformationRequestError("Your public profile is not ready.", status_code=409)
        return {
            "public_person_ref": REQUESTER_PERSON_REF,
            "display_name": REQUESTER_LABEL,
            "photo_url": "https://example.test/priya.png",
        }

    async def _connector(self, user_id: str, connector_key_id: str):
        if user_id != REQUESTER or connector_key_id != CONNECTOR_KEY_ID:
            raise InformationRequestError(
                "Register an active client-held connector key before requesting information.",
                status_code=409,
            )
        return {
            "connector_key_id": CONNECTOR_KEY_ID,
            "connector_public_key": self._world.connector_public_b64,
            "connector_wrapping_alg": "X25519-AES256-GCM",
            "public_key_fingerprint": connector_key_fingerprint(self._world.connector_public_b64),
        }

    async def _rows(self, sql: str, params: dict[str, Any]):
        world = self._world
        if "SELECT bundle_id, request_fingerprint FROM one_information_request_bundles" in sql:
            return [
                {
                    "bundle_id": bundle["bundle_id"],
                    "request_fingerprint": bundle["request_fingerprint"],
                }
                for bundle in world.bundles.values()
                if bundle["requester_user_id"] == params["requester"]
                and bundle["idempotency_hash"] == params["idem"]
            ][:1]
        if "INSERT INTO one_information_request_bundles" in sql:
            if any(
                bundle["requester_user_id"] == params["requester"]
                and bundle["idempotency_hash"] == params["idem"]
                for bundle in world.bundles.values()
            ):
                return []
            world.bundles[params["bundle"]] = {
                "bundle_id": params["bundle"],
                "requester_user_id": params["requester"],
                "subject_user_id": params["subject"],
                "requester_principal": params["principal"],
                "idempotency_hash": params["idem"],
                "request_fingerprint": params["fingerprint"],
                "purpose": params["purpose"],
                "duration_seconds": params["duration"],
                "connector_key_id": params["key_id"],
                "public_person_ref": OWNER_PERSON_REF,
                "cancelled_at": None,
            }
            world.items[params["bundle"]] = []
            return [{"bundle_id": params["bundle"]}]
        if "INSERT INTO one_information_request_items" in sql:
            items = world.items.setdefault(params["bundle"], [])
            if not any(item["request_id"] == params["request"] for item in items):
                items.append(
                    {
                        "request_id": params["request"],
                        "scope_ref": params["scope_ref"],
                        "scope": params["scope"],
                        "label": params["label"],
                        "sensitivity": params["sensitivity"],
                    }
                )
            return [{"request_id": params["request"]}]
        if "UPDATE one_information_request_bundles SET cancelled_at" in sql:
            bundle = world.bundles.get(params["bundle"])
            if bundle is None:
                return []
            bundle["cancelled_at"] = bundle["cancelled_at"] or int(time.time() * 1000)
            return [{"bundle_id": params["bundle"]}]
        raise AssertionError(f"unexpected SQL in the offline lifecycle test: {sql[:80]}")

    async def _bundle(self, requester_user_id: str, bundle_id: str):
        bundle = self._world.bundles.get(bundle_id)
        if bundle is None or bundle["requester_user_id"] != requester_user_id:
            raise InformationRequestError("Information request was not found.", status_code=404)
        return bundle, list(self._world.items.get(bundle_id, []))


# ============================================================================
# App wiring
# ============================================================================


async def _owned_identifiers(user_id: str) -> list[str]:
    return [user_id]


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> _World:
    ledger = _Ledger()
    connector_private, connector_public_b64 = generate_connector_key()
    built = _World(
        ledger=ledger,
        connector_private=connector_private,
        connector_public_b64=connector_public_b64,
    )

    monkeypatch.setattr(consent, "ConsentDBService", lambda: ledger)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)
    monkeypatch.setattr(consent, "ActorIdentityService", _Identity)
    monkeypatch.setattr(consent, "_owned_consent_identifiers", _owned_identifiers)
    monkeypatch.setattr(consent, "_consent_exports", {})
    monkeypatch.setattr(consent_center_service, "ConsentDBService", lambda: ledger)
    monkeypatch.setattr(consent_center_service, "ActorIdentityService", _Identity)
    monkeypatch.setattr(consent_center_service, "RIAIAMService", _NoOpRIAIAMService)
    monkeypatch.setattr(consent_center_service, "ConnectionsService", _Connections)
    monkeypatch.setenv("ONE_LOCATION_CONSENT_CENTER_ENABLED", "0")
    monkeypatch.setenv("MARKETPLACE_CONSENT_CENTER_ENABLED", "0")
    monkeypatch.setattr(information_requests, "_service", lambda: _RequestService(built))
    return built


@pytest_asyncio.fixture
async def client(world: _World):
    app = FastAPI()
    app.include_router(information_requests.router)
    app.include_router(consent.router)

    # Async overrides so the ContextVar is read in the request's own task.
    async def _vault_owner() -> dict[str, str]:
        return {"user_id": _acting_user.get()}

    async def _firebase() -> str:
        return _acting_user.get()

    app.dependency_overrides[require_vault_owner_token] = _vault_owner
    app.dependency_overrides[require_firebase_auth] = _firebase
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://e2e") as c:
        yield c


# ============================================================================
# Lifecycle steps, each driven through the app as the right person
# ============================================================================


async def _create_request(
    client: httpx.AsyncClient,
    *,
    scope_refs: list[str],
    duration_hours: int,
    idempotency_key: str,
    connector_key_id: str = CONNECTOR_KEY_ID,
) -> dict[str, Any]:
    _acting_user.set(REQUESTER)
    resp = await client.post(
        "/api/one/information-requests",
        json={
            "person_ref": OWNER_PERSON_REF,
            "scope_refs": scope_refs,
            "purpose": PURPOSE,
            "duration_seconds": duration_hours * 3600,
            "connector_key_id": connector_key_id,
            "idempotency_key": idempotency_key,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _requester_view(client: httpx.AsyncClient, bundle_id: str) -> dict[str, Any]:
    _acting_user.set(REQUESTER)
    resp = await client.get(f"/api/one/information-requests/{bundle_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _owner_lookup(client: httpx.AsyncClient, request_id: str) -> dict[str, Any]:
    _acting_user.set(OWNER)
    resp = await client.get(
        "/api/consent/pending/lookup",
        params={"userId": OWNER, "request_id": request_id},
    )
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    assert [item["request_id"] for item in items] == [request_id]
    return items[0]


def _owner_encrypts(
    world: _World,
    pending: dict[str, Any],
    *,
    plaintext: dict[str, Any],
    shown_duration_hours: int,
    connector_key_id: str = CONNECTOR_KEY_ID,
) -> dict[str, Any]:
    """What the owner's browser does: encrypt for the requester's connector key.

    The expiry in the authenticated envelope is the duration the approval
    screen SHOWS (the request's own duration), not whatever number the device
    later puts in ``durationHours``.
    """
    metadata = pending["metadata"]
    aad = ConsentExportAadV2(
        app_id=metadata["developer_app_id"],
        grant_id=pending["request_id"],
        export_id=str(uuid.uuid4()),
        revision=1,
        machine_scope=pending["scope"],
        scope_handle=metadata["scope_handle"],
        recipient_key_fingerprint=connector_key_fingerprint(metadata["connector_public_key"]),
        expires_at_ms=int(time.time() * 1000) + shown_duration_hours * HOUR_MS,
    )
    return encrypt_export_for_connector(
        plaintext,
        connector_public_key_b64=metadata["connector_public_key"],
        connector_key_id=connector_key_id,
        aad=aad,
    )


async def _approve(
    client: httpx.AsyncClient,
    world: _World,
    request_id: str,
    *,
    plaintext: dict[str, Any],
    duration_hours: int,
    connector_key_id: str = CONNECTOR_KEY_ID,
) -> httpx.Response:
    pending = await _owner_lookup(client, request_id)
    package = _owner_encrypts(
        world,
        pending,
        plaintext=plaintext,
        shown_duration_hours=int(pending["metadata"]["expiry_hours"]),
        connector_key_id=connector_key_id,
    )
    _acting_user.set(OWNER)
    return await client.post(
        "/api/consent/pending/approve",
        json={
            "userId": OWNER,
            "requestId": request_id,
            "durationHours": duration_hours,
            "sourceContentRevision": 1,
            "sourceManifestRevision": 1,
            **package,
        },
    )


async def _deny(client: httpx.AsyncClient, request_id: str) -> dict[str, Any]:
    _acting_user.set(OWNER)
    resp = await client.post(
        "/api/consent/pending/deny", params={"userId": OWNER, "requestId": request_id}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _revoke(client: httpx.AsyncClient, *, scope: str, request_id: str) -> dict[str, Any]:
    _acting_user.set(OWNER)
    resp = await client.post(
        "/api/consent/revoke",
        json={"userId": OWNER, "scope": scope, "requestId": request_id},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _cancel(client: httpx.AsyncClient, bundle_id: str) -> dict[str, Any]:
    _acting_user.set(REQUESTER)
    resp = await client.post(f"/api/one/information-requests/{bundle_id}/cancel")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _exports(client: httpx.AsyncClient, bundle_id: str) -> dict[str, Any]:
    _acting_user.set(REQUESTER)
    resp = await client.get(f"/api/one/information-requests/{bundle_id}/exports")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _owner_center(client: httpx.AsyncClient, surface: str) -> list[dict[str, Any]]:
    _acting_user.set(OWNER)
    resp = await client.get("/api/consent/center/list", params={"surface": surface, "limit": 100})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["surface"] == surface
    return body["items"]


def _requester_decrypts(world: _World, encrypted_export: dict[str, Any]) -> dict[str, Any]:
    return decrypt_scoped_export_package(
        wrapped_key_bundle=encrypted_export["wrapped_key_bundle"],
        iv_b64=encrypted_export["iv"],
        tag_b64=encrypted_export["tag"],
        ciphertext=encrypted_export["encrypted_data"],
        connector_private_key=world.connector_private,
        export_envelope=encrypted_export["export_envelope"],
    )


def _events(world: _World, action: str) -> list[dict[str, Any]]:
    return [event for event in world.ledger.events if event["action"] == action]


def _keys_outside_aad(value: Any, *, path: tuple[str, ...] = ()) -> set[str]:
    """Every dict key in a JSON body, except inside the authenticated ``aad``.

    The AAD is the one place the requester must see ``grant_id`` and ``app_id``:
    it is byte-for-byte what the owner authenticated and the decrypt fails
    without it. Everything else in the response is a projection and must not
    carry an internal identifier.
    """
    found: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if path[-1:] == ("export_envelope",) and key == "aad":
                continue
            found.add(str(key))
            found |= _keys_outside_aad(child, path=(*path, str(key)))
    elif isinstance(value, list):
        for child in value:
            found |= _keys_outside_aad(child, path=path)
    return found


# ============================================================================
# Tests
# ============================================================================


@pytest.mark.asyncio
async def test_request_creates_pending_for_owner_and_replay_is_idempotent(client, world):
    created = await _create_request(
        client,
        scope_refs=["psr_legal_name", "psr_job_title"],
        duration_hours=72,
        idempotency_key="lease-signing-2026-09-14",
    )
    assert created["personRef"] == OWNER_PERSON_REF
    assert created["durationSeconds"] == 72 * 3600
    assert created["cancelled"] is False
    assert [item["status"] for item in created["items"]] == ["pending", "pending"]
    assert [item["label"] for item in created["items"]] == ["Legal name", "Job title"]

    requested = _events(world, "REQUESTED")
    assert len(requested) == 2
    for event in requested:
        assert event["user_id"] == OWNER
        assert event["agent_id"] == REQUESTER_PRINCIPAL
        metadata = event["metadata"]
        assert metadata["expiry_hours"] == 72
        assert metadata["connector_public_key"] == world.connector_public_b64
        assert metadata["connector_key_id"] == CONNECTOR_KEY_ID
        assert metadata["connector_wrapping_alg"] == "X25519-AES256-GCM"
        assert metadata["recipient_key_fingerprint"] == connector_key_fingerprint(
            world.connector_public_b64
        )
        assert metadata["requester_actor_type"] == "person"
        assert metadata["requester_label"] == REQUESTER_LABEL
        assert metadata["bundle_id"] == created["bundleId"]
        assert metadata["reason"] == PURPOSE
    assert {event["scope"] for event in requested} == {
        "attr.identity.legal_name",
        "attr.professional.employment.title",
    }

    replayed = await _create_request(
        client,
        scope_refs=["psr_legal_name", "psr_job_title"],
        duration_hours=72,
        idempotency_key="lease-signing-2026-09-14",
    )
    assert replayed["bundleId"] == created["bundleId"]
    assert len(_events(world, "REQUESTED")) == 2, "a replay must not write a third request"
    assert len(world.bundles) == 1

    # The owner's pending surface names the person, never the storage scope.
    pending = await _owner_center(client, "pending")
    assert len(pending) == 2
    for entry in pending:
        assert entry["status"] == "pending"
        assert entry["counterpart_type"] == "person"
        assert entry["counterpart_label"] == REQUESTER_LABEL
        assert entry["reason"] == PURPOSE
        assert entry["metadata"]["bundle_id"] == created["bundleId"]
        for shown in (entry["counterpart_label"], entry["scope_description"], entry["reason"]):
            assert "attr." not in str(shown)
    assert {entry["scope_description"] for entry in pending} == {
        "Name used on official records",
        "Current job title",
    }

    # The projection the private agent reads aloud carries no scope at all.
    spoken = await ConsentLifecycleService(consent_db=world.ledger).list_pending_incoming(OWNER)
    assert len(spoken) == 2
    assert {row["requesterLabel"] for row in spoken} == {REQUESTER_LABEL}
    assert "attr." not in json.dumps(spoken)


@pytest.mark.asyncio
async def test_approval_clamps_duration_and_requester_decrypts_strict_v2_export(client, world):
    created = await _create_request(
        client,
        scope_refs=["psr_legal_name"],
        duration_hours=72,
        idempotency_key="lease-signing-approve-1",
    )
    bundle_id = created["bundleId"]
    request_id = created["items"][0]["requestId"]
    plaintext = {"identity": {"legal_name": "Alex Morgan"}}

    resp = await _approve(client, world, request_id, plaintext=plaintext, duration_hours=168)
    assert resp.status_code == 200, resp.text
    approved = resp.json()
    assert approved["status"] == "approved"
    assert approved["bundle_id"] == bundle_id
    assert approved["granted_scope"] == "attr.identity.legal_name"
    assert approved["coverage_kind"] == "exact"

    # 168h asked for, 72h shown: the grant is 72h and says so.
    granted = _events(world, "CONSENT_GRANTED")
    assert len(granted) == 1
    assert granted[0]["user_id"] == OWNER
    assert granted[0]["request_id"] == request_id
    assert granted[0]["metadata"]["approved_duration_hours"] == 72
    assert granted[0]["metadata"]["bundle_id"] == bundle_id
    assert abs(granted[0]["expires_at"] - (int(time.time() * 1000) + 72 * HOUR_MS)) < 5 * 60 * 1000
    assert abs(approved["expires_at"] - granted[0]["expires_at"]) < 1000

    # The stored export is strict zero knowledge, envelope v2, current.
    token = approved["consent_token"]
    stored = world.ledger.exports[token]
    assert stored["is_strict_zero_knowledge"] is True
    assert stored["envelope_version"] == 2
    assert stored["refresh_status"] == "current"
    assert stored["connector_key_id"] == CONNECTOR_KEY_ID
    assert stored["grant_id"] == request_id
    assert stored["app_id"] == "agent_one"
    assert stored["recipient_key_fingerprint"] == connector_key_fingerprint(
        world.connector_public_b64
    )
    assert json.dumps(plaintext, separators=(",", ":")) not in json.dumps(stored)

    # The requester sees granted, pulls the package, and only they can open it.
    assert (await _requester_view(client, bundle_id))["items"][0]["status"] == "granted"
    exports = await _exports(client, bundle_id)
    assert exports["bundleId"] == bundle_id
    assert len(exports["exports"]) == 1
    export = exports["exports"][0]
    assert export["requestId"] == request_id
    assert export["scopeRef"] == "psr_legal_name"
    encrypted = export["encryptedExport"]
    assert encrypted["status"] == "success"
    assert encrypted["export_envelope"]["version"] == 2
    assert encrypted["export_refresh_status"] == "current"
    assert encrypted["request_id"] == request_id
    assert _requester_decrypts(world, encrypted) == plaintext

    # No internal identifier crosses the requester-facing boundary.
    leaked = _keys_outside_aad(exports) & _INTERNAL_IDENTIFIER_KEYS
    assert not leaked, leaked
    assert encrypted["export_envelope"]["aad"]["grant_id"] == request_id
    assert encrypted["export_envelope"]["aad"]["app_id"] == "agent_one"
    assert token not in json.dumps(exports)
    assert OWNER not in json.dumps(exports)

    # A wrong private key cannot open it: the package is bound to the connector.
    stranger_private, _stranger_public = generate_connector_key()
    with pytest.raises(InvalidTag):
        decrypt_scoped_export_package(
            wrapped_key_bundle=encrypted["wrapped_key_bundle"],
            iv_b64=encrypted["iv"],
            tag_b64=encrypted["tag"],
            ciphertext=encrypted["encrypted_data"],
            connector_private_key=stranger_private,
            export_envelope=encrypted["export_envelope"],
        )

    # The read left the owner an "opened" record for this request, once.
    await _exports(client, bundle_id)
    reads = _events(world, "EXPORT_READ")
    assert len(reads) == 1
    assert reads[0]["user_id"] == OWNER
    assert reads[0]["request_id"] == request_id
    assert reads[0]["metadata"]["bundle_id"] == bundle_id
    assert reads[0]["metadata"]["requester_label"] == REQUESTER_LABEL
    assert (await _requester_view(client, bundle_id))["items"][0]["status"] == "granted"


@pytest.mark.asyncio
async def test_wrong_connector_key_id_is_refused_before_any_grant(client, world):
    created = await _create_request(
        client,
        scope_refs=["psr_legal_name"],
        duration_hours=24,
        idempotency_key="lease-signing-wrong-key-1",
    )
    bundle_id = created["bundleId"]
    request_id = created["items"][0]["requestId"]

    resp = await _approve(
        client,
        world,
        request_id,
        plaintext={"identity": {"legal_name": "Alex Morgan"}},
        duration_hours=24,
        connector_key_id="someone-elses-key",
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Connector key id does not match request."

    assert _events(world, "CONSENT_GRANTED") == []
    assert world.ledger.exports == {}
    assert world.ledger.export_writes == []
    assert world.ledger.active == {}
    assert consent._consent_exports == {}
    assert request_id in world.ledger.pending
    assert (await _requester_view(client, bundle_id))["items"][0]["status"] == "pending"
    assert (await _exports(client, bundle_id))["exports"] == []


@pytest.mark.asyncio
async def test_deny_leaves_no_export_and_history_carries_the_bundle(client, world):
    created = await _create_request(
        client,
        scope_refs=["psr_legal_name"],
        duration_hours=24,
        idempotency_key="lease-signing-deny-1",
    )
    bundle_id = created["bundleId"]
    request_id = created["items"][0]["requestId"]

    denied = await _deny(client, request_id)
    assert denied["status"] == "denied"

    assert world.ledger.exports == {}
    assert world.ledger.export_writes == []
    assert request_id not in world.ledger.pending
    events = _events(world, "CONSENT_DENIED")
    assert len(events) == 1
    assert events[0]["user_id"] == OWNER
    assert events[0]["request_id"] == request_id
    assert events[0]["metadata"]["bundle_id"] == bundle_id
    assert events[0]["metadata"]["requester_label"] == REQUESTER_LABEL

    assert (await _requester_view(client, bundle_id))["items"][0]["status"] == "denied"
    assert (await _exports(client, bundle_id))["exports"] == []
    assert await _owner_center(client, "pending") == []

    previous = await _owner_center(client, "previous")
    assert len(previous) == 1
    group = previous[0]
    assert group["status"] == "denied"
    assert group["action"] == "CONSENT_DENIED"
    assert group["request_id"] == request_id
    assert group["counterpart_label"] == REQUESTER_LABEL
    assert group["metadata"]["bundle_id"] == bundle_id
    trail = group["consent_trails"][0]
    assert trail["request_ids"] == [request_id]
    assert [event["status"] for event in trail["events"]] == ["denied", "request_pending"]


@pytest.mark.asyncio
async def test_revoke_deletes_the_export_and_links_the_original_request(client, world):
    created = await _create_request(
        client,
        scope_refs=["psr_legal_name"],
        duration_hours=24,
        idempotency_key="lease-signing-revoke-1",
    )
    bundle_id = created["bundleId"]
    request_id = created["items"][0]["requestId"]
    plaintext = {"identity": {"legal_name": "Alex Morgan"}}
    resp = await _approve(client, world, request_id, plaintext=plaintext, duration_hours=24)
    assert resp.status_code == 200, resp.text
    token = resp.json()["consent_token"]
    assert token in world.ledger.exports
    assert token in consent._consent_exports
    assert len((await _exports(client, bundle_id))["exports"]) == 1

    revoked = await _revoke(client, scope="attr.identity.legal_name", request_id=request_id)
    assert revoked["status"] == "revoked"
    assert revoked["lockVault"] is False

    assert token not in world.ledger.exports
    assert token not in consent._consent_exports
    assert world.ledger.active == {}
    events = _events(world, "REVOKED")
    assert len(events) == 1
    assert events[0]["user_id"] == OWNER
    assert events[0]["request_id"] == request_id
    assert events[0]["scope"] == "attr.identity.legal_name"
    assert events[0]["token_id"].startswith("REVOKED_")

    assert (await _requester_view(client, bundle_id))["items"][0]["status"] == "revoked"
    assert (await _exports(client, bundle_id))["exports"] == []
    assert await _owner_center(client, "active") == []

    # The owner's history headlines the revocation and keeps the whole trail.
    previous = await _owner_center(client, "previous")
    assert len(previous) == 1
    group = previous[0]
    assert group["status"] == "revoked"
    assert group["action"] == "REVOKED"
    assert group["request_id"] == request_id
    assert group["counterpart_type"] == "person"
    assert group["scope_description"] != "attr.identity.legal_name"
    trail = group["consent_trails"][0]
    assert trail["request_ids"] == [request_id]
    assert [event["status"] for event in trail["events"]] == [
        "revoked",
        "opened",
        "approved",
        "request_pending",
    ]


@pytest.mark.asyncio
async def test_revoke_headline_names_the_requester_on_the_owner_history(client, world):
    created = await _create_request(
        client,
        scope_refs=["psr_legal_name"],
        duration_hours=24,
        idempotency_key="lease-signing-revoke-headline-1",
    )
    bundle_id = created["bundleId"]
    request_id = created["items"][0]["requestId"]
    resp = await _approve(
        client,
        world,
        request_id,
        plaintext={"identity": {"legal_name": "Alex Morgan"}},
        duration_hours=24,
    )
    assert resp.status_code == 200, resp.text
    await _exports(client, bundle_id)
    await _revoke(client, scope="attr.identity.legal_name", request_id=request_id)

    revoked = _events(world, "REVOKED")[0]
    previous = await _owner_center(client, "previous")
    assert previous[0]["request_id"] == request_id
    assert previous[0]["counterpart_label"] == REQUESTER_LABEL, revoked
    assert previous[0]["metadata"].get("bundle_id") == bundle_id, revoked
    assert (revoked.get("metadata") or {}).get("requester_label") == REQUESTER_LABEL
    assert "connector_public_key" not in revoked["metadata"]
    assert "connector_key_id" not in revoked["metadata"]


@pytest.mark.asyncio
async def test_requester_cancel_records_cancelled_and_empties_the_owner_queue(client, world):
    created = await _create_request(
        client,
        scope_refs=["psr_legal_name", "psr_job_title"],
        duration_hours=24,
        idempotency_key="lease-signing-cancel-1",
    )
    bundle_id = created["bundleId"]
    request_ids = [item["requestId"] for item in created["items"]]
    assert len(await _owner_center(client, "pending")) == 2

    cancelled = await _cancel(client, bundle_id)
    assert cancelled["cancelled"] is True
    assert [item["status"] for item in cancelled["items"]] == ["cancelled", "cancelled"]

    events = _events(world, "CANCELLED")
    assert sorted(event["request_id"] for event in events) == sorted(request_ids)
    for event in events:
        assert event["user_id"] == OWNER
        assert event["agent_id"] == REQUESTER_PRINCIPAL
        assert event["metadata"]["cancelled_by_requester"] is True
        assert event["metadata"]["bundle_id"] == bundle_id
        assert event["metadata"]["requester_label"] == REQUESTER_LABEL
    assert world.ledger.pending == {}

    _acting_user.set(OWNER)
    resp = await client.get("/api/consent/pending", params={"userId": OWNER})
    assert resp.status_code == 200, resp.text
    assert resp.json()["pending"] == []
    assert await _owner_center(client, "pending") == []

    # Cancelling twice is harmless: nothing is pending, so nothing is written.
    await _cancel(client, bundle_id)
    assert len(_events(world, "CANCELLED")) == 2


@pytest.mark.asyncio
async def test_audit_trail_shows_every_decision_to_the_owner(client, world):
    """After the whole lifecycle, the owner's history and the handshake agree."""
    plaintext = {"identity": {"legal_name": "Alex Morgan"}}

    # A: approved, opened by the requester, then revoked by the owner.
    approved = await _create_request(
        client,
        scope_refs=["psr_legal_name"],
        duration_hours=24,
        idempotency_key="trail-approve-2026-09-14",
    )
    approved_id = approved["items"][0]["requestId"]
    resp = await _approve(client, world, approved_id, plaintext=plaintext, duration_hours=24)
    assert resp.status_code == 200, resp.text
    opened = await _exports(client, approved["bundleId"])
    assert _requester_decrypts(world, opened["exports"][0]["encryptedExport"]) == plaintext
    await _revoke(client, scope="attr.identity.legal_name", request_id=approved_id)

    # B: denied by the owner.
    denied = await _create_request(
        client,
        scope_refs=["psr_job_title"],
        duration_hours=24,
        idempotency_key="trail-deny-2026-09-14",
    )
    denied_id = denied["items"][0]["requestId"]
    await _deny(client, denied_id)

    # C: withdrawn by the requester.
    cancelled = await _create_request(
        client,
        scope_refs=["psr_legal_name"],
        duration_hours=24,
        idempotency_key="trail-cancel-2026-09-14",
    )
    cancelled_id = cancelled["items"][0]["requestId"]
    await _cancel(client, cancelled["bundleId"])

    # D: still waiting on the owner.
    waiting = await _create_request(
        client,
        scope_refs=["psr_job_title"],
        duration_hours=24,
        idempotency_key="trail-pending-2026-09-14",
    )
    waiting_id = waiting["items"][0]["requestId"]

    expected = {
        (approved_id, "request_pending"),
        (approved_id, "approved"),
        (approved_id, "opened"),
        (approved_id, "revoked"),
        (denied_id, "request_pending"),
        (denied_id, "denied"),
        (cancelled_id, "request_pending"),
        (cancelled_id, "cancelled"),
        (waiting_id, "request_pending"),
    }

    # The ledger itself: one row per decision, all on the owner's account.
    assert {
        (
            event["request_id"],
            consent_center_service.ConsentCenterService._map_action_to_status(event["action"]),
        )
        for event in world.ledger.events
    } == expected
    assert {event["user_id"] for event in world.ledger.events} == {OWNER}
    assert len(world.ledger.events) == len(expected)

    # The owner's history surface, through the route.
    previous = await _owner_center(client, "previous")
    seen = {
        (event["request_id"], event["status"])
        for group in previous
        for trail in group["consent_trails"]
        for event in trail["events"]
    }
    assert seen == expected
    assert sum(group["event_count"] for group in previous) == len(expected)
    assert {group["counterpart_type"] for group in previous} == {"person"}

    # The still-open request is the only thing waiting on the owner.
    pending = await _owner_center(client, "pending")
    assert [entry["request_id"] for entry in pending] == [waiting_id]

    # The handshake timeline with this requester tells the same story.
    _acting_user.set(OWNER)
    resp = await client.get(
        "/api/consent/handshake/history",
        params={"counterpart_id": REQUESTER_PRINCIPAL, "limit": 200},
    )
    assert resp.status_code == 200, resp.text
    handshake = resp.json()
    assert handshake["total"] == len(expected)
    assert {(entry["request_id"], entry["status"]) for entry in handshake["timeline"]} == expected
    assert [entry["issued_at"] for entry in handshake["timeline"]] == sorted(
        (entry["issued_at"] for entry in handshake["timeline"]), reverse=True
    )

    # And the requester's side agrees with every terminal state.
    assert (await _requester_view(client, approved["bundleId"]))["items"][0]["status"] == "revoked"
    assert (await _requester_view(client, denied["bundleId"]))["items"][0]["status"] == "denied"
    assert (await _requester_view(client, cancelled["bundleId"]))["items"][0][
        "status"
    ] == "cancelled"
    assert (await _requester_view(client, waiting["bundleId"]))["items"][0]["status"] == "pending"
