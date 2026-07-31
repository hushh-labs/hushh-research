from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import location as location_routes
from api.routes.one.location import router
from hushh_mcp.services import google_maps_service as gms
from hushh_mcp.services.one_location_event_admission_service import (
    EventAdmissionContext,
)
from hushh_mcp.services.one_location_nearby_presence_service import (
    NearbyPresenceError,
)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "u1"}
    return TestClient(app)


def test_nearby_check_in_uses_token_identity_and_server_resolved_place(
    client,
    monkeypatch,
):
    async def place_details(self, place_id):
        return {
            "placeId": place_id,
            "label": "Demo Hall",
            "latitude": 12.9717,
            "longitude": 77.5947,
        }

    class FakePresenceService:
        def check_in(self, **kwargs):
            assert kwargs["user_id"] == "u1"
            assert kwargs["place_id"] == "venue-1"
            assert kwargs["place_label"] == "Demo Hall"
            assert kwargs["place_lat"] == 12.9717
            assert kwargs["current_lat"] == 12.9716
            assert kwargs["duration_minutes"] == 60
            return {
                "presence": {
                    "status": "active",
                    "placeLabel": "Demo Hall",
                    "radiusMeters": 500,
                },
                "attendees": [],
            }

    monkeypatch.setattr(gms.GoogleMapsService, "place_details", place_details)
    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FakePresenceService(),
    )

    response = client.post(
        "/api/one/location/nearby-presence/check-in",
        json={
            "placeId": "venue-1",
            "currentLat": 12.9716,
            "currentLng": 77.5946,
            "accuracyM": 12,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "durationMinutes": 60,
            "consentAccepted": True,
            "allowConnectionRequests": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["presence"]["placeLabel"] == "Demo Hall"
    assert response.headers["cache-control"] == "private, no-store"


def test_roster_never_returns_peer_location_or_stable_identity(client, monkeypatch):
    class FakePresenceService:
        def get_state(self, *, user_id):
            assert user_id == "u1"
            return {
                "presence": {
                    "status": "active",
                    "placeLabel": "My selected place",
                    "radiusMeters": 500,
                },
                "attendees": [
                    {
                        "participantAlias": "alias-1",
                        "displayName": "Mira",
                        "relationship": "none",
                        "canConnect": True,
                    }
                ],
            }

    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FakePresenceService(),
    )
    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["attendees"][0]["participantAlias"] == "alias-1"
    assert "userId" not in response.text
    assert "latitude" not in response.text.lower()
    assert "longitude" not in response.text.lower()
    assert "distance" not in response.text.lower()


def test_check_in_rejects_client_identity_and_legacy_event_code(client):
    response = client.post(
        "/api/one/location/nearby-presence/check-in",
        json={
            "userId": "someone-else",
            "eventCode": "HUSSH-DEMO",
            "placeId": "venue-1",
            "currentLat": 12.9716,
            "currentLng": 77.5946,
            "accuracyM": 12,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "durationMinutes": 60,
            "consentAccepted": True,
            "allowConnectionRequests": True,
        },
    )

    assert response.status_code == 422


def test_simulation_is_unavailable_in_production_before_maps(client, monkeypatch):
    called = False

    async def place_details(self, place_id):
        nonlocal called
        called = True
        return {}

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "uat_simulation")
    monkeypatch.setattr(gms.GoogleMapsService, "place_details", place_details)

    response = client.post(
        "/api/one/location/nearby-presence/check-in",
        json={
            "placeId": "venue-1",
            "currentLat": 12.9716,
            "currentLng": 77.5946,
            "accuracyM": 12,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "durationMinutes": 60,
            "consentAccepted": True,
            "allowConnectionRequests": False,
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NEARBY_PRESENCE_UNAVAILABLE"
    assert called is False


def test_simulation_can_be_explicitly_disabled_in_uat(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "disabled")

    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NEARBY_PRESENCE_UNAVAILABLE"


def test_simulation_fails_closed_without_environment_identity(client, monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)

    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NEARBY_PRESENCE_UNAVAILABLE"


def test_checkout_remains_available_when_simulation_is_disabled(client, monkeypatch):
    class FakePresenceService:
        def checkout(self, *, user_id):
            assert user_id == "u1"
            return {"presence": None, "attendees": [], "checkedOut": True}

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FakePresenceService(),
    )

    response = client.delete("/api/one/location/nearby-presence")

    assert response.status_code == 200
    assert response.json()["checkedOut"] is True
    assert response.headers["cache-control"] == "private, no-store"


def test_connection_request_accepts_alias_only_in_body(client, monkeypatch):
    class FakePresenceService:
        def request_connection(self, **kwargs):
            assert kwargs == {
                "user_id": "u1",
                "participant_alias": "alias-1",
            }
            return {"relationship": "pending_outgoing"}

    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FakePresenceService(),
    )
    response = client.post(
        "/api/one/location/nearby-presence/connection-request",
        json={"participantAlias": "alias-1"},
    )

    assert response.status_code == 200
    assert response.json() == {"relationship": "pending_outgoing"}
    assert response.headers["cache-control"] == "private, no-store"


def test_presence_errors_keep_stable_code_and_message(client, monkeypatch):
    class FakePresenceService:
        def get_state(self, **kwargs):
            raise NearbyPresenceError(
                "NEARBY_PRESENCE_PHONE_VERIFICATION_REQUIRED",
                "Verify your phone number before appearing to nearby people.",
                status_code=403,
            )

    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FakePresenceService(),
    )
    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == ("NEARBY_PRESENCE_PHONE_VERIFICATION_REQUIRED")


