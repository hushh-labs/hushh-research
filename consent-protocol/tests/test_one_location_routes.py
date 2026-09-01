from __future__ import annotations

import inspect
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import location as one_location
from tests.services.test_one_location_agent_service import (
    PUBLIC_LOCATION_SNAPSHOT,
    FourUserMemoryService,
    encrypted_envelope,
)


class DatabaseExecutionError(Exception):
    code = "DATABASE_UNAVAILABLE"
    # Shaped like the real thing: db_client passes str(<the DBAPI error>), and
    # SQLAlchemy appends the statement plus every bound value to that.
    details = (
        "(psycopg2.OperationalError) connection failed\n"
        "[SQL: SELECT * FROM one_location_recipients WHERE phone = %s]\n"
        "[parameters: {'phone': '+919812345678'}]"
    )
    hint = "Retry later."
    status_code = 503


class _MemoryNearbyPresenceService:
    def purge_terminal(self, *, older_than_hours: float) -> dict[str, int]:
        assert older_than_hours > 0
        return {"expired": 0, "deleted": 0}


def _client(
    service: FourUserMemoryService, current_user: dict[str, str], monkeypatch
) -> TestClient:
    app = FastAPI()
    app.include_router(one_location.router)
    app.dependency_overrides[one_location.require_vault_owner_token] = lambda: {
        "user_id": current_user["user_id"]
    }
    monkeypatch.setattr(one_location, "_service", lambda: service)
    monkeypatch.setattr(
        one_location,
        "_nearby_presence_service",
        _MemoryNearbyPresenceService,
    )
    return TestClient(app, raise_server_exceptions=False)


def _register_key(client: TestClient, user: dict[str, str], user_id: str) -> None:
    user["user_id"] = user_id
    response = client.post(
        "/api/one/location/recipient-keys",
        json={
            "keyId": f"key-{user_id}",
            "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": user_id, "y": user_id},
        },
    )
    assert response.status_code == 200


def test_sms_contacts_api_is_owner_scoped_and_idempotent(monkeypatch) -> None:
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)
    _register_key(client, current_user, "user_b")
    service._seed_connection("user_a", "user_b")
    current_user["user_id"] = "user_a"

    first = client.post(
        "/api/one/location/sms-contacts",
        json={"recipientUserId": "user_b"},
    )
    second = client.post(
        "/api/one/location/sms-contacts",
        json={"recipientUserId": "user_b"},
    )
    assert first.status_code == 200
    assert first.json()["smsContactUserIds"] == ["user_b"]
    assert second.json()["smsContactUserIds"] == ["user_b"]

    current_user["user_id"] = "user_c"
    assert client.get("/api/one/location/state").json()["smsContactUserIds"] == []

    current_user["user_id"] = "user_a"
    removed = client.delete("/api/one/location/sms-contacts/user_b")
    removed_again = client.delete("/api/one/location/sms-contacts/user_b")
    assert removed.status_code == 200
    assert removed.json()["smsContactUserIds"] == []
    assert removed_again.json()["smsContactUserIds"] == []
    assert service.connections


