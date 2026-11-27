from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.feed import router
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.feed_service import POSTGRES_BIGINT_MAX


def _client(user_id: str = "user-a") -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: user_id
    return TestClient(app)


def test_feed_uses_authenticated_identity_and_validated_cursor() -> None:
    service = Mock()
    service.list_feed.return_value = {
        "items": [],
        "next_cursor": None,
        "unread_count": 0,
    }

    with patch("api.routes.one.feed._service", return_value=service):
        response = _client("authenticated-user").get("/api/one/feed?cursor=42&limit=25")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    service.list_feed.assert_called_once_with("authenticated-user", cursor=42, limit=25)


def test_feed_rejects_malformed_or_non_positive_cursors() -> None:
    client = _client()

    assert client.get("/api/one/feed?cursor=not-a-number").status_code == 422
    assert client.get("/api/one/feed?cursor=0").status_code == 422
    assert client.get(f"/api/one/feed?cursor={POSTGRES_BIGINT_MAX + 1}").status_code == 422


def test_mark_read_requires_a_positive_snapshot_watermark() -> None:
    client = _client()

    assert client.post("/api/one/feed/read", json={}).status_code == 422
    assert client.post("/api/one/feed/read", json={"up_to_id": None}).status_code == 422
    assert client.post("/api/one/feed/read", json={"up_to_id": 0}).status_code == 422

    service = Mock()
    service.mark_read.return_value = {"status": "ok"}
    with patch("api.routes.one.feed._service", return_value=service):
        response = client.post(
            "/api/one/feed/read",
            json={"up_to_id": str(POSTGRES_BIGINT_MAX)},
        )

    assert response.status_code == 200
    service.mark_read.assert_called_once_with("user-a", up_to_id=POSTGRES_BIGINT_MAX)
    service.reset_mock()
    with patch("api.routes.one.feed._service", return_value=service):
        assert (
            client.post(
                "/api/one/feed/read", json={"up_to_id": "12", "snapshot_fingerprint": "a" * 32}
            ).status_code
            == 200
        )
    service.mark_read.assert_called_once_with("user-a", up_to_id=12, snapshot_fingerprint="a" * 32)
    assert (
        client.post(
            "/api/one/feed/read", json={"up_to_id": "12", "snapshot_fingerprint": "invalid"}
        ).status_code
        == 422
    )

    assert (
        client.post(
            "/api/one/feed/read",
            json={"up_to_id": POSTGRES_BIGINT_MAX + 1},
        ).status_code
        == 422
    )


def test_dismiss_restore_and_clear_are_auth_scoped_and_validate_bigint() -> None:
    client = _client("signed-in-owner")
    service = Mock()
    token = "11111111-1111-4111-8111-111111111111"
    service.dismiss.return_value = {"status": "ok", "dismissal_token": token}
    service.restore.return_value = {"status": "ok", "restored": True}
    service.clear.return_value = {"status": "ok"}

    with patch("api.routes.one.feed._service", return_value=service):
        assert client.post("/api/one/feed/42/dismiss").json() == {
            "status": "ok",
            "dismissal_token": token,
        }
        assert client.post("/api/one/feed/42/restore", json={"dismissal_token": token}).json() == {
            "status": "ok",
            "restored": True,
        }
        assert client.post("/api/one/feed/clear", json={"up_to_id": "99"}).json() == {
            "status": "ok"
        }

    service.dismiss.assert_called_once_with("signed-in-owner", item_id=42)
    service.restore.assert_called_once_with("signed-in-owner", item_id=42, dismissal_token=token)
    service.clear.assert_called_once_with("signed-in-owner", up_to_id=99)
    service.clear.return_value = {"status": "ok", "snapshot_changed": True}
    with patch("api.routes.one.feed._service", return_value=service):
        conflict = client.post(
            "/api/one/feed/clear", json={"up_to_id": "99", "snapshot_fingerprint": "a" * 32}
        )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "FEED_SNAPSHOT_CHANGED"

    assert client.post("/api/one/feed/0/dismiss").status_code == 422
    assert client.post(f"/api/one/feed/{POSTGRES_BIGINT_MAX + 1}/restore").status_code == 422
    assert (
        client.post("/api/one/feed/42/restore", json={"dismissal_token": "bad"}).status_code == 422
    )
    assert client.post("/api/one/feed/clear", json={"up_to_id": 0}).status_code == 422


def test_feed_preserves_retryable_database_unavailable_semantics() -> None:
    service = Mock()
    service.list_feed.side_effect = DatabaseExecutionError(
        table_name="feed_events",
        operation="select",
        details="private driver details",
        status_code=503,
        code="DATABASE_UNAVAILABLE",
    )

    with patch("api.routes.one.feed._service", return_value=service):
        response = _client().get("/api/one/feed")

    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    assert response.json() == {
        "detail": {
            "code": "DATABASE_UNAVAILABLE",
            "message": "Feed is temporarily unavailable. Please try again.",
        }
    }
    assert "private driver details" not in response.text


