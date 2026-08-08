from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import location as location_routes
from api.routes.one.location import router
from hushh_mcp.services import google_maps_service as gms
from hushh_mcp.services.one_location_nearby_presence_service import (
    NearbyPresenceError,
)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", raising=False)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "u1"}
    return TestClient(app)


def test_nearby_check_in_uses_token_identity_and_server_resolved_place(
    client,
    monkeypatch,
):
    async def place_details(self, place_id, *, require_check_inable=False):
        assert require_check_inable is True
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


def test_nearby_check_in_rejects_a_non_check_in_place_before_persistence(
    client,
    monkeypatch,
):
    async def place_details(self, place_id, *, require_check_inable=False):
        assert place_id == "closed-venue"
        assert require_check_inable is True
        raise gms.GoogleMapsError(
            "The selected place is not available for check-in.",
            status_code=422,
            code="ONE_LOCATION_PLACE_NOT_CHECK_INABLE",
        )

    class FailIfCalledPresenceService:
        def check_in(self, **kwargs):
            raise AssertionError("invalid places must not reach persistence")

    monkeypatch.setattr(gms.GoogleMapsService, "place_details", place_details)
    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FailIfCalledPresenceService(),
    )

    response = client.post(
        "/api/one/location/nearby-presence/check-in",
        json={
            "placeId": "closed-venue",
            "currentLat": 12.9716,
            "currentLng": 77.5946,
            "accuracyM": 12,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "durationMinutes": 60,
            "consentAccepted": True,
            "allowConnectionRequests": False,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "ONE_LOCATION_PLACE_NOT_CHECK_INABLE",
        "message": "The selected place is not available for check-in.",
    }


def test_nearby_place_picker_uses_the_maps_provider_rate_bucket():
    route_key = (
        f"{location_routes.maps_nearby_places.__module__}."
        f"{location_routes.maps_nearby_places.__name__}"
    )
    configured_limits = location_routes.limiter._route_limits[route_key]

    assert [str(item.limit) for item in configured_limits] == ["30 per 1 minute"]


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


def _stub_presence_state(monkeypatch):
    class FakePresenceService:
        def get_state(self, *, user_id):
            assert user_id == "u1"
            return {"presence": None, "attendees": []}

    monkeypatch.setattr(
        location_routes,
        "_nearby_presence_service",
        lambda: FakePresenceService(),
    )


def test_production_stays_closed_without_an_explicit_mode(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", "all")

    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NEARBY_PRESENCE_UNAVAILABLE"


def test_production_stays_closed_when_the_cohort_is_missing(client, monkeypatch):
    """Forgetting the cohort must fail safe, not open the flow to everyone.

    Production admission deliberately needs two variables. If setting the mode
    alone were enough, a half-finished rollout would silently expose a
    stranger-discovery surface to the whole user base.
    """

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "production")
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", raising=False)

    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NEARBY_PRESENCE_UNAVAILABLE"


def test_production_admits_only_the_named_cohort(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", "someone-else,u2")

    assert client.get("/api/one/location/nearby-presence").status_code == 404

    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", "u1,u2")
    _stub_presence_state(monkeypatch)

    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 200
    assert response.json()["presence"] is None


def test_production_cohort_all_admits_everyone(client, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", "production")
    monkeypatch.setenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", "all")
    _stub_presence_state(monkeypatch)

    response = client.get("/api/one/location/nearby-presence")

    assert response.status_code == 200


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
    async def nearby_places(self, *, lat, lng, category):
        assert (lat, lng) == (12.9716, 77.5946)
        assert category == "health"
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
        json={"lat": 12.9716, "lng": 77.5946, "category": "health"},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["suggestions"][0]["placeId"] == "place-a"


def test_nearby_place_picker_rejects_unknown_category(client):
    response = client.post(
        "/api/one/location/maps/nearby-places",
        json={
            "lat": 12.9716,
            "lng": 77.5946,
            "category": "random_recommendations",
        },
    )

    assert response.status_code == 422


def test_nearby_autocomplete_requires_a_current_point(client):
    response = client.post(
        "/api/one/location/maps/autocomplete",
        json={"input": "clinic", "nearbyOnly": True},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "ONE_LOCATION_NEARBY_POINT_REQUIRED"


def test_nearby_place_picker_fails_closed_in_production(client, monkeypatch):
    called = False

    async def nearby_places(self, *, lat, lng, category):
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
