"""Research respects provider availability, receipt authority and shared budgets."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import world_model as pwm


def test_identity_and_report_must_agree():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        pwm.WorldModelReport.model_validate(
            {
                "identity": {"state": "ambiguous", "reason": "Namesakes", "probability": None},
                "match_status": "matched",
                "name": "Alex Example",
                "summary": "A draft",
                "sections": [],
                "checked_topics": [],
                "gaps": [],
            }
        )


@pytest.mark.asyncio
async def test_no_key_never_constructs_a_provider_client(monkeypatch):
    import hushh_mcp.runtime_providers as providers

    monkeypatch.setattr(pwm, "pwm_tavily_api_key", lambda: "")
    monkeypatch.setattr(
        providers,
        "build_managed_regional_gemini_adk_model",
        lambda *_: pytest.fail("provider dispatched"),
    )
    result = await pwm.run_world_model(
        identity={},
        user_id="owner",
        consent_token="fixture",  # noqa: S106 - synthetic authority fixture
        require_access=AsyncMock(),
    )
    assert result == {"status": "unavailable", "pkm_written": False}


@pytest.mark.asyncio
async def test_search_budget_is_charged_before_http_and_unknown_refs_fail(monkeypatch):
    from google.adk.models.base_llm import BaseLlm

    import hushh_mcp.hushh_adk.turn as turn_module
    import hushh_mcp.runtime_providers as providers

    class FakeModel(BaseLlm):
        model: str = "synthetic"

        async def generate_content_async(self, *args, **kwargs):
            if False:
                yield None

    events = []
    monkeypatch.setattr(pwm, "pwm_tavily_api_key", lambda: "synthetic-test-key")
    monkeypatch.setattr(
        providers, "build_managed_regional_gemini_adk_model", lambda *_: FakeModel()
    )

    async def charge(indices):
        events.append(("charge", indices))

    async def quota():
        events.append(("quota",))
        return True

    monkeypatch.setattr(pwm, "charge_search_credit", quota)

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            events.append(("http",))
            return SimpleNamespace(
                status_code=200,
                json=lambda: {
                    "results": [
                        {
                            "title": "Source",
                            "url": "https://example.com/alex",
                            "content": "Alex writes software.",
                        }
                    ]
                },
            )

    monkeypatch.setattr(pwm.httpx, "AsyncClient", Client)

    async def run(**kwargs):
        agent = kwargs["agent"]
        await agent.before_model_callback(None, None)
        response = await agent.tools[0]("Alex Example")
        assert response["sources"][0]["ref"] == "s1"
        assert response["sources"][0]["url"] == "https://example.com/alex"
        return SimpleNamespace(
            structured_output={
                "identity": {
                    "state": "owner_linked",
                    "reason": "Exact public contact matches",
                    "probability": None,
                },
                "match_status": "matched",
                "name": "Alex Example",
                "summary": "Public work",
                "sections": [
                    {
                        "kind": "career",
                        "facts": [
                            {
                                "statement": "Writes software.",
                                "confidence": "supported",
                                "sources": [{"title": "Source", "ref": "s999"}],
                            }
                        ],
                    }
                ],
                "checked_topics": ["career"],
                "gaps": [],
            }
        )

    monkeypatch.setattr(turn_module, "run_specialist_adk_turn", run)
    with pytest.raises(KeyError):
        await pwm.run_world_model(
            identity={},
            user_id="owner",
            consent_token="fixture",  # noqa: S106 - synthetic authority fixture
            require_access=AsyncMock(),
            on_attempts_start=charge,
        )
    assert events == [("charge", (33,)), ("charge", (1,)), ("quota",), ("http",)]


def test_integration_endpoint_only_accepts_current_owner_identifiers(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.routes.one import world_model as routes
    from hushh_mcp.services import world_model_service

    start = AsyncMock(return_value={"status": "pending", "pkm_written": False})
    monkeypatch.setattr(routes, "world_model_jobs", SimpleNamespace(start=start))
    monkeypatch.setattr(
        world_model_service,
        "owner_identity",
        AsyncMock(
            return_value={
                "full_name": "Alex Example",
                "email": "alex@example.test",
                "phone_number": None,
            }
        ),
    )
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_chat_key] = lambda: {
        "user_id": "owner",
        "token": "fixture",
    }
    client = TestClient(app)
    body = {"name": "Alex Example", "email": "alex@example.test"}
    result = client.post("/api/one/world-model/research", json=body)
    assert result.status_code == 202
    assert result.headers["cache-control"] == "private, no-store"
    start.assert_awaited_once_with("owner", "fixture")
    for invalid in [{**body, "email": "other@example.test"}, {"name": "Alex Example"}]:
        assert client.post("/api/one/world-model/research", json=invalid).status_code == 403
    assert (
        client.post("/api/one/world-model/research", json={**body, "user_id": "other"}).status_code
        == 422
    )
    assert start.await_count == 1
