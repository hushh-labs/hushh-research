import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import location_chat, location_chat_plans

pytestmark = pytest.mark.usefixtures("shared_hub_owner")


def _build_app(user_id: str = "user_123") -> TestClient:
    app = FastAPI()
    app.include_router(location_chat.router)
    app.include_router(location_chat_plans.router)
    app.dependency_overrides[location_chat.require_vault_owner_token] = lambda: {
        "user_id": user_id,
        "scope": "vault.owner",
        "token": "vault-token",  # noqa: S106
    }
    return TestClient(app)


def test_chat_route_happy_path(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(
            self,
            *,
            user_id,
            message=None,
            consent_token,
            conversation_id=None,
            action_result=None,
            selection_result=None,
        ):
            captured.update(
                {
                    "user_id": user_id,
                    "message": message,
                    "consent_token": consent_token,
                    "conversation_id": conversation_id,
                }
            )
            return {
                "conversationId": "conv-1",
                "response": "Stopped sharing with Mom.",
                "isComplete": True,
                "stateChanged": True,
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app(user_id="user_123")

    response = client.post(
        "/api/one/location/chat",
        json={"message": "stop sharing with Mom"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["conversationId"] == "conv-1"
    assert body["stateChanged"] is True
    # user_id comes from the token, consent token is forwarded
    assert captured["user_id"] == "user_123"
    assert captured["consent_token"] == "vault-token"
    assert captured["message"] == "stop sharing with Mom"


def test_chat_route_accepts_conversation_id_camel_alias(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(
            self,
            *,
            user_id,
            message=None,
            consent_token,
            conversation_id=None,
            action_result=None,
            selection_result=None,
        ):
            captured["conversation_id"] = conversation_id
            return {
                "conversationId": conversation_id,
                "response": "ok",
                "isComplete": True,
                "stateChanged": True,
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post(
        "/api/one/location/chat",
        json={"message": "hi", "conversationId": "conv-9"},
    )

    assert response.status_code == 200
    assert captured["conversation_id"] == "conv-9"


def test_chat_route_rejects_empty_message(monkeypatch):
    monkeypatch.setattr(location_chat, "_service", lambda: object())
    client = _build_app()

    response = client.post("/api/one/location/chat", json={"message": ""})

    assert response.status_code == 422


def test_chat_route_returns_opaque_error_on_failure(monkeypatch):
    class _Service:
        async def handle_turn(self, **kwargs):
            raise RuntimeError("secret internal detail")

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post("/api/one/location/chat", json={"message": "do it"})

    assert response.status_code == 500
    assert "secret internal detail" not in response.text
    assert response.json()["detail"] == "Location chat could not be processed"


def test_chat_route_forwards_action_result(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(
            self,
            *,
            user_id,
            message=None,
            consent_token,
            conversation_id=None,
            action_result=None,
            selection_result=None,
        ):
            captured.update(
                {
                    "message": message,
                    "action_result": action_result,
                    "conversation_id": conversation_id,
                }
            )
            return {
                "conversationId": conversation_id,
                "response": "Done — your live location is now shared. ✓",
                "isComplete": True,
                "stateChanged": True,
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post(
        "/api/one/location/chat",
        json={
            "conversationId": "conv-1",
            "actionResult": {"id": "a1", "type": "publish_share", "status": "completed"},
        },
    )

    assert response.status_code == 200
    assert response.json()["stateChanged"] is True
    assert captured["message"] is None
    assert captured["action_result"] == {"id": "a1", "type": "publish_share", "status": "completed"}
    assert captured["conversation_id"] == "conv-1"


def test_chat_route_passes_through_client_action(monkeypatch):
    class _Service:
        async def handle_turn(self, **kwargs):
            return {
                "conversationId": "c1",
                "response": "Ready to share with Mom.",
                "isComplete": True,
                "stateChanged": False,
                "clientAction": {
                    "id": "act-1",
                    "type": "publish_share",
                    "shares": [
                        {
                            "grantId": "g1",
                            "recipientUserId": "r1",
                            "recipientKeyId": "k1",
                            "label": "Mom",
                        }
                    ],
                    "summary": "Share your live location with Mom",
                },
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post("/api/one/location/chat", json={"message": "share with Mom"})

    assert response.status_code == 200
    body = response.json()
    assert body["clientAction"]["type"] == "publish_share"
    assert body["clientAction"]["shares"][0]["label"] == "Mom"


def test_chat_route_forwards_selection_result(monkeypatch):
    captured: dict = {}

    class _Service:
        async def handle_turn(
            self,
            *,
            user_id,
            message=None,
            consent_token,
            conversation_id=None,
            action_result=None,
            selection_result=None,
        ):
            captured["selection_result"] = selection_result
            return {
                "conversationId": "c1",
                "response": "ok",
                "isComplete": True,
                "stateChanged": True,
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()

    response = client.post(
        "/api/one/location/chat",
        json={
            "conversationId": "c1",
            "selectionResult": {
                "id": "prm-1",
                "kind": "select",
                "selected": [{"grantId": "g1"}],
                "status": "answered",
            },
        },
    )

    assert response.status_code == 200
    assert captured["selection_result"] == {
        "id": "prm-1",
        "kind": "select",
        "selected": [{"grantId": "g1"}],
        "status": "answered",
    }


def test_chat_route_passes_through_client_prompt(monkeypatch):
    class _Service:
        async def handle_turn(self, **kwargs):
            return {
                "conversationId": "c1",
                "response": "Which sharing do you want to stop?",
                "isComplete": True,
                "stateChanged": False,
                "clientPrompt": {
                    "id": "prm-1",
                    "kind": "select",
                    "purpose": "select_share",
                    "question": "?",
                    "options": [{"label": "Mom", "ref": {"grantId": "g1"}}],
                },
            }

    monkeypatch.setattr(location_chat, "_service", lambda: _Service())
    client = _build_app()
    response = client.post("/api/one/location/chat", json={"message": "stop sharing"})
    assert response.status_code == 200
    assert response.json()["clientPrompt"]["purpose"] == "select_share"


def test_chat_route_rejects_when_no_input(monkeypatch):
    monkeypatch.setattr(location_chat, "_service", lambda: object())
    client = _build_app()
    response = client.post("/api/one/location/chat", json={})
    assert response.status_code == 422


def test_main_chat_review_endpoint_uses_the_authenticated_owner(monkeypatch):
    captured = {}

    class _PlanService:
        def __init__(self, _location):
            pass

        def prepare(self, **kwargs):
            captured.update(kwargs)
            return {"status": "review"}

    monkeypatch.setattr(location_chat_plans, "_service", object)
    monkeypatch.setattr(location_chat_plans, "LocationChatPlanService", _PlanService)
    client = _build_app(user_id="owner_123")
    path = "/api/one/location/chat-plans/prepare"

    response = client.post(path, json={"action": "share_pin", "personUserId": "recipient"})

    assert response.status_code == 200
    assert response.json() == {"status": "review"}
    assert captured["user_id"] == "owner_123"
    assert captured["person_user_id"] == "recipient"

    response = client.post(path, json={"action": "share_pin", "userId": "another_owner"})
    assert response.status_code == 422


def test_main_chat_review_pagination_uses_owner_and_validates_cursor(monkeypatch):
    captured = {}

    class _PlanService:
        def __init__(self, _location):
            pass

        def for_origin_page(self, **kwargs):
            captured.update(kwargs)
            return {"plans": [], "nextCursor": None}

    monkeypatch.setattr(location_chat_plans, "_service", object)
    monkeypatch.setattr(location_chat_plans, "LocationChatPlanService", _PlanService)
    client = _build_app(user_id="owner_123")
    origin = "00000000-0000-4000-8000-000000000001"
    cursor = "00000000-0000-4000-8000-000000000002"
    path = f"/api/one/location/chat-plans/origin/{origin}"
    response = client.get(path, params={"cursor": cursor, "userId": "another-owner"})
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json() == {"plans": [], "nextCursor": None}
    assert captured == {"user_id": "owner_123", "origin_id": origin, "cursor": cursor}
    assert client.get(path, params={"cursor": "invalid"}).status_code == 422
