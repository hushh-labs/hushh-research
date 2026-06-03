from __future__ import annotations

import inspect
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import location as one_location
from tests.services.test_one_location_agent_service import FourUserMemoryService, encrypted_envelope


class DatabaseExecutionError(Exception):
    code = "DATABASE_UNAVAILABLE"
    details = "Database temporarily unavailable."
    hint = "Retry later."
    status_code = 503


def _client(
    service: FourUserMemoryService, current_user: dict[str, str], monkeypatch
) -> TestClient:
    app = FastAPI()
    app.include_router(one_location.router)
    app.dependency_overrides[one_location.require_vault_owner_token] = lambda: {
        "user_id": current_user["user_id"]
    }
    monkeypatch.setattr(one_location, "_service", lambda: service)
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
        json={"durationHours": 1},
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
    assert resolve_payload["invite"]["ownerLabel"] == "A trusted person"
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
        "deleted_public_submissions": 1,
        "deleted_events": 1,
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
        "message": "Database temporarily unavailable.",
        "hint": "Retry later.",
    }
