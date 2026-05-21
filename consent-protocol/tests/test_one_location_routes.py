from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import location as one_location
from tests.services.test_one_location_agent_service import FourUserMemoryService, encrypted_envelope


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
    assert resolve_response.json()["invite"]["ownerUserId"] == "user_a"

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
    assert payload["request"]["status"] == "pending"

    serialized = json.dumps(
        {
            "invite": invite_response.json(),
            "resolve": resolve_response.json(),
            "submit": payload,
            "notifications": service.notifications,
        },
        default=str,
    )
    assert "latitude" not in serialized
    assert "longitude" not in serialized