def test_nearby_place_picker_is_bounded_and_authenticated(client, monkeypatch):
    async def nearby_places(self, *, lat, lng):
        assert (lat, lng) == (12.9716, 77.5946)
        return [
            {
                "placeId": "place-a",
                "text": "Spot A",
                "distanceMeters": 42,
            }
        ]

    monkeypatch.setattr(gms.GoogleMapsService, "nearby_places", nearby_places)
    response = client.post(
        "/api/one/location/maps/nearby-places",
        json={"lat": 12.9716, "lng": 77.5946},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["suggestions"][0]["placeId"] == "place-a"


def test_nearby_place_picker_fails_closed_in_production(client, monkeypatch):
    called = False

    async def nearby_places(self, *, lat, lng):
        nonlocal called
        called = True
        return []

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(gms.GoogleMapsService, "nearby_places", nearby_places)

    response = client.post(
        "/api/one/location/maps/nearby-places",
        json={"lat": 12.9716, "lng": 77.5946},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NEARBY_PRESENCE_UNAVAILABLE"
    assert called is False


def test_production_capability_is_event_pilot_only(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "event_pilot")

    class FakeAdmissionService:
        def has_active_event(self):
            return True

    monkeypatch.setattr(
        location_routes,
        "_nearby_event_admission_service",
        lambda: FakeAdmissionService(),
    )

    response = client.get("/api/one/location/nearby-presence/capability")

    assert response.status_code == 200
    assert response.json() == {
        "available": True,
        "mode": "event_pilot",
        "admissionRequired": True,
    }
    assert response.headers["cache-control"] == "private, no-store"


def test_production_capability_closes_when_no_event_is_active(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "event_pilot")

    class FakeAdmissionService:
        def has_active_event(self):
            return False

    monkeypatch.setattr(
        location_routes,
        "_nearby_event_admission_service",
        lambda: FakeAdmissionService(),
    )

    response = client.get("/api/one/location/nearby-presence/capability")

    assert response.status_code == 200
    assert response.json() == {
        "available": False,
        "mode": "event_pilot",
        "admissionRequired": True,
    }


def test_production_check_in_requires_server_admission_and_never_calls_maps(
    client,
    monkeypatch,
):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "event_pilot")
    maps_called = False
    abuse_calls = []

    async def place_details(self, place_id):
        nonlocal maps_called
        maps_called = True
        return {}

    class FakeAdmissionService:
        def require_context(self, **kwargs):
            assert kwargs == {
                "user_id": "u1",
                "admission_claim_id": "7debb48d-4a5b-49dc-80c1-0ace848f42d8",
            }
            return EventAdmissionContext(
                admission_claim_id=kwargs["admission_claim_id"],
                event_id="ec01fe7f-780e-4bec-a62a-6a613fa02376",
                display_name="Hussh Event",
                venue_place_id="organizer-venue",
                venue_label="Demo Hall",
                venue_latitude=12.9717,
                venue_longitude=77.5947,
                radius_meters=500,
                starts_at=datetime.now(timezone.utc) - timedelta(minutes=5),
                ends_at=datetime.now(timezone.utc) + timedelta(hours=2),
            )

    class FakeAbuseService:
        def consume(self, **kwargs):
            abuse_calls.append(kwargs)

    class FakePresenceService:
        def check_in(self, **kwargs):
            assert kwargs["user_id"] == "u1"
            assert kwargs["place_id"] == "organizer-venue"
            assert kwargs["place_label"] == "Demo Hall"
            assert kwargs["place_lat"] == 12.9717
            assert kwargs["event_context"].event_id == ("ec01fe7f-780e-4bec-a62a-6a613fa02376")
            return {"presence": {"status": "active"}, "attendees": []}

    monkeypatch.setattr(gms.GoogleMapsService, "place_details", place_details)
    monkeypatch.setattr(
        location_routes,
        "_nearby_event_admission_service",
        lambda: FakeAdmissionService(),
    )
    monkeypatch.setattr(
        location_routes,
        "_nearby_abuse_service",
        lambda: FakeAbuseService(),
    )
    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FakePresenceService(),
    )

    response = client.post(
        "/api/one/location/nearby-presence/check-in",
        json={
            "placeId": "client-place-is-ignored",
            "currentLat": 12.9716,
            "currentLng": 77.5946,
            "accuracyM": 12,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "durationMinutes": 60,
            "consentAccepted": True,
            "allowConnectionRequests": True,
            "admissionId": "7debb48d-4a5b-49dc-80c1-0ace848f42d8",
        },
    )

    assert response.status_code == 200
    assert maps_called is False
    assert abuse_calls == [{"user_id": "u1", "action": "check_in"}]


def test_production_check_in_without_admission_fails_before_maps(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "event_pilot")
    maps_called = False

    async def place_details(self, place_id):
        nonlocal maps_called
        maps_called = True
        return {}

    class FakeAbuseService:
        def consume(self, **kwargs):
            return None

    class FakeAdmissionService:
        def require_context(self, **kwargs):
            raise location_routes.EventAdmissionError(
                "NEARBY_ADMISSION_REQUIRED",
                "Enter a valid event pass before checking in.",
                status_code=403,
            )

    monkeypatch.setattr(gms.GoogleMapsService, "place_details", place_details)
    monkeypatch.setattr(
        location_routes,
        "_nearby_abuse_service",
        lambda: FakeAbuseService(),
    )
    monkeypatch.setattr(
        location_routes,
        "_nearby_event_admission_service",
        lambda: FakeAdmissionService(),
    )

    response = client.post(
        "/api/one/location/nearby-presence/check-in",
        json={
            "placeId": "venue-1",
            "currentLat": 12.9716,
            "currentLng": 77.5946,
            "accuracyM": 12,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "durationMinutes": 60,
            "consentAccepted": True,
            "allowConnectionRequests": False,
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "NEARBY_ADMISSION_REQUIRED"
    assert maps_called is False
