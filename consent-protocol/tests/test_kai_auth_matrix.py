"""Sealed Kai route authentication matrix tests.

These tests focus on auth-gate behavior for protected Kai endpoints:
- missing token -> 401
- invalid token -> 401
- user mismatch (where applicable) -> 403
- valid VAULT_OWNER token is accepted by auth gate (status is not 401/403)
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.testclient import TestClient

from api.routes.kai import router as kai_router
from hushh_mcp.services.kai_chat_service import KaiChatResponse


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(kai_router)
    return TestClient(app)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _portfolio_files(filename: str = "statement.csv"):
    return {"file": (filename, b"symbol,qty\nAAPL,1\n", "text/csv")}


class _StubChatDB:
    async def list_conversations(self, user_id: str, limit: int = 20, offset: int = 0):
        return []


class _StubChatService:
    chat_db = _StubChatDB()

    async def process_message(self, user_id: str, message: str, conversation_id: str | None = None):
        return KaiChatResponse(
            conversation_id=conversation_id or "conv_test",
            response="ok",
            component_type=None,
            component_data=None,
            learned_attributes=[],
            tokens_used=1,
        )

    async def get_conversation_history(self, conversation_id: str, limit: int = 50):
        return []

    async def get_initial_chat_state(self, user_id: str):
        return {
            "is_new_user": False,
            "has_portfolio": False,
            "has_financial_data": False,
            "welcome_type": "new",
            "total_attributes": 0,
            "available_domains": [],
        }

    async def analyze_portfolio_loser(
        self,
        user_id: str,
        ticker: str,
        conversation_id: str | None = None,
    ):
        return {
            "conversation_id": conversation_id or "conv_test",
            "ticker": ticker,
            "decision": "HOLD",
            "confidence": 0.51,
            "summary": "stubbed",
            "reasoning": "stubbed",
            "component_type": "analysis_summary",
            "component_data": {},
            "saved_to_pkm": False,
        }


class _StubPersonalKnowledgeModelService:
    async def store_domain_data(self, *args, **kwargs):
        return True

    async def get_domain_data(self, *args, **kwargs):
        return None

    async def delete_domain_data(self, *args, **kwargs):
        return True


@pytest.fixture
def stub_kai_chat_service(monkeypatch):
    import api.routes.kai.chat as chat_routes

    monkeypatch.setattr(chat_routes, "get_kai_chat_service", lambda: _StubChatService())


@pytest.fixture
def stub_kai_stream(monkeypatch):
    import api.routes.kai.stream as stream_routes

    async def _noop_log_operation(self, *args, **kwargs):
        return None

    async def _fake_generator(*args, **kwargs):
        yield {"event": "ping", "data": "{}", "id": "1"}

    monkeypatch.setattr(stream_routes.ConsentDBService, "log_operation", _noop_log_operation)
    monkeypatch.setattr(stream_routes, "analyze_stream_generator", _fake_generator)


@pytest.fixture
def stub_losers_stream_response(monkeypatch):
    import api.routes.kai.losers as losers_routes

    def _fake_event_source_response(*args, **kwargs):
        headers = kwargs.get("headers") or {}
        return Response(content="stubbed", media_type="text/event-stream", headers=headers)

    monkeypatch.setattr(losers_routes, "EventSourceResponse", _fake_event_source_response)


class TestPortfolioImportRoutes:
    def test_portfolio_import_missing_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/import",
            data={"user_id": "user_a"},
            files=_portfolio_files(),
        )
        assert response.status_code == 401

    def test_portfolio_import_invalid_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/import",
            data={"user_id": "user_a"},
            files=_portfolio_files(),
            headers=_auth("invalid_token"),
        )
        assert response.status_code == 401

    def test_portfolio_import_user_mismatch_returns_403(self, client, vault_owner_token_for_user):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/import",
            data={"user_id": "user_b"},
            files=_portfolio_files(),
            headers=_auth(token),
        )
        assert response.status_code == 403

    def test_portfolio_import_valid_token_passes_auth_gate(
        self, client, vault_owner_token_for_user
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/import",
            data={"user_id": "user_a"},
            files=_portfolio_files(filename=""),
            headers=_auth(token),
        )
        assert response.status_code not in {401, 403}

    def test_portfolio_import_stream_missing_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/import/stream",
            data={"user_id": "user_a"},
            files=_portfolio_files(),
        )
        assert response.status_code == 401

    def test_portfolio_import_stream_invalid_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/import/stream",
            data={"user_id": "user_a"},
            files=_portfolio_files(),
            headers=_auth("invalid_token"),
        )
        assert response.status_code == 401

    def test_portfolio_import_stream_user_mismatch_returns_403(
        self, client, vault_owner_token_for_user
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/import/stream",
            data={"user_id": "user_b"},
            files=_portfolio_files(),
            headers=_auth(token),
        )
        assert response.status_code == 403

    def test_portfolio_import_stream_valid_token_passes_auth_gate(
        self, client, vault_owner_token_for_user
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/import/stream",
            data={"user_id": "user_a"},
            files=_portfolio_files(filename=""),
            headers=_auth(token),
        )
        assert response.status_code not in {401, 403}


class TestPortfolioLosersRoutes:
    def test_analyze_losers_missing_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/analyze-losers",
            json={"user_id": "user_a", "losers": []},
        )
        assert response.status_code == 401

    def test_analyze_losers_invalid_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/analyze-losers",
            json={"user_id": "user_a", "losers": []},
            headers=_auth("invalid_token"),
        )
        assert response.status_code == 401

    def test_analyze_losers_user_mismatch_returns_403(self, client, vault_owner_token_for_user):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/analyze-losers",
            json={"user_id": "user_b", "losers": []},
            headers=_auth(token),
        )
        assert response.status_code == 403

    def test_analyze_losers_valid_token_passes_auth_gate(self, client, vault_owner_token_for_user):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/analyze-losers",
            json={"user_id": "user_a", "losers": []},
            headers=_auth(token),
        )
        assert response.status_code not in {401, 403}

    def test_analyze_losers_stream_missing_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/analyze-losers/stream",
            json={"user_id": "user_a", "losers": []},
        )
        assert response.status_code == 401

    def test_analyze_losers_stream_invalid_token_returns_401(self, client):
        response = client.post(
            "/api/kai/portfolio/analyze-losers/stream",
            json={"user_id": "user_a", "losers": []},
            headers=_auth("invalid_token"),
        )
        assert response.status_code == 401

    def test_analyze_losers_stream_user_mismatch_returns_403(
        self, client, vault_owner_token_for_user
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/analyze-losers/stream",
            json={"user_id": "user_b", "losers": []},
            headers=_auth(token),
        )
        assert response.status_code == 403

    def test_analyze_losers_stream_valid_token_passes_auth_gate(
        self,
        client,
        vault_owner_token_for_user,
        stub_losers_stream_response,
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/portfolio/analyze-losers/stream",
            json={"user_id": "user_a", "losers": [{"symbol": "AAPL", "gain_loss_pct": -10.0}]},
            headers=_auth(token),
        )
        assert response.status_code not in {401, 403}


class TestKaiAnalyzeStreamRoutes:
    def test_analyze_stream_get_missing_token_returns_401(self, client):
        response = client.get(
            "/api/kai/analyze/stream", params={"ticker": "AAPL", "user_id": "user_a"}
        )
        assert response.status_code == 401

    def test_analyze_stream_get_invalid_token_returns_401(self, client):
        response = client.get(
            "/api/kai/analyze/stream",
            params={"ticker": "AAPL", "user_id": "user_a"},
            headers=_auth("invalid_token"),
        )
        assert response.status_code == 401

    def test_analyze_stream_get_user_mismatch_returns_403(self, client, vault_owner_token_for_user):
        token = vault_owner_token_for_user("user_a")
        response = client.get(
            "/api/kai/analyze/stream",
            params={"ticker": "AAPL", "user_id": "user_b"},
            headers=_auth(token),
        )
        assert response.status_code == 403

    def test_analyze_stream_get_valid_token_passes_auth_gate(
        self,
        client,
        vault_owner_token_for_user,
        stub_kai_stream,
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.get(
            "/api/kai/analyze/stream",
            params={"ticker": "AAPL", "user_id": "user_a"},
            headers=_auth(token),
        )
        assert response.status_code not in {401, 403}

    def test_analyze_stream_post_missing_token_returns_401(self, client):
        response = client.post(
            "/api/kai/analyze/stream",
            json={"ticker": "AAPL", "user_id": "user_a"},
        )
        assert response.status_code == 401

    def test_analyze_stream_post_invalid_token_returns_401(self, client):
        response = client.post(
            "/api/kai/analyze/stream",
            json={"ticker": "AAPL", "user_id": "user_a"},
            headers=_auth("invalid_token"),
        )
        assert response.status_code == 401

    def test_analyze_stream_post_user_mismatch_returns_403(
        self, client, vault_owner_token_for_user
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/analyze/stream",
            json={"ticker": "AAPL", "user_id": "user_b"},
            headers=_auth(token),
        )
        assert response.status_code == 403

    def test_analyze_stream_post_valid_token_passes_auth_gate(
        self,
        client,
        vault_owner_token_for_user,
        stub_kai_stream,
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/analyze/stream",
            json={"ticker": "AAPL", "user_id": "user_a"},
            headers=_auth(token),
        )
        assert response.status_code not in {401, 403}


class TestKaiChatKeyEndpoints:
    def test_chat_missing_token_returns_401(self, client):
        response = client.post("/api/kai/chat", json={"user_id": "user_a", "message": "hello"})
        assert response.status_code == 401

    def test_chat_invalid_token_returns_401(self, client):
        response = client.post(
            "/api/kai/chat",
            json={"user_id": "user_a", "message": "hello"},
            headers=_auth("invalid_token"),
        )
        assert response.status_code == 401

    def test_chat_user_mismatch_returns_403(self, client, vault_owner_token_for_user):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/chat",
            json={"user_id": "user_b", "message": "hello"},
            headers=_auth(token),
        )
        assert response.status_code == 403

    def test_chat_valid_token_passes_auth_gate(
        self, client, vault_owner_token_for_user, stub_kai_chat_service
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.post(
            "/api/kai/chat",
            json={"user_id": "user_a", "message": "hello"},
            headers=_auth(token),
        )
        assert response.status_code not in {401, 403}

    def test_chat_history_missing_token_returns_401(self, client):
        response = client.get("/api/kai/chat/history/conv_123")
        assert response.status_code == 401

    def test_chat_history_invalid_token_returns_401(self, client):
        response = client.get("/api/kai/chat/history/conv_123", headers=_auth("invalid_token"))
        assert response.status_code == 401

    def test_chat_history_valid_token_passes_auth_gate(
        self, client, vault_owner_token_for_user, stub_kai_chat_service
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.get("/api/kai/chat/history/conv_123", headers=_auth(token))
        assert response.status_code not in {401, 403}

    def test_chat_conversations_missing_token_returns_401(self, client):
        response = client.get("/api/kai/chat/conversations/user_a")
        assert response.status_code == 401

    def test_chat_conversations_invalid_token_returns_401(self, client):
        response = client.get("/api/kai/chat/conversations/user_a", headers=_auth("invalid_token"))
        assert response.status_code == 401

    def test_chat_conversations_user_mismatch_returns_403(self, client, vault_owner_token_for_user):
        token = vault_owner_token_for_user("user_a")
        response = client.get("/api/kai/chat/conversations/user_b", headers=_auth(token))
        assert response.status_code == 403

    def test_chat_conversations_valid_token_passes_auth_gate(
        self, client, vault_owner_token_for_user, stub_kai_chat_service
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.get("/api/kai/chat/conversations/user_a", headers=_auth(token))
        assert response.status_code not in {401, 403}

    def test_chat_initial_state_missing_token_returns_401(self, client):
        response = client.get("/api/kai/chat/initial-state/user_a")
        assert response.status_code == 401

    def test_chat_initial_state_invalid_token_returns_401(self, client):
        response = client.get("/api/kai/chat/initial-state/user_a", headers=_auth("invalid_token"))
        assert response.status_code == 401

    def test_chat_initial_state_user_mismatch_returns_403(self, client, vault_owner_token_for_user):
        token = vault_owner_token_for_user("user_a")
        response = client.get("/api/kai/chat/initial-state/user_b", headers=_auth(token))
        assert response.status_code == 403

    def test_chat_initial_state_valid_token_passes_auth_gate(
        self, client, vault_owner_token_for_user, stub_kai_chat_service
    ):
        token = vault_owner_token_for_user("user_a")
        response = client.get("/api/kai/chat/initial-state/user_a", headers=_auth(token))
        assert response.status_code not in {401, 403}


def test_support_message_is_queued(monkeypatch):
    from api.middleware import require_firebase_auth
    from api.routes.kai import support as support_routes

    queued_calls: list[dict[str, object]] = []

    class _FakeConfig:
        configured = True
        delivery_mode = "live"
        effective_recipient = "support@hushh.ai"
        support_to_email = "support@hushh.ai"
        from_email = "kai@hushh.ai"

    class _FakeSupportService:
        config = _FakeConfig()

        def send_message(self, **kwargs):  # noqa: ANN003
            raise AssertionError("send_message should not run inline")

    class _FakeQueue:
        async def enqueue(self, **kwargs):  # noqa: ANN003
            queued_calls.append(kwargs)
            return {
                "accepted": True,
                "delivery_status": "queued",
                "job_id": "job_1",
                "kind": kwargs["kind"],
                "queued_at": "2026-04-13T00:00:00Z",
            }

    monkeypatch.setattr(support_routes, "get_support_email_service", lambda: _FakeSupportService())
    monkeypatch.setattr(support_routes, "get_email_delivery_queue_service", lambda: _FakeQueue())

    app = FastAPI()
    app.include_router(kai_router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user_a"
    client = TestClient(app)

    response = client.post(
        "/api/kai/support/message",
        json={
            "user_id": "user_a",
            "kind": "support_request",
            "subject": "Queue check",
            "message": "Please queue this support request instead of sending inline.",
        },
    )

    assert response.status_code == 202
    payload = response.json()
    assert payload["delivery_status"] == "queued"
    assert payload["recipient"] == "support@hushh.ai"
    assert queued_calls[0]["kind"] == "support_message"


def test_fixture_token_is_deterministically_valid(vault_owner_token_for_user):
    """Quick sanity check that fixture-issued tokens are valid bearer strings."""
    token = vault_owner_token_for_user("fixture_user")
    assert isinstance(token, str)
    assert token
    assert "." in token


def test_fixture_auth_header_helper_returns_bearer(vault_owner_auth_headers):
    headers = vault_owner_auth_headers(user_id="fixture_user")
    assert headers["Authorization"].startswith("Bearer ")
    assert len(headers["Authorization"]) > len("Bearer ")
