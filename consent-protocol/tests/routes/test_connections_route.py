from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one.connections import router
from hushh_mcp.services.connections_service import ConnectionsError
from hushh_mcp.services.directory_identity_service import DirectoryIdentityUnavailableError


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user-a"
    return TestClient(app)


def test_network_routes_bind_viewer_and_validate_private_read_contract():
    person_ref = "42b3ecac-959f-47ab-9352-12a694be1ae9"
    client = _client()
    with patch("api.routes.one.connections.ConnectionNetworkService") as service:
        service.return_value.__enter__.return_value = service.return_value
        service.return_value.browse.return_value = {"items": [], "page": 2, "hasMore": False}
        response = client.get(
            "/api/one/connections/network",
            params={"person_ref": person_ref, "page": 2, "degree": 3, "query": "Alice"},
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        service.return_value.browse.assert_called_once_with(
            "user-a",
            person_ref=person_ref,
            degree=3,
            query="Alice",
            page=2,
            limit=20,
            include_suggestions=False,
        )
        service.return_value.browse.reset_mock()
        service.return_value.browse.return_value = {
            "items": [
                {
                    "publicPersonRef": person_ref,
                    "networkDegree": None,
                    "suggestionReason": "public_profile",
                }
            ],
            "page": 2,
            "hasMore": False,
        }
        suggestions = client.get(
            "/api/one/connections/network",
            params={"degree": 3, "page": 2, "include_suggestions": True},
        )
        assert suggestions.status_code == 200
        assert suggestions.headers["cache-control"] == "private, no-store"
        assert suggestions.json()["items"][0]["networkDegree"] is None
        assert suggestions.json()["items"][0]["suggestionReason"] == "public_profile"
        service.return_value.browse.assert_called_once_with(
            "user-a",
            person_ref=None,
            degree=3,
            query="",
            page=2,
            limit=20,
            include_suggestions=True,
        )
        for params in (
            {"degree": 0},
            {"degree": 4},
            {"person_ref": "invalid"},
            {"limit": 51},
            {"query": "a" * 161},
            {"page": 0},
        ):
            assert client.get("/api/one/connections/network", params=params).status_code == 422
        service.return_value.set_preference.return_value = {"shareConnectionList": True}
        response = client.patch(
            "/api/one/connections/network/visibility",
            json={"share_connection_list": True, "user_id": "someone-else"},
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        service.return_value.set_preference.assert_called_once_with("user-a", True)


def test_network_routes_require_auth_and_return_neutral_permission_failure():
    app = FastAPI()
    app.include_router(router)
    assert TestClient(app).get("/api/one/connections/network").status_code in (401, 403)
    with patch("api.routes.one.connections.ConnectionNetworkService") as service:
        service.return_value.__enter__.return_value = service.return_value
        service.return_value.browse.side_effect = ConnectionsError(
            "CONNECTION_NETWORK_NOT_FOUND", "This network is unavailable.", status_code=404
        )
        response = _client().get(
            "/api/one/connections/network",
            params={"person_ref": "42b3ecac-959f-47ab-9352-12a694be1ae9"},
        )
        assert response.status_code == 404
        assert response.json()["detail"]["message"] == "This network is unavailable."


def test_person_context_returns_canonical_reference_without_public_caching():
    with patch("api.routes.one.connections.ConnectionsService") as service:
        service.return_value.get_person_context.return_value = {
            "person": {
                "userId": "peer",
                "publicPersonRef": "public-peer",
                "relationship": "connected",
            },
            "request": None,
        }
        response = _client().get("/api/one/connections/peer/context")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json()["person"]["publicPersonRef"] == "public-peer"
        service.return_value.get_person_context.assert_called_once_with("user-a", "peer")


def test_mutual_list_binds_viewer_and_bounds_pagination_without_public_caching():
    person_ref = "42b3ecac-959f-47ab-9352-12a694be1ae9"
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as service:
        service.return_value.list_mutual_connections_page.return_value = {
            "person": {"publicPersonRef": person_ref},
            "items": [],
            "page": 2,
            "hasMore": False,
        }
        response = client.get(
            "/api/one/connections/mutuals", params={"person_ref": person_ref, "page": 2}
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        service.return_value.list_mutual_connections_page.assert_called_once_with(
            "user-a",
            person_ref=person_ref,
            page=2,
            limit=20,
        )
        for params in (
            {"person_ref": "invalid"},
            {"person_ref": person_ref, "page": 0},
            {"person_ref": person_ref, "limit": 51},
        ):
            assert client.get("/api/one/connections/mutuals", params=params).status_code == 422


def test_mutual_list_fails_retryably_when_identity_authority_is_unavailable():
    with patch("api.routes.one.connections.ConnectionsService") as service:
        service.return_value.list_mutual_connections_page.side_effect = (
            DirectoryIdentityUnavailableError()
        )
        response = _client().get(
            "/api/one/connections/mutuals",
            params={"person_ref": "42b3ecac-959f-47ab-9352-12a694be1ae9"},
        )
    assert response.status_code == 503


def test_create_request_returns_request_payload():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.create_request.return_value = {
            "id": "req-1",
            "requesterUserId": "user-a",
            "addresseeUserId": "user-b",
            "status": "pending",
            "message": None,
        }
        resp = client.post("/api/one/connections/requests", json={"addressee_user_id": "user-b"})
    assert resp.status_code == 200
    assert resp.json()["request"]["id"] == "req-1"


def test_create_request_returns_typed_conflict_when_pair_is_already_connected():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.create_request.side_effect = ConnectionsError(
            "CONNECTION_ALREADY_CONNECTED",
            "You are already connected with this person.",
            status_code=409,
        )
        resp = client.post("/api/one/connections/requests", json={"addressee_user_id": "user-b"})

    assert resp.status_code == 409
    assert resp.json() == {
        "detail": {
            "code": "CONNECTION_ALREADY_CONNECTED",
            "message": "You are already connected with this person.",
        }
    }


@pytest.mark.parametrize(
    ("name_only", "typed_search"), [(False, False), (True, False), (False, True)]
)
def test_directory_lists_items(name_only, typed_search):
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.search_directory.return_value = {
            "items": [],
            "page": 1,
            "hasMore": False,
        }
        resp = client.get(
            "/api/one/connections/directory",
            params={"query": "bo", "name_only": name_only, "typed_search": typed_search},
        )
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "page": 1, "hasMore": False}
    svc_cls.return_value.search_directory.assert_called_once_with(
        "user-a",
        query="bo",
        page=1,
        limit=20,
        audience="all",
        name_only=name_only,
        typed_search=typed_search,
    )


def test_directory_identity_outage_returns_retryable_503():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.search_directory.side_effect = DirectoryIdentityUnavailableError()
        resp = client.get("/api/one/connections/directory?query=divya")
    assert resp.status_code == 503
    assert resp.json() == {
        "detail": {
            "code": "DIRECTORY_IDENTITY_UNAVAILABLE",
            "message": "People search is temporarily unavailable. Try again.",
        }
    }


def test_contact_sync_reports_provider_outage_as_retryable():
    with (
        patch("api.routes.one.connections.ConnectionsService") as service,
        patch("api.routes.one.connections.ActorIdentityService") as identity,
        patch("api.routes.one.connections.RIAIAMService") as directory,
    ):
        identity.return_value.sync_contact_sync_requester_from_firebase = AsyncMock(
            return_value=None
        )
        directory.return_value.match_one_network_contact_lookups_exact = AsyncMock(
            return_value=[{"lookup_id": "contact1", "user_id": "peer"}]
        )
        service.return_value.sync_contact_matches.side_effect = DirectoryIdentityUnavailableError()
        response = _client().post(
            "/api/one/connections/contact-sync",
            json={"lookups": [{"lookup_id": "contact1", "hash": "a" * 64, "last4": "1234"}]},
        )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "DIRECTORY_IDENTITY_UNAVAILABLE"


def test_connections_no_params_preserves_legacy_complete_shape():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.list_connections.return_value = [{"connectionId": "cx-1"}]
        resp = client.get("/api/one/connections")
    assert resp.status_code == 200
    assert resp.json() == {"items": [{"connectionId": "cx-1"}]}
    assert resp.headers["cache-control"] == "private, no-store"
    svc_cls.return_value.list_connections.assert_called_once_with("user-a")
    svc_cls.return_value.list_connections_page.assert_not_called()


@pytest.mark.parametrize("account_check", [None, "observe", "reconcile"])
def test_connections_paging_filters_ria_before_returning_a_bounded_page(account_check):
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.list_connections_page.return_value = {
            "items": [{"connectionId": "cx-101", "connectedFromContacts": True}],
            "page": 2,
            "hasMore": True,
            "totalCount": 5000,
            "audience": "ria",
        }
        params = {"page": 2, "limit": 100, "query": "alex", "audience": "ria"}
        if account_check:
            params["account_check"] = account_check
        resp = client.get("/api/one/connections", params=params)
    assert resp.status_code == 200
    assert resp.json()["totalCount"] == 5000
    assert resp.headers["cache-control"] == "private, no-store"
    svc_cls.return_value.list_connections_page.assert_called_once_with(
        "user-a",
        page=2,
        limit=100,
        query="alex",
        audience="ria",
        **({"account_check": account_check} if account_check else {}),
    )


def test_get_voice_preferences_returns_the_stored_default():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.get_voice_preferences.return_value = {
            "shareScopesFromLastRequest": False,
            "updatedAt": None,
        }
        resp = client.get("/api/one/connect/voice-preferences")
    assert resp.status_code == 200
    assert resp.json() == {"preferences": {"shareScopesFromLastRequest": False, "updatedAt": None}}
    svc_cls.return_value.get_voice_preferences.assert_called_once_with(user_id="user-a")


def test_update_voice_preferences_threads_the_owner_and_flag():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.update_voice_preferences.return_value = {
            "shareScopesFromLastRequest": True,
            "updatedAt": "2026-08-26T09:00:00+00:00",
        }
        resp = client.patch(
            "/api/one/connect/voice-preferences",
            json={"share_scopes_from_last_request": True},
        )
    assert resp.status_code == 200
    assert resp.json()["preferences"]["shareScopesFromLastRequest"] is True
    svc_cls.return_value.update_voice_preferences.assert_called_once_with(
        user_id="user-a", share_scopes_from_last_request=True
    )


def test_directory_browse_and_search_keep_separate_bounded_daily_budgets(monkeypatch):
    from limits import parse
    from slowapi.errors import RateLimitExceeded

    from api.middlewares.rate_limit import RateLimits, limiter, rate_limit_exceeded_handler

    client = _client()
    client.app.state.limiter = limiter
    client.app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    monkeypatch.setattr(limiter, "enabled", True)
    limiter.reset()
    path = "/api/one/connections/directory"
    search_daily = parse(RateLimits.ONE_CONNECT_DIRECTORY_READ_DAILY)
    browse_daily = parse(RateLimits.ONE_CONNECT_DIRECTORY_BROWSE_DAILY)
    minute = parse(RateLimits.ONE_CONNECT_DIRECTORY_READ)
    try:
        # Exhaust search without hundreds of requests or a real identity store.
        assert limiter.limiter.hit(search_daily, "testclient:directory:search", path, cost=500)
        with patch("api.routes.one.connections.ConnectionsService") as service:
            service.return_value.search_directory.return_value = {
                "items": [],
                "page": 1,
                "hasMore": False,
            }
            assert client.get(path, params={"query": "name"}).status_code == 429
            assert client.get(path).status_code == 200
            assert client.get(path, params={"query": "  "}).status_code == 200
            # A client that stays foregrounded and refreshes the list twice a
            # minute reads 2,880 pages a day. That must never lock People out;
            # the old 500 budget did, which is the regression this guards.
            limiter.reset()
            assert limiter.limiter.hit(
                browse_daily, "testclient:directory:browse", path, cost=2_880
            )
            assert client.get(path).status_code == 200
            # Browsing is still daily-bounded, not exempt from abuse protection.
            assert limiter.limiter.hit(browse_daily, "testclient:directory:browse", path, cost=119)
            assert client.get(path).status_code == 429
            limiter.reset()
            assert limiter.limiter.hit(minute, "testclient", path, cost=60)
            assert client.get(path).status_code == 429
            assert client.get(path, params={"query": "name"}).status_code == 429
    finally:
        limiter.reset()
