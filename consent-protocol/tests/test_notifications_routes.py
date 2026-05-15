from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import notifications


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(notifications.router)
    return app


def test_register_push_token_requires_firebase_auth():
    client = TestClient(_build_app())
    response = client.post(
        "/api/notifications/register",
        json={"user_id": "user_123", "token": "fcm_token_123", "platform": "web"},
    )

    assert response.status_code == 401


def test_register_push_token_rejects_invalid_json(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

    response = client.post(
        "/api/notifications/register",
        content="{invalid json",
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid JSON body"


def test_register_push_token_requires_user_id_and_token(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

    response = client.post(
        "/api/notifications/register",
        json={"platform": "web"},
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "user_id and token are required"


def test_register_push_token_rejects_cross_user_registration(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

    response = client.post(
        "/api/notifications/register",
        json={"user_id": "user_456", "token": "fcm_token_123", "platform": "web"},
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Cannot register token for another user"


def test_register_push_token_rejects_invalid_platform(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

    response = client.post(
        "/api/notifications/register",
        json={
            "user_id": "user_123",
            "token": "fcm_token_123",
            "platform": "desktop",
        },
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "platform must be one of: web, ios, android"


def test_register_push_token_defaults_platform_to_web(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

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


def test_register_push_token_maps_service_failure_to_500(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

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


def test_unregister_push_token_defaults_user_id_from_firebase_uid(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

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


def test_unregister_push_token_forwards_platform(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

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


def test_unregister_push_token_rejects_cross_user_unregistration(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

    response = client.request(
        "DELETE",
        "/api/notifications/unregister",
        json={"user_id": "user_456"},
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Cannot unregister tokens for another user"


def test_unregister_push_token_handles_missing_json_body(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

    with patch("api.routes.notifications.PushTokensService") as mock_service_class:
        mock_service = MagicMock()
        mock_service.delete_user_push_tokens.return_value = 3
        mock_service_class.return_value = mock_service

        response = client.request(
            "DELETE",
            "/api/notifications/unregister",
            content="{invalid json",
            headers={"Authorization": "Bearer firebase-token"},
        )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "user_id": "user_123", "deleted": 3}
    mock_service.delete_user_push_tokens.assert_called_once_with(user_id="user_123", platform=None)


def test_unregister_push_token_maps_service_failure_to_500(monkeypatch):
    client = TestClient(_build_app())
    monkeypatch.setattr(
        "api.routes.notifications.verify_firebase_bearer",
        lambda auth_header: "user_123",
    )

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
