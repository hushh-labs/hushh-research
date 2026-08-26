from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
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

    assert (
        client.post(
            "/api/one/feed/read",
            json={"up_to_id": POSTGRES_BIGINT_MAX + 1},
        ).status_code
        == 422
    )


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
