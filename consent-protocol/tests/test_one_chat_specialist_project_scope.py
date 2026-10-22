"""Project scopes follow each specialist turn, regardless of first caller."""

from __future__ import annotations

from contextlib import nullcontext

import pytest

from hushh_mcp.runtime_providers import bind_managed_vertex_project
from hushh_mcp.services.information_chat_service import InformationChatService
from hushh_mcp.services.location_chat_service import LocationChatService


@pytest.mark.parametrize("service_type", [LocationChatService, InformationChatService])
@pytest.mark.parametrize("first_surface", ["chat", "direct"])
def test_reused_specialist_service_builds_model_for_current_project(
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
    with scope(first_surface):
        service = service_type(chat_store=object())
        assert service._adk_model is None
        first_project = service._build_adk_agent().model.client_kwargs["project"]
    with scope(second_surface):
        second_project = service._build_adk_agent().model.client_kwargs["project"]

    expected = {"chat": chat_project, "direct": fleet_project}
    assert (first_project, second_project) == (
        expected[first_surface],
        expected[second_surface],
    )
