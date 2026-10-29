from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import notifications


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(notifications.router)
    return app


@pytest.mark.parametrize("version", [True, -1, 2, "1"])
def test_sms_alarm_capability_rejects_invalid_versions(monkeypatch, version):
    monkeypatch.setattr(notifications, "verify_firebase_bearer", lambda _header: "owner")
    response = TestClient(_build_app()).post(
        "/api/notifications/register",
        json={
            "user_id": "owner",
            "token": "token",
            "platform": "android",
            "sms_alarm_version": version,
        },
        headers={"Authorization": "Bearer fixture"},
    )
    assert response.status_code == 400


def test_sms_alarm_capability_is_bound_to_a_ready_android_installation(monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    from hushh_mcp.services.chat_push_delivery import b64

    monkeypatch.setattr(notifications, "verify_firebase_bearer", lambda _header: "owner")
    public = (
        ec.generate_private_key(ec.SECP256R1())
        .public_key()
        .public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    )
    body = {
        "user_id": "owner",
        "token": "token",
        "platform": "android",
        "sms_alarm_version": 1,
        "device_id": "11111111-1111-4111-8111-111111111111",
        "preview_key_id": "22222222-2222-4222-8222-222222222222",
        "preview_public_key": b64(public),
    }
    upsert = MagicMock(return_value=1)
    monkeypatch.setattr(
        notifications, "PushTokensService", lambda: SimpleNamespace(upsert_user_push_token=upsert)
    )
    monkeypatch.setattr(
        "hushh_mcp.services.chat_push_delivery.retry_registered_chat_pushes", lambda _user: False
    )
    client = TestClient(_build_app())
    assert (
        client.post(
            "/api/notifications/register", json=body, headers={"Authorization": "Bearer fixture"}
        ).status_code
        == 200
    )
    assert upsert.call_args.kwargs["sms_alarm_version"] == 1
    assert (
        client.post(
            "/api/notifications/register",
            json={**body, "platform": "ios"},
            headers={"Authorization": "Bearer fixture"},
        ).status_code
        == 400
    )


@pytest.mark.asyncio
async def test_registration_keeps_auth_db_and_chat_recovery_off_the_serving_loop(monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    from hushh_mcp.services import (
        chat_push_delivery,
        circle_chat_notifications,
        direct_message_notifications,
    )
    from hushh_mcp.services.chat_push_delivery import b64

    loop_thread = threading.get_ident()
    threads = []
    key = (
        ec.generate_private_key(ec.SECP256R1())
        .public_key()
        .public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    )
    body = {
        "user_id": "current-owner",
        "token": "fixture-token",
        "platform": "ios",
        "device_id": "388b1e4b-25cf-4c63-aed0-281607f3dd9b",
        "preview_key_id": "488b1e4b-25cf-4c63-aed0-281607f3dd9b",
        "preview_public_key": b64(key),
    }

    def verify(_header):
        threads.append(threading.get_ident())
        return "current-owner"

    def upsert(**fields):
        threads.append(threading.get_ident())
        assert fields == body
        return 1

    def recover(user):
        threads.append(threading.get_ident())
        assert user == "current-owner"
        return 1

    wake_circle, wake_direct = MagicMock(), MagicMock()
    monkeypatch.setattr(notifications, "verify_firebase_bearer", verify)
    monkeypatch.setattr(
        notifications, "PushTokensService", lambda: SimpleNamespace(upsert_user_push_token=upsert)
    )
    monkeypatch.setattr(chat_push_delivery, "retry_registered_chat_pushes", recover)
    monkeypatch.setattr(circle_chat_notifications, "wake_circle_chat_push_worker", wake_circle)
    monkeypatch.setattr(
        direct_message_notifications, "wake_direct_message_push_worker", wake_direct
    )
    request = SimpleNamespace(
        headers={"Authorization": "Bearer fixture-proof"}, json=AsyncMock(return_value=body)
    )
    result = await notifications.register_push_token(request)
    assert result["ok"] and result["user_id"] == "current-owner"
    assert len(threads) == 3 and all(thread != loop_thread for thread in threads)
    wake_circle.assert_called_once_with()
    wake_direct.assert_called_once_with()


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


def test_registration_does_not_acknowledge_an_unpersisted_token(monkeypatch):
    monkeypatch.setattr(notifications, "verify_firebase_bearer", lambda _header: "current-owner")
    monkeypatch.setattr(
        notifications,
        "PushTokensService",
        lambda: SimpleNamespace(upsert_user_push_token=lambda **_fields: None),
    )
    response = TestClient(_build_app()).post(
        "/api/notifications/register",
        json={
            "user_id": "current-owner",
            "token": "fixture-token",
            "platform": "ios",
        },
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