def test_atomic_private_share_route_binds_owner_from_token(monkeypatch) -> None:
    class AtomicRouteProbe:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def create_grant_with_initial_envelope(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "grant": {"id": "grant-1", "status": "active"},
                "envelope": {"id": "envelope-1", "ciphertext": "ciphertext"},
                "idempotentReplay": False,
            }

    service = AtomicRouteProbe()
    current_user = {"user_id": "owner-from-token"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]
    captured_at = datetime.now(timezone.utc).isoformat()

    response = client.post(
        "/api/one/location/grants/with-envelope",
        json={
            "recipientUserId": "recipient",
            "recipientKeyId": "recipient-key",
            "durationHours": 1,
            "clientOperationId": "123e4567-e89b-12d3-a456-426614174000",
            "confirmedAt": captured_at,
            "shareKind": "check_in",
            "envelope": {
                **encrypted_envelope("recipient-key"),
                "capturedAt": captured_at,
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["idempotentReplay"] is False
    assert service.calls[0]["owner_user_id"] == "owner-from-token"
    assert service.calls[0]["recipient_user_id"] == "recipient"
    assert service.calls[0]["enforce_connection"] is True


def test_private_share_route_threads_until_stopped_duration_mode(monkeypatch) -> None:
    class GrantRouteProbe:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def create_grant(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "id": "grant-1",
                "status": "active",
                "durationMode": "until_stopped",
                "durationHours": None,
                "expiresAt": None,
            }

    service = GrantRouteProbe()
    current_user = {"user_id": "owner-from-token"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]

    response = client.post(
        "/api/one/location/grants",
        json={
            "recipientUserId": "recipient",
            "recipientKeyId": "recipient-key",
            "durationMode": "until_stopped",
        },
    )

    assert response.status_code == 200
    assert response.json()["grant"]["expiresAt"] is None
    assert service.calls[0]["duration_mode"] == "until_stopped"
    assert service.calls[0]["duration_hours"] is None
    assert service.calls[0]["enforce_connection"] is True


def test_auto_approval_route_threads_only_the_server_rule_version(monkeypatch) -> None:
    class ApprovalRouteProbe:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def approve_request(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "request": {"id": "request-1", "status": "approved"},
                "grant": {"id": "grant-1", "status": "active"},
            }

    service = ApprovalRouteProbe()
    current_user = {"user_id": "owner-from-token"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]
    response = client.post(
        "/api/one/location/requests/request-1/approve",
        json={
            "approvalMode": "automatic",
            "autoApproveRuleVersion": 7,
        },
    )

    assert response.status_code == 200
    assert service.calls == [
        {
            "owner_user_id": "owner-from-token",
            "request_id": "request-1",
            "approval_mode": "automatic",
            "duration_hours": None,
            "duration_mode": None,
            "auto_approve_rule_version": 7,
        }
    ]


def test_auto_approval_route_rejects_partial_or_unknown_context(monkeypatch) -> None:
    class RejectProbe:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def approve_request(self, **kwargs):
            self.calls.append(kwargs)
            raise AssertionError("invalid approval payload reached the service")

    service = RejectProbe()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]

    rejected_payloads = [
        {},
        {"durationHours": 1},
        {"durationHours": 1, "durationMode": "timed"},
        {"approvalMode": None},
        {"approvalMode": "legacy"},
        {"approvalMode": "manual", "autoApproveRuleVersion": 1},
        {"approvalMode": "automatic"},
        {"approvalMode": "automatic", "autoApproveRuleVersion": 0},
        {
            "approvalMode": "automatic",
            "autoApproveRuleVersion": 1,
            "durationHours": 1,
        },
        {
            "approvalMode": "automatic",
            "autoApproveRuleVersion": 1,
            "durationMode": "timed",
        },
        {"approvalMode": "manual", "autoApproveScopeKind": "all_contacts"},
        {
            "approvalMode": "manual",
            "autoApproveCircleId": "550e8400-e29b-41d4-a716-446655440000",
        },
        {"approvalMode": "manual", "autoApproveEnabledAt": "2026-08-24T09:00:00Z"},
        {"approvalMode": "manual", "automatic": True},
    ]

    for payload in rejected_payloads:
        response = client.post(
            "/api/one/location/requests/request-1/approve",
            json=payload,
        )
        assert response.status_code == 422, payload
    assert service.calls == []


def test_manual_approval_route_requires_explicit_intent(monkeypatch) -> None:
    class ApprovalRouteProbe:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def approve_request(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "request": {"id": "request-1", "status": "approved"},
                "grant": {"id": "grant-1", "status": "active"},
            }

    service = ApprovalRouteProbe()
    client = _client(service, {"user_id": "owner-from-token"}, monkeypatch)  # type: ignore[arg-type]

    response = client.post(
        "/api/one/location/requests/request-1/approve",
        json={"approvalMode": "manual", "durationHours": 1},
    )
    no_override_response = client.post(
        "/api/one/location/requests/request-2/approve",
        json={"approvalMode": "manual"},
    )

    assert response.status_code == 200
    assert no_override_response.status_code == 200
    assert service.calls == [
        {
            "owner_user_id": "owner-from-token",
            "request_id": "request-1",
            "approval_mode": "manual",
            "duration_hours": 1,
            "duration_mode": None,
            "auto_approve_rule_version": None,
        },
        {
            "owner_user_id": "owner-from-token",
            "request_id": "request-2",
            "approval_mode": "manual",
            "duration_hours": None,
            "duration_mode": None,
            "auto_approve_rule_version": None,
        },
    ]


def test_auto_approve_preference_route_binds_owner_and_scope(monkeypatch) -> None:
    class PreferenceRouteProbe:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def update_auto_approve_preference(self, **kwargs):
            self.calls.append(kwargs)
            return {
                "enabled": True,
                "scope": {"kind": "circle", "circleId": kwargs["circle_id"]},
                "enabledAt": "2026-08-24T09:00:00+00:00",
                "ruleVersion": 3,
            }

    service = PreferenceRouteProbe()
    current_user = {"user_id": "owner-from-token"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]
    circle_id = "550e8400-e29b-41d4-a716-446655440000"

    response = client.patch(
        "/api/one/location/auto-approve-preference",
        json={"enabled": True, "scopeKind": "circle", "circleId": circle_id},
    )

    assert response.status_code == 200
    assert service.calls == [
        {
            "user_id": "owner-from-token",
            "enabled": True,
            "scope_kind": "circle",
            "circle_id": circle_id,
        }
    ]


def test_nearby_check_in_preferences_route_reads_and_writes_the_owner(monkeypatch) -> None:
    class PreferenceRouteProbe:
        def __init__(self) -> None:
            self.get_calls: list[dict] = []
            self.update_calls: list[dict] = []

        def get_nearby_check_in_defaults(self, **kwargs):
            self.get_calls.append(kwargs)
            return {"visible": True, "allowConnectionRequests": False, "updatedAt": None}

        def update_nearby_check_in_defaults(self, **kwargs):
            self.update_calls.append(kwargs)
            return {
                "visible": kwargs["visible"],
                "allowConnectionRequests": kwargs["allow_connection_requests"],
                "updatedAt": "2026-08-26T09:00:00+00:00",
            }

    service = PreferenceRouteProbe()
    current_user = {"user_id": "owner-from-token"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]

    get_response = client.get("/api/one/location/nearby-check-in-preferences")
    assert get_response.status_code == 200
    assert get_response.json() == {
        "preferences": {"visible": True, "allowConnectionRequests": False, "updatedAt": None}
    }
    assert service.get_calls == [{"user_id": "owner-from-token"}]

    patch_response = client.patch(
        "/api/one/location/nearby-check-in-preferences",
        json={"visible": False, "allowConnectionRequests": True},
    )
    assert patch_response.status_code == 200
    assert service.update_calls == [
        {
            "user_id": "owner-from-token",
            "visible": False,
            "allow_connection_requests": True,
        }
    ]


def test_sos_voice_preference_route_reads_and_writes_the_owner(monkeypatch) -> None:
    class PreferenceRouteProbe:
        def __init__(self) -> None:
            self.get_calls: list[dict] = []
            self.update_calls: list[dict] = []

        def get_sos_voice_preference(self, **kwargs):
            self.get_calls.append(kwargs)
            return {"defaultAction": "open", "updatedAt": None}

        def update_sos_voice_preference(self, **kwargs):
            self.update_calls.append(kwargs)
            return {
                "defaultAction": kwargs["default_action"],
                "updatedAt": "2026-08-26T09:00:00+00:00",
            }

    service = PreferenceRouteProbe()
    current_user = {"user_id": "owner-from-token"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]

    get_response = client.get("/api/one/location/sos-voice-preference")
    assert get_response.status_code == 200
    assert get_response.json() == {"preference": {"defaultAction": "open", "updatedAt": None}}
    assert service.get_calls == [{"user_id": "owner-from-token"}]

    patch_response = client.patch(
        "/api/one/location/sos-voice-preference",
        json={"defaultAction": "trigger"},
    )
    assert patch_response.status_code == 200
    assert service.update_calls == [
        {
            "user_id": "owner-from-token",
            "default_action": "trigger",
        }
    ]

    invalid_response = client.patch(
        "/api/one/location/sos-voice-preference",
        json={"defaultAction": "not-a-real-choice"},
    )
    assert invalid_response.status_code == 422


def test_view_envelope_route_threads_allow_empty_query_param(monkeypatch) -> None:
    """The opt-in must reach the service, and must default to off.

    Off by default is the whole point: native bundles already in the field
    branch on the 404 LOCATION_ENVELOPE_MISSING contract, so a request that does
    not ask for the relaxed shape must keep getting the old one.
    """

    class ViewRouteProbe:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def view_latest_envelope(self, **kwargs):
            self.calls.append(kwargs)
            return {"grant": {"id": "grant-1"}, "envelope": None, "status": "awaiting"}

    service = ViewRouteProbe()
    current_user = {"user_id": "recipient-from-token"}
    client = _client(service, current_user, monkeypatch)  # type: ignore[arg-type]
    grant_id = "123e4567-e89b-12d3-a456-426614174000"

    default_response = client.get(f"/api/one/location/grants/{grant_id}/envelope")
    opted_in = client.get(f"/api/one/location/grants/{grant_id}/envelope?allow_empty=1")

    assert default_response.status_code == 200
    assert opted_in.status_code == 200
    assert service.calls[0]["allow_empty"] is False
    assert service.calls[1]["allow_empty"] is True
    # The recipient is always bound from the token, never from the query string.
    assert service.calls[1]["recipient_user_id"] == "recipient-from-token"
    assert service.calls[1]["grant_id"] == grant_id


def test_four_user_one_location_api_flow_is_authenticated_and_ciphertext_only(monkeypatch) -> None:
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)
    user_a = "user_a"
    user_b = "user_b"
    user_c = "user_c"
    user_d = "user_d"

    for user_id in (user_a, user_b, user_c, user_d):
        _register_key(client, current_user, user_id)

    # Direct location sharing is now scoped to connections: the owner may only
    # grant to someone they are connected with. Seed that connection so the
    # POST /location/grants direct-share path is authorized.
    service._seed_connection(user_a, user_b)

    current_user["user_id"] = user_a
    grant_b_response = client.post(
        "/api/one/location/grants",
        json={
            "recipientUserId": user_b,
            "recipientKeyId": f"key-{user_b}",
            "durationHours": 1,
        },
    )
    assert grant_b_response.status_code == 200
    grant_b = grant_b_response.json()["grant"]

    store_b = client.post(
        f"/api/one/location/grants/{grant_b['id']}/envelopes",
        json={"envelope": encrypted_envelope(f"key-{user_b}", "ciphertext-for-b")},
    )
    assert store_b.status_code == 200

    current_user["user_id"] = user_b
    view_b = client.get(f"/api/one/location/grants/{grant_b['id']}/envelope")
    assert view_b.status_code == 200
    assert view_b.json()["envelope"]["ciphertext"] == "ciphertext-for-b"

    current_user["user_id"] = user_c
    view_c = client.get(f"/api/one/location/grants/{grant_b['id']}/envelope")
    assert view_c.status_code == 404

    current_user["user_id"] = user_b
    referral_response = client.post(
        f"/api/one/location/grants/{grant_b['id']}/refer",
        json={"referredUserId": user_d},
    )
    assert referral_response.status_code == 200
    referral = referral_response.json()
    assert referral["referral"]["status"] == "pending_owner_approval"
    assert referral["request"]["status"] == "pending"

    current_user["user_id"] = user_d
    view_d_before = client.get(f"/api/one/location/grants/{grant_b['id']}/envelope")
    assert view_d_before.status_code == 404

    current_user["user_id"] = user_a
    approve_d = client.post(
        f"/api/one/location/requests/{referral['request']['id']}/approve",
        json={"approvalMode": "manual", "durationHours": 1},
    )
    assert approve_d.status_code == 200
    grant_d = approve_d.json()["grant"]
    store_d = client.post(
        f"/api/one/location/grants/{grant_d['id']}/envelopes",
        json={"envelope": encrypted_envelope(f"key-{user_d}", "ciphertext-for-d")},
    )
    assert store_d.status_code == 200

    current_user["user_id"] = user_d
    view_d_after = client.get(f"/api/one/location/grants/{grant_d['id']}/envelope")
    assert view_d_after.status_code == 200
    assert view_d_after.json()["envelope"]["ciphertext"] == "ciphertext-for-d"

    current_user["user_id"] = user_a
    revoke_b = client.delete(f"/api/one/location/grants/{grant_b['id']}")
    assert revoke_b.status_code == 200

    activity_response = client.get("/api/one/location/activity?range=30d")
    assert activity_response.status_code == 200
    activity_payload = activity_response.json()
    assert activity_payload["summary"]["sharedWithCount"] >= 1
    assert activity_payload["summary"]["viewsCount"] >= 1
    assert any(event["title"] == "Shared with User B" for event in activity_payload["events"])
    serialized_activity = json.dumps(activity_payload, default=str)
    assert "latitude" not in serialized_activity
    assert "longitude" not in serialized_activity
    assert "ciphertext-for-" not in serialized_activity

    current_user["user_id"] = user_b
    view_b_after_revoke = client.get(f"/api/one/location/grants/{grant_b['id']}/envelope")
    assert view_b_after_revoke.status_code == 410

    serialized = json.dumps(
        {
            "responses": [
                grant_b_response.json(),
                store_b.json(),
                view_b.json(),
                referral_response.json(),
                approve_d.json(),
                store_d.json(),
                view_d_after.json(),
                revoke_b.json(),
                activity_payload,
            ],
            "notifications": service.notifications,
        },
        default=str,
    )
    assert "latitude" not in serialized
    assert "longitude" not in serialized


def test_public_location_invite_route_creates_request_without_returning_location(
    monkeypatch,
) -> None:
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    _register_key(client, current_user, "user_b")
    current_user["user_id"] = "user_a"

    invite_response = client.post(
        "/api/one/location/public-invites",
        json={"durationHours": 1},
    )
    assert invite_response.status_code == 200
    token = invite_response.json()["publicToken"]

    resolve_response = client.get(f"/api/one/location/public-invites/{token}")
    assert resolve_response.status_code == 200
    resolve_payload = resolve_response.json()
    # The sharer's display name, over the wire. It read "A trusted person" for
    # every link ever minted because create_public_invite never wrote
    # metadata.owner_safe_label -- the only field this payload consults.
    assert resolve_payload["invite"]["ownerLabel"] == "User A"
    # A name, and nothing else: no id, no phone, no email, no raw name field.
    assert "ownerUserId" not in json.dumps(resolve_payload)
    assert "ownerDisplayName" not in json.dumps(resolve_payload)
    assert "ownerMaskedPhone" not in json.dumps(resolve_payload)

    submit_response = client.post(
        f"/api/one/location/public-invites/{token}/submit",
        json={
            "visitorDisplayName": "User B",
            "phoneNumber": "+1 555 010 0002",
            "message": "Can you share?",
        },
    )
    assert submit_response.status_code == 200
    payload = submit_response.json()
    assert payload["submission"]["status"] == "matched_request_pending"
    assert "request" not in payload
    assert len(service.requests) == 1
    assert next(iter(service.requests.values()))["status"] == "pending"

    serialized = json.dumps(
        {
            "invite": invite_response.json(),
            "resolve": resolve_response.json(),
            "submit": payload,
            "notifications": service.notifications,
        },
        default=str,
    )
    assert token not in json.dumps(
        {
            "resolve": resolve_response.json(),
            "submit": payload,
            "notifications": service.notifications,
        },
        default=str,
    )
    assert "grant" not in json.dumps(payload)
    assert "ciphertext" not in serialized
    assert "latitude" not in serialized
    assert "longitude" not in serialized
    assert "map" not in serialized
    assert "address" not in serialized
    assert "reverse_geocode" not in serialized


def test_public_location_invite_route_returns_snapshot_on_resolve(
    monkeypatch,
) -> None:
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    _register_key(client, current_user, "user_b")
    current_user["user_id"] = "user_a"

    invite_response = client.post(
        "/api/one/location/public-invites",
        json={
            "durationHours": 1,
            "locationSnapshot": PUBLIC_LOCATION_SNAPSHOT,
        },
    )
    assert invite_response.status_code == 200
    token = invite_response.json()["publicToken"]

    resolve_response = client.get(f"/api/one/location/public-invites/{token}")
    assert resolve_response.status_code == 200
    resolve_payload = resolve_response.json()
    assert resolve_payload["invite"]["locationAvailable"] is True
    assert resolve_payload["publicLocation"]["latitude"] == PUBLIC_LOCATION_SNAPSHOT["latitude"]
    assert resolve_payload["publicLocation"]["longitude"] == PUBLIC_LOCATION_SNAPSHOT["longitude"]

    submit_response = client.post(
        f"/api/one/location/public-invites/{token}/submit",
        json={
            "visitorDisplayName": "User B",
            "phoneNumber": "+1 555 010 0002",
            "message": "For pickup.",
        },
    )
    assert submit_response.status_code == 200
    payload = submit_response.json()
    assert payload["submission"]["status"] == "approved"
    assert payload["publicLocation"]["latitude"] == PUBLIC_LOCATION_SNAPSHOT["latitude"]
    assert payload["publicLocation"]["longitude"] == PUBLIC_LOCATION_SNAPSHOT["longitude"]
    assert service.requests == {}

    serialized_private_surfaces = json.dumps(
        {
            "notifications": service.notifications,
            "submissions": service.public_submissions,
        },
        default=str,
    )
    assert "latitude" not in serialized_private_surfaces
    assert "longitude" not in serialized_private_surfaces
    assert "ciphertext" not in serialized_private_surfaces


def test_circle_invite_route_claims_into_network_connection_without_grant(
    monkeypatch,
) -> None:
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    _register_key(client, current_user, "user_b")
    current_user["user_id"] = "user_a"

    invite_response = client.post(
        "/api/one/location/circle-invites",
        json={"durationHours": 1, "message": "Join me on One."},
    )
    assert invite_response.status_code == 200
    invite_payload = invite_response.json()
    token = invite_payload["inviteToken"]
    assert invite_payload["inviteUrl"].endswith(token)
    assert token not in json.dumps(service.circle_invites, default=str)

    resolve_response = client.get(f"/api/one/location/circle-invites/{token}")
    assert resolve_response.status_code == 200
    resolve_payload = resolve_response.json()
    serialized_resolve = json.dumps(resolve_payload)
    assert resolve_payload["invite"]["ownerLabel"] == "User A - *******0001"
    assert "ownerUserId" not in serialized_resolve
    assert "ciphertext" not in serialized_resolve
    assert "latitude" not in serialized_resolve
    assert "longitude" not in serialized_resolve

    current_user["user_id"] = "user_b"
    claim_response = client.post(
        f"/api/one/location/circle-invites/{token}/claim",
        json={"message": "Ready to join."},
    )
    assert claim_response.status_code == 200
    claim_payload = claim_response.json()
    assert claim_payload["invite"]["status"] == "claimed"
    assert claim_payload["connection"]["status"] == "active"
    assert claim_payload["connection"]["inviterUserId"] == "user_a"
    assert claim_payload["connection"]["inviteeUserId"] == "user_b"
    assert service.requests == {}
    assert service.grants == {}

    duplicate_response = client.post(
        f"/api/one/location/circle-invites/{token}/claim",
        json={},
    )
    assert duplicate_response.status_code == 410


def test_one_location_retention_purge_requires_dedicated_token_by_default(
    monkeypatch,
) -> None:
    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.delenv("ONE_LOCATION_RETENTION_TOKEN", raising=False)
    monkeypatch.setenv("ONE_EMAIL_WATCH_RENEW_TOKEN", "shared-one-email-token")
    service = FourUserMemoryService()
    client = _client(service, {"user_id": "user_a"}, monkeypatch)

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={"X-Hushh-Maintenance-Token": "shared-one-email-token"},
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ONE_LOCATION_RETENTION_TOKEN_MISSING"


def test_one_location_retention_purge_rejects_missing_maintenance_token(
    monkeypatch,
) -> None:
    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.setenv("ONE_LOCATION_RETENTION_TOKEN", "expected-token")
    service = FourUserMemoryService()
    client = _client(service, {"user_id": "user_a"}, monkeypatch)

    response = client.post("/api/one/location/retention/purge?older_than_hours=12")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ONE_LOCATION_RETENTION_UNAUTHORIZED"


def test_one_location_retention_purge_rejects_wrong_maintenance_token(
    monkeypatch,
) -> None:
    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.setenv("ONE_LOCATION_RETENTION_TOKEN", "expected-token")
    service = FourUserMemoryService()
    client = _client(service, {"user_id": "user_a"}, monkeypatch)

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={"X-Hushh-Maintenance-Token": "wrong-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ONE_LOCATION_RETENTION_UNAUTHORIZED"


def test_one_location_retention_purge_accepts_valid_dedicated_token(
    monkeypatch,
) -> None:
    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.setenv("ONE_LOCATION_RETENTION_TOKEN", "expected-token")
    service = FourUserMemoryService()
    client = _client(service, {"user_id": "user_a"}, monkeypatch)

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={"X-Hushh-Maintenance-Token": "expected-token"},
    )

    assert response.status_code == 200
    assert response.json()["retention_hours"] == 12


def test_one_location_retention_route_purges_terminal_state_and_preserves_active_envelope(
    monkeypatch,
) -> None:
    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.setenv("ONE_LOCATION_RETENTION_TOKEN", "expected-token")
    service = FourUserMemoryService()
    client = _client(service, {"user_id": "user_a"}, monkeypatch)
    now = datetime.now(timezone.utc)
    old_grant_id = str(uuid.uuid4())
    active_grant_id = str(uuid.uuid4())
    old_request_id = str(uuid.uuid4())
    old_referral_id = str(uuid.uuid4())
    old_envelope_id = str(uuid.uuid4())
    active_envelope_id = str(uuid.uuid4())
    old_invite_id = str(uuid.uuid4())
    old_submission_id = str(uuid.uuid4())
    active_event_id = str(uuid.uuid4())
    old_event_id = str(uuid.uuid4())

    service.grants[old_grant_id] = {
        "id": old_grant_id,
        "owner_user_id": "user_a",
        "recipient_user_id": "user_b",
        "recipient_key_id": "key-user_b",
        "status": "expired",
        "consent_scope": "cap.location.live.view",
        "capability_scopes": json.dumps(["cap.location.live.view"]),
        "duration_hours": 1,
        "expires_at": now - timedelta(hours=13),
        "created_at": now - timedelta(hours=14),
        "updated_at": now - timedelta(hours=13),
        "revoked_at": None,
        "latest_envelope_id": old_envelope_id,
    }
    service.grants[active_grant_id] = {
        **service.grants[old_grant_id],
        "id": active_grant_id,
        "status": "active",
        "expires_at": now + timedelta(hours=1),
        "latest_envelope_id": active_envelope_id,
    }
    service.envelopes[old_envelope_id] = {
        "id": old_envelope_id,
        "grant_id": old_grant_id,
        "owner_user_id": "user_a",
        "recipient_user_id": "user_b",
        "recipient_key_id": "key-user_b",
        "ciphertext": "expired-ciphertext",
    }
    service.envelopes[active_envelope_id] = {
        "id": active_envelope_id,
        "grant_id": active_grant_id,
        "owner_user_id": "user_a",
        "recipient_user_id": "user_b",
        "recipient_key_id": "key-user_b",
        "ciphertext": "current-ciphertext",
    }
    service.requests[old_request_id] = {
        "id": old_request_id,
        "owner_user_id": "user_a",
        "requester_user_id": "user_b",
        "referred_by_user_id": None,
        "status": "approved",
        "requested_at": now - timedelta(hours=14),
        "resolved_at": now - timedelta(hours=13),
        "approved_grant_id": old_grant_id,
    }
    service.referrals[old_referral_id] = {
        "id": old_referral_id,
        "grant_id": old_grant_id,
        "owner_user_id": "user_a",
        "referring_user_id": "user_b",
        "referred_user_id": "user_c",
        "request_id": old_request_id,
        "status": "denied",
        "created_at": now - timedelta(hours=14),
        "resolved_at": now - timedelta(hours=13),
    }
    service.public_invites[old_invite_id] = {
        "id": old_invite_id,
        "owner_user_id": "user_a",
        "public_code_hash": "old-hash",
        "status": "expired",
        "duration_hours": 1,
        "expires_at": now - timedelta(hours=13),
        "created_at": now - timedelta(hours=14),
        "updated_at": now - timedelta(hours=13),
        "revoked_at": None,
    }
    service.public_submissions[old_submission_id] = {
        "id": old_submission_id,
        "invite_id": old_invite_id,
        "owner_user_id": "user_a",
        "visitor_display_name": "Old Visitor",
        "visitor_phone_hash": "old-phone-hash",
        "visitor_phone_last4": "0002",
        "matched_user_id": "user_b",
        "request_id": old_request_id,
        "status": "denied",
        "message": "old request",
        "submitted_at": now - timedelta(hours=14),
        "resolved_at": now - timedelta(hours=13),
        "metadata": {},
    }
    service.events[old_event_id] = {
        "id": old_event_id,
        "grant_id": old_grant_id,
        "request_id": old_request_id,
        "referral_id": old_referral_id,
        "event_type": "location_public_invite_submitted",
        "metadata": {"invite_id": old_invite_id, "submission_id": old_submission_id},
    }
    service.events[active_event_id] = {
        "id": active_event_id,
        "grant_id": active_grant_id,
        "request_id": None,
        "referral_id": None,
        "event_type": "location_envelope_updated",
        "metadata": {},
    }

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={"X-Hushh-Maintenance-Token": "expected-token"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "deleted_grants": 1,
        "deleted_envelopes": 1,
        "deleted_requests": 1,
        "deleted_referrals": 1,
        "deleted_public_invites": 1,
        "deleted_circle_invites": 0,
        "deleted_named_circle_codes": 0,
        "deleted_named_circle_member_invites": 0,
        "deleted_public_submissions": 1,
        "deleted_events": 1,
        "nearby_presence": {"expired": 0, "deleted": 0},
        "retention_hours": 12.0,
    }
    assert old_grant_id not in service.grants
    assert old_envelope_id not in service.envelopes
    assert old_request_id not in service.requests
    assert old_referral_id not in service.referrals
    assert old_invite_id not in service.public_invites
    assert old_submission_id not in service.public_submissions
    assert old_event_id not in service.events
    assert active_grant_id in service.grants
    assert active_envelope_id in service.envelopes
    assert service.envelopes[active_envelope_id]["ciphertext"] == "current-ciphertext"
    assert active_event_id in service.events


def test_one_location_retention_auth_cannot_be_disabled_in_hosted_mode(
    monkeypatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", "false")
    monkeypatch.delenv("ONE_LOCATION_RETENTION_TOKEN", raising=False)
    service = FourUserMemoryService()
    client = _client(service, {"user_id": "user_a"}, monkeypatch)

    response = client.post("/api/one/location/retention/purge?older_than_hours=12")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ONE_LOCATION_RETENTION_TOKEN_MISSING"


def test_one_location_retention_auth_can_be_disabled_in_local_test_mode(
    monkeypatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", "false")
    monkeypatch.delenv("ONE_LOCATION_RETENTION_TOKEN", raising=False)
    service = FourUserMemoryService()
    client = _client(service, {"user_id": "user_a"}, monkeypatch)

    response = client.post("/api/one/location/retention/purge?older_than_hours=12")

    assert response.status_code == 200
    assert response.json()["retention_hours"] == 12


def test_one_location_route_preserves_db_error_mapping_without_db_client_import() -> None:
    source = inspect.getsource(one_location)
    assert "from db.db_client import" not in source

    response = one_location._handle_error(DatabaseExecutionError())

    assert response.status_code == 503
    assert response.detail == {
        "code": "DATABASE_UNAVAILABLE",
        "message": "Location storage is temporarily unavailable. Try again shortly.",
        "hint": "Retry later.",
    }
    # CWE-209: the raw SQLAlchemy detail carries the statement and its bound
    # values; only the code and the static hint may cross the wire.
    assert "[parameters:" not in str(response.detail)
    assert "+919812345678" not in str(response.detail)


def test_recipient_key_blob_is_returned_to_owner_and_never_leaks_to_others(monkeypatch) -> None:
    """The vault-encrypted private key blob enables cross-device recovery: the owner
    gets it back via `myRecipientKey`, but it must NEVER appear in the recipients
    directory shown to other users."""
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    blob = {
        "ciphertext": "OWNER_ONLY_CIPHERTEXT",
        "iv": "IV",
        "tag": "TAG",
        "algorithm": "aes-256-gcm",
    }

    # user_a registers WITH an encrypted private key blob.
    current_user["user_id"] = "user_a"
    resp = client.post(
        "/api/one/location/recipient-keys",
        json={
            "keyId": "key-user_a",
            "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "a", "y": "a"},
            "encryptedPrivateKeyJwk": blob,
        },
    )
    assert resp.status_code == 200

    # user_b registers WITHOUT a blob (legacy device-local key).
    current_user["user_id"] = "user_b"
    resp = client.post(
        "/api/one/location/recipient-keys",
        json={
            "keyId": "key-user_b",
            "publicKeyJwk": {"kty": "EC", "crv": "P-256", "x": "b", "y": "b"},
        },
    )
    assert resp.status_code == 200

    # Owner (user_a) gets their OWN blob back for cross-device recovery.
    current_user["user_id"] = "user_a"
    state_a = client.get("/api/one/location/state").json()
    assert state_a["myRecipientKey"]["keyId"] == "key-user_a"
    assert state_a["myRecipientKey"]["encryptedPrivateKeyJwk"] == blob
    for recipient in state_a["recipients"]:
        assert "encryptedPrivateKeyJwk" not in recipient

    # user_b must NEVER receive user_a's private blob — not in myRecipientKey, not
    # in the recipients directory, not anywhere in the payload.
    current_user["user_id"] = "user_b"
    state_b = client.get("/api/one/location/state").json()
    assert state_b["myRecipientKey"]["encryptedPrivateKeyJwk"] is None
    for recipient in state_b["recipients"]:
        assert "encryptedPrivateKeyJwk" not in recipient
    assert "OWNER_ONLY_CIPHERTEXT" not in json.dumps(state_b)


def test_create_grant_with_explicit_pick_me_up_share_kind(monkeypatch) -> None:
    """Explicit shareKind wins over _classify_share_kind; reason carries the freeform note."""
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    _register_key(client, current_user, "user_b")
    service._seed_connection("user_a", "user_b")
    current_user["user_id"] = "user_a"

    resp = client.post(
        "/api/one/location/grants",
        json={
            "recipientUserId": "user_b",
            "recipientKeyId": "key-user_b",
            "durationHours": 1,
            "reason": "Pick me up at Starbucks on Main St",
            "shareKind": "pick_me_up",
        },
    )
    assert resp.status_code == 200
    grant = resp.json()["grant"]

    # Explicit kind overrides what _classify_share_kind would derive ("check_in").
    assert grant["shareKind"] == "pick_me_up"
    # Freeform reason is surfaced as the visible share message.
    assert grant["shareMessage"] == "Pick me up at Starbucks on Main St"

    # Notification sent to recipient carries the pick_me_up title + note.
    notif = service.notifications[-1]
    assert notif["title"] == "Pickup requested"
    assert "Pick me up at Starbucks on Main St" in notif["body"]
    assert notif["data"]["share_kind"] == "pick_me_up"


def test_create_grant_without_share_kind_preserves_existing_classification(monkeypatch) -> None:
    """Omitting shareKind must leave existing _classify_share_kind behaviour unchanged."""
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    _register_key(client, current_user, "user_b")
    service._seed_connection("user_a", "user_b")
    current_user["user_id"] = "user_a"

    # A freeform note (not an internal marker) → classified as "check_in".
    resp = client.post(
        "/api/one/location/grants",
        json={
            "recipientUserId": "user_b",
            "recipientKeyId": "key-user_b",
            "durationHours": 1,
            "reason": "Meeting you at the airport",
        },
    )
    assert resp.status_code == 200
    grant = resp.json()["grant"]
    assert grant["shareKind"] == "check_in"
    assert grant["shareMessage"] == "Meeting you at the airport"

    # Plain share (no reason) → classified as "share".
    resp2 = client.post(
        "/api/one/location/grants",
        json={
            "recipientUserId": "user_b",
            "recipientKeyId": "key-user_b",
            "durationHours": 1,
        },
    )
    assert resp2.status_code == 200
    assert resp2.json()["grant"]["shareKind"] == "share"

    # Both of those are in the NON-emergency lane -- `check_in` and `share`
    # are not separate lanes -- so the second still replaces the first, and
    # the pair is still left holding exactly one live ordinary grant. Two
    # lanes, not one lane per kind: without this the fix could quietly become
    # "never replace anything" and grants would pile up with no Stop for them.
    assert service.grants[grant["id"]]["status"] == "revoked"
    assert service.grants[resp2.json()["grant"]["id"]]["status"] == "active"


# -- OIDC scheduler identity -----------------------------------------------------------
#
# The retention purge is reached by Cloud Scheduler, which used to present a Secret
# Manager value baked into its own job config as `X-Hushh-Maintenance-Token`. These
# four cases cover the route-level behaviour of the replacement; the verification
# logic itself is covered in `test_scheduler_identity.py`.


def _oidc_claims(email: str = "sched@hushh-pda-uat.iam.gserviceaccount.com") -> dict:
    return {"email": email, "email_verified": True, "aud": "https://backend.test", "sub": "1"}


def _accept_any_token(claims: dict):
    def _verify(_token: str, _audience: str) -> dict:
        return claims

    return _verify


def test_one_location_retention_purge_accepts_a_scheduler_oidc_token(monkeypatch) -> None:
    """The whole point: no secret in the job, and the purge still runs."""
    from hushh_mcp.services import scheduler_identity

    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.delenv("ONE_LOCATION_RETENTION_TOKEN", raising=False)
    monkeypatch.setenv(
        "ONE_LOCATION_RETENTION_SCHEDULER_SERVICE_ACCOUNTS",
        "sched@hushh-pda-uat.iam.gserviceaccount.com",
    )
    monkeypatch.setenv("ONE_LOCATION_RETENTION_AUDIENCE", "https://backend.test")
    monkeypatch.setattr(
        scheduler_identity, "_verify_google_id_token", _accept_any_token(_oidc_claims())
    )
    client = _client(FourUserMemoryService(), {"user_id": "user_a"}, monkeypatch)

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={"Authorization": "Bearer signed-by-google"},
    )

    assert response.status_code == 200, response.json()
    assert response.json()["retention_hours"] == 12


def test_one_location_retention_purge_refuses_a_scheduler_outside_the_allowlist(
    monkeypatch,
) -> None:
    from hushh_mcp.services import scheduler_identity

    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    # A legacy token that WOULD be accepted, to prove the OIDC failure does not fall
    # through to it. A stolen shared secret plus a forged OIDC token must not be a
    # better position than the stolen secret alone.
    monkeypatch.setenv("ONE_LOCATION_RETENTION_TOKEN", "expected-token")
    monkeypatch.setenv(
        "ONE_LOCATION_RETENTION_SCHEDULER_SERVICE_ACCOUNTS",
        "sched@hushh-pda-uat.iam.gserviceaccount.com",
    )
    monkeypatch.setenv("ONE_LOCATION_RETENTION_AUDIENCE", "https://backend.test")
    monkeypatch.setattr(
        scheduler_identity,
        "_verify_google_id_token",
        _accept_any_token(_oidc_claims(email="intruder@example.iam.gserviceaccount.com")),
    )
    client = _client(FourUserMemoryService(), {"user_id": "user_a"}, monkeypatch)

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={
            "Authorization": "Bearer signed-by-google",
            "X-Hushh-Maintenance-Token": "expected-token",
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"]["reason"] == "scheduler_identity_not_allowed"


def test_one_location_retention_purge_closes_the_legacy_path_on_one_variable(
    monkeypatch,
) -> None:
    """The migration's last step must not need a code change."""
    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.setenv("ONE_LOCATION_RETENTION_TOKEN", "expected-token")
    monkeypatch.setenv("HUSHH_MAINTENANCE_LEGACY_TOKEN_ENABLED", "0")
    client = _client(FourUserMemoryService(), {"user_id": "user_a"}, monkeypatch)

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={"X-Hushh-Maintenance-Token": "expected-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ONE_LOCATION_RETENTION_UNAUTHORIZED"


def test_one_location_retention_purge_still_accepts_the_shared_header_during_migration(
    monkeypatch,
) -> None:
    """Flipping the server before the scheduler jobs must not break the purge."""
    monkeypatch.delenv("ONE_LOCATION_RETENTION_AUTH_ENABLED", raising=False)
    monkeypatch.delenv("HUSHH_MAINTENANCE_LEGACY_TOKEN_ENABLED", raising=False)
    monkeypatch.setenv("ONE_LOCATION_RETENTION_TOKEN", "expected-token")
    client = _client(FourUserMemoryService(), {"user_id": "user_a"}, monkeypatch)

    response = client.post(
        "/api/one/location/retention/purge?older_than_hours=12",
        headers={"X-Hushh-Maintenance-Token": "expected-token"},
    )

    assert response.status_code == 200


def test_sos_grant_and_normal_share_coexist_over_the_api(monkeypatch) -> None:
    """End to end over HTTP: the pair holds one live grant in each lane (#5506).

    The service-level tests prove the revoke predicate; this proves the whole
    route stack agrees, right through to what `getState` hands the client. It
    is the client-visible half of the fix: `shareKind` comes back on every
    grant, which is what lets the web app tell the two apart and stop treating
    one grant as one person.
    """
    service = FourUserMemoryService()
    current_user = {"user_id": "user_a"}
    client = _client(service, current_user, monkeypatch)

    _register_key(client, current_user, "user_b")
    service._seed_connection("user_a", "user_b")
    current_user["user_id"] = "user_a"

    share = client.post(
        "/api/one/location/grants",
        json={
            "recipientUserId": "user_b",
            "recipientKeyId": "key-user_b",
            "durationHours": 4,
            "shareKind": "share",
        },
    )
    assert share.status_code == 200
    share_grant = share.json()["grant"]
    assert share_grant["shareKind"] == "share"

    # Save My Soul only accepts a recipient the owner has already chosen as an
    # SMS contact, so this is a precondition of the alert, not part of it.
    contact = client.post(
        "/api/one/location/sms-contacts",
        json={"recipientUserId": "user_b"},
    )
    assert contact.status_code == 200

    sos = client.post(
        "/api/one/location/grants",
        json={
            "recipientUserId": "user_b",
            "recipientKeyId": "key-user_b",
            "durationHours": 8,
            "shareKind": "sos",
        },
    )
    assert sos.status_code == 200
    sos_grant = sos.json()["grant"]
    assert sos_grant["shareKind"] == "sos"
    assert sos_grant["id"] != share_grant["id"]

    state = client.get("/api/one/location/state").json()
    active = [
        grant
        for grant in state["ownerGrants"]
        if grant["status"] == "active" and grant["recipientUserId"] == "user_b"
    ]
    # TWO active grants to one person, which used to be impossible: creating
    # the SOS grant revoked the four-hour share as a matter of course.
    assert len(active) == 2
    assert {grant["id"] for grant in active} == {share_grant["id"], sos_grant["id"]}
    assert sorted(grant["shareKind"] for grant in active) == ["share", "sos"]
    # The four-hour share kept its own window; the alert did not shorten it or
    # stretch it to the emergency lane's eight.
    surviving = next(grant for grant in active if grant["id"] == share_grant["id"])
    assert surviving["expiresAt"] == share_grant["expiresAt"]