def test_sos_card_clear_binds_the_vault_owner_and_bounds_the_ids() -> None:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "recipient-from-token"
    }
    client = TestClient(app)
    location = Mock()
    grant_id = "22222222-2222-4222-8222-222222222222"
    location.clear_received_grants.return_value = [grant_id]
    path = "/api/one/feed/sos-cards/clear"

    with patch("api.routes.one.feed._location_service", return_value=location):
        response = client.post(path, json={"grant_ids": [grant_id]})
        # The recipient comes only from the token, and ids are bounded UUIDs.
        rejected = [
            client.post(path, json=body).status_code
            for body in (
                {"grant_ids": [grant_id], "recipient_user_id": "someone-else"},
                {"grant_ids": []},
                {"grant_ids": [grant_id] * 51},
                {"grant_ids": ["not-a-grant-id"]},
            )
        ]

    assert response.status_code == 200
    assert response.json() == {"cleared_grant_ids": [grant_id]}
    location.clear_received_grants.assert_called_once_with(
        recipient_user_id="recipient-from-token", grant_ids=[grant_id]
    )
    assert rejected == [422, 422, 422, 422]

    signed_out = FastAPI()
    signed_out.include_router(router)
    assert TestClient(signed_out).post(path, json={"grant_ids": [grant_id]}).status_code == 401


def test_activity_reads_are_owner_scoped_private_and_validate_facets():
    service = Mock()
    service.search_activity.return_value = {"items": [], "next_cursor": None}
    service.operation_detail.return_value = {"item": {"id": "42"}, "milestones": []}
    client = _client("owner-only")
    with patch("api.routes.one.feed._service", return_value=service):
        search = client.post("/api/one/feed/search", json={"agent": "agent_kyc", "person": "Alex"})
        detail = client.get("/api/one/feed/42/activity?before_id=41")
        assert search.status_code == detail.status_code == 200
        assert (
            search.headers["cache-control"]
            == detail.headers["cache-control"]
            == "private, no-store"
        )
        assert service.search_activity.call_args.args == ("owner-only",)
        assert service.search_activity.call_args.kwargs["agent"] == "agent_kyc"
        service.operation_detail.assert_called_once_with("owner-only", item_id=42, before_id=41)
        for body in (
            {"user_id": "another-owner"},
            {"agent": "unknown"},
            {"scope": "kai"},
            {"query": "one/two/three/four/five/six/seven/eight/ninth"},
            {"from_at": "2026-10-02T00:00:00Z", "before_at": "2026-10-01T00:00:00Z"},
            {"from_at": "2026-10-01T00:00:00"},
            {"cursor": 0},
        ):
            assert client.post("/api/one/feed/search", json=body).status_code == 422
        assert client.get("/api/one/feed/0/activity").status_code == 422
        assert client.get("/api/one/feed/42/activity?before_id=0").status_code == 422
        service.operation_detail.return_value = None
        assert client.get("/api/one/feed/42/activity").status_code == 404


def test_activity_reads_require_authentication():
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    assert client.post("/api/one/feed/search", json={}).status_code in (401, 403)
    assert client.get("/api/one/feed/42/activity").status_code in (401, 403)


async def test_search_identity_requires_verified_client_workspace_and_rejects_same_names(
    monkeypatch,
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.services import feed_search_people as people
    from hushh_mcp.services import ria_iam_service as ria
    from hushh_mcp.services.connections_service import ConnectionsService

    contacts = [
        {"userId": "first", "displayName": "Ankit Kumar Singh", "publicPersonRef": "person-one"}
    ]
    monkeypatch.setattr(ConnectionsService, "list_connections", lambda _self, _owner: contacts)
    assert (await people.identity_top_hit("owner", "Singh Ank", None, "investor"))[
        "href"
    ].startswith("/people/person-one")
    contacts.append(
        {"userId": "second", "displayName": "Ankit Kumar Singh", "publicPersonRef": "person-two"}
    )
    assert await people.identity_top_hit("owner", "Ankit Kumar Singh", None, "investor") is None
    assert await people.identity_top_hit("owner", "Mom", None, "investor") is None
    assert await people.identity_top_hit("owner", "Ankit", "finance", "investor") is None
    client = SimpleNamespace(
        require_ria_verified=AsyncMock(),
        list_ria_clients=AsyncMock(
            return_value={
                "items": [
                    {"investor_user_id": "investor", "investor_display_name": "Ankit Kumar Singh"}
                ],
                "has_more": False,
            }
        ),
        get_ria_workspace=AsyncMock(return_value={"available_scope_metadata": ["approved scope"]}),
    )
    monkeypatch.setattr(ria, "RIAIAMService", lambda: client)
    hit = await people.identity_top_hit("advisor", "Ank", "advisor", "ria")
    assert hit["href"].startswith("/ria/clients/investor")
    client.require_ria_verified.assert_awaited_once_with("advisor")
    client.get_ria_workspace.assert_awaited_once_with("advisor", "investor")
    client.get_ria_workspace.side_effect = ria.RIAIAMPolicyError("No current consent", 403)
    assert await people.identity_top_hit("advisor", "Ank", "advisor", "ria") is None
    client.require_ria_verified.side_effect = ria.RIAIAMPolicyError("Unverified", 403)
    client.list_ria_clients.reset_mock()
    assert await people.identity_top_hit("advisor", "Ank", "advisor", "ria") is None
    client.list_ria_clients.assert_not_called()
