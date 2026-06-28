from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import notifications


def _build_app(firebase_uid: str | None = None) -> FastAPI:
    app = FastAPI()
    app.include_router(notifications.router)
    if firebase_uid is not None:
        app.dependency_overrides[require_firebase_auth] = lambda: firebase_uid
    return app


def test_register_push_token_requires_firebase_auth():
    client = TestClient(_build_app())
    response = client.post(
        "/api/notifications/register",
        json={"user_id": "user_123", "token": "fcm_token_123", "platform": "web"},
    )
    assert response.status_code == 401


def test_register_push_token_requires_user_id_and_token():
    client = TestClient(_build_app(firebase_uid="user_123"))

    response = client.post(
        "/api/notifications/register",
        json={"platform": "web"},
        headers={"Authorization": "Bearer firebase-token"},
    )

    # Pydantic validation returns 422 for missing required fields
    assert response.status_code == 422


def test_register_push_token_rejects_cross_user_registration():
    client = TestClient(_build_app(firebase_uid="user_123"))

    response = client.post(
        "/api/notifications/register",
        json={"user_id": "user_456", "token": "fcm_token_123", "platform": "web"},
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Cannot register token for another user"


def test_register_push_token_rejects_invalid_platform():
    client = TestClient(_build_app(firebase_uid="user_123"))

    response = client.post(
        "/api/notifications/register",
        json={
            "user_id": "user_123",
            "token": "fcm_token_123",
            "platform": "desktop",
        },
        headers={"Authorization": "Bearer firebase-token"},
    )

    # Pydantic Literal validation returns 422
    assert response.status_code == 422


def test_register_push_token_defaults_platform_to_web():
    client = TestClient(_build_app(firebase_uid="user_123"))

    with patch("api.routes.notifications.PushTokensService") as mock_service_class:
        mock_service = MagicMock()
        mock_service.upsert_user_push_token.return_value = "push_token_123"
        mock_service_class.return_value = mock_service

        response = client.post(
            "/api/notifications/register",
            json={"user_id": "user_123", "token": "fcm_token_123"},
            headers={"Authorization": "Bearer firebase-token"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "user_id": "user_123",
        "platform": "web",
        "id": "push_token_123",
    }


def test_register_push_token_maps_service_failure_to_500():
    client = TestClient(_build_app(firebase_uid="user_123"), raise_server_exceptions=False)

    with patch("api.routes.notifications.PushTokensService") as mock_service_class:
        mock_service = MagicMock()
        mock_service.upsert_user_push_token.side_effect = RuntimeError("db down")
        mock_service_class.return_value = mock_service

        response = client.post(
            "/api/notifications/register",
            json={"user_id": "user_123", "token": "fcm_token_123", "platform": "web"},
            headers={"Authorization": "Bearer firebase-token"},
        )

    assert response.status_code == 500
    assert response.json()["detail"] == "Failed to register token"


def test_unregister_push_token_requires_firebase_auth():
    client = TestClient(_build_app())
    response = client.request("DELETE", "/api/notifications/unregister")
    assert response.status_code == 401


def test_unregister_push_token_defaults_user_id_from_firebase_uid():
    client = TestClient(_build_app(firebase_uid="user_123"))

    with patch("api.routes.notifications.PushTokensService") as mock_service_class:
        mock_service = MagicMock()
        mock_service.delete_user_push_tokens.return_value = 2
        mock_service_class.return_value = mock_service

        response = client.request(
            "DELETE",
            "/api/notifications/unregister",
            headers={"Authorization": "Bearer firebase-token"},
        )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "user_id": "user_123", "deleted": 2}
    mock_service.delete_user_push_tokens.assert_called_once_with(user_id="user_123", platform=None)


def test_unregister_push_token_forwards_platform():
    client = TestClient(_build_app(firebase_uid="user_123"))

    with patch("api.routes.notifications.PushTokensService") as mock_service_class:
        mock_service = MagicMock()
        mock_service.delete_user_push_tokens.return_value = 1
        mock_service_class.return_value = mock_service

        response = client.request(
            "DELETE",
            "/api/notifications/unregister",
            json={"platform": "ios"},
            headers={"Authorization": "Bearer firebase-token"},
        )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "user_id": "user_123", "deleted": 1}
    mock_service.delete_user_push_tokens.assert_called_once_with(user_id="user_123", platform="ios")


def test_unregister_push_token_rejects_cross_user_unregistration():
    client = TestClient(_build_app(firebase_uid="user_123"))

    response = client.request(
        "DELETE",
        "/api/notifications/unregister",
        json={"user_id": "user_456"},
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Cannot unregister tokens for another user"


def test_unregister_push_token_maps_service_failure_to_500():
    client = TestClient(_build_app(firebase_uid="user_123"), raise_server_exceptions=False)

    with patch("api.routes.notifications.PushTokensService") as mock_service_class:
        mock_service = MagicMock()
        mock_service.delete_user_push_tokens.side_effect = RuntimeError("db down")
        mock_service_class.return_value = mock_service

        response = client.request(
            "DELETE",
            "/api/notifications/unregister",
            json={"platform": "web"},
            headers={"Authorization": "Bearer firebase-token"},
        )

    assert response.status_code == 500
    assert response.json()["detail"] == "Failed to unregister token(s)"
