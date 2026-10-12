"""Project scopes follow each specialist turn, regardless of first caller."""

from __future__ import annotations

import importlib
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.runtime_providers import bind_managed_vertex_project
from hushh_mcp.services.information_chat_service import InformationChatService
from hushh_mcp.services.location_chat_service import LocationChatService

_CONSENT = "synthetic-consent"


@pytest.mark.parametrize("intro", [False, True])
def test_lazy_chat_heads_forward_the_managed_project(monkeypatch, intro):
    from api.routes.one import agent_chat

    class BuiltForProject(Exception):
        pass

    projects = []

    def build(**kwargs):
        projects.append(kwargs.get("vertex_project"))
        raise BuiltForProject

    head = agent_chat._intro_head if intro else agent_chat._one_head
    builder = "build_one_intro_text_agent" if intro else "build_one_text_agent"
    monkeypatch.setattr(agent_chat, "_ONE_CHAT_VERTEX_PROJECT", "hussh-511311")
    monkeypatch.setattr(agent_chat, builder, build)
    head.cache_clear()
    with pytest.raises(BuiltForProject):
        head()
    assert projects == ["hussh-511311"]
    assert head.cache_info().currsize == 0


@pytest.mark.parametrize("service_type", [LocationChatService, InformationChatService])
@pytest.mark.parametrize("first_surface", ["chat", "direct"])
async def test_reused_specialist_service_builds_model_for_current_project(
    monkeypatch: pytest.MonkeyPatch, service_type: type, first_surface: str
) -> None:
    """The bridge's lazy service singleton must not pin its first caller's model."""
    fleet_project = "hushh-vertex-personal54"
    chat_project = "hussh-511311"
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    monkeypatch.setenv("GENAI_GOOGLE_CLOUD_PROJECT", fleet_project)
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")
    monkeypatch.setenv("HUSHH_VERTEX_LOCATIONS", "global")
    monkeypatch.delenv("HUSHH_LOCAL_GCLOUD_ACCOUNT", raising=False)

    def scope(surface: str):
        return bind_managed_vertex_project(chat_project) if surface == "chat" else nullcontext()

    second_surface = "direct" if first_surface == "chat" else "chat"
    projects = []

    async def run(**kwargs):
        projects.append(kwargs["agent"].model.client_kwargs["project"])
        assert kwargs["user_id"] == "owner"
        assert kwargs["consent_token"] == "synthetic-consent"
        return SimpleNamespace(final_text="Scoped response", tool_results=[])

    monkeypatch.setattr(
        importlib.import_module(service_type.__module__), "run_specialist_adk_turn", run
    )
    store = SimpleNamespace(
        prepare_turn=AsyncMock(
            return_value=SimpleNamespace(history=[], conversation_id="conversation")
        ),
        add_message=AsyncMock(),
    )
    with scope(first_surface):
        service = service_type(chat_store=store, ready=lambda: True)
        assert service._adk_model is None
        first = await service.handle_turn(
            user_id="owner", message="Show my information", consent_token=_CONSENT
        )
    with scope(second_surface):
        second = await service.handle_turn(
            user_id="owner", message="Show my information", consent_token=_CONSENT
        )

    expected = {"chat": chat_project, "direct": fleet_project}
    assert tuple(projects) == (
        expected[first_surface],
        expected[second_surface],
    )
    assert first["isComplete"] and second["isComplete"]
    assert first["response"] == second["response"] == "Scoped response"


@pytest.mark.parametrize("service_type", [LocationChatService, InformationChatService])
@pytest.mark.parametrize("injected_model", [False, True])
async def test_explicit_pod_model_wins_over_legacy_callback(
    monkeypatch, service_type, injected_model
):
    from google.adk.models import Gemini
    from google.genai import types

    model = Gemini(model="synthetic-owner-model") if injected_model else None
    store = SimpleNamespace(
        prepare_turn=AsyncMock(
            return_value=SimpleNamespace(history=[], conversation_id="conversation")
        ),
        add_message=AsyncMock(),
    )
    service = service_type(
        chat_store=store, model=model, model_call=AsyncMock(), genai_types=types, ready=lambda: True
    )
    adk = AsyncMock(return_value=SimpleNamespace(final_text="Owner model", tool_results=[]))
    monkeypatch.setattr(
        importlib.import_module(service_type.__module__), "run_specialist_adk_turn", adk
    )
    legacy_result = ("Legacy callback", False, False, []) + (
        ([],) if service_type is LocationChatService else ()
    )
    legacy = AsyncMock(return_value=legacy_result)
    monkeypatch.setattr(service, "_run_tool_loop", legacy)
    result = await service.handle_turn(
        user_id="owner", message="Show my information", consent_token=_CONSENT
    )
    assert result["isComplete"]
    if injected_model:
        assert adk.await_args.kwargs["agent"].model is model
        assert result["response"] == "Owner model"
        legacy.assert_not_awaited()
    else:
        legacy.assert_awaited_once()
        assert result["response"] == "Legacy callback"
        adk.assert_not_awaited()
