"""build_live_client: Vertex ADC only, one pinned region, fail-closed model pin."""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_providers import factory
from hushh_mcp.runtime_providers.registry import (
    LiveModelNotRegisteredError,
    resolve_live_model_entry,
    resolve_model_entry,
)

LIVE_MODEL = "gemini-live-2.5-flash-native-audio"


class _FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


@pytest.fixture
def fake_genai_client(monkeypatch):
    calls: list[dict] = []

    def _factory(**kwargs):
        calls.append(kwargs)
        return _FakeClient(**kwargs)

    import google.genai as genai

    monkeypatch.setattr(genai, "Client", _factory)
    return calls


def _binding() -> factory.ManagedGeminiRuntimeBinding:
    return factory.ManagedGeminiRuntimeBinding(
        project="hushh-vertex-test",
        locations=("global", "us"),
        auth_mode=factory.VERTEX_ADC_AUTH_MODE,
    )


def test_live_entry_is_realtime_regional_and_alias_free():
    entry = resolve_live_model_entry(LIVE_MODEL)
    assert entry.supports_native_realtime is True
    assert entry.supported_vertex_locations == ("us-central1",)
    assert entry.aliases == ()
    # The ordinary resolver sees the same entry; nothing else advertises realtime.
    assert resolve_model_entry("gemini", LIVE_MODEL).supports_native_realtime is True
    assert resolve_model_entry("gemini", "gemini-3.5-flash").supports_native_realtime is False


@pytest.mark.parametrize(
    "model_id",
    ["", "gemini-3.1-flash-live-preview", "gemini-3.8-flash", "gemini-default", "default"],
)
def test_live_resolver_fails_closed_on_pass_through_aliases_and_text_models(model_id):
    with pytest.raises(LiveModelNotRegisteredError):
        resolve_live_model_entry(model_id)


def test_build_live_client_pins_one_regional_vertex_client(fake_genai_client):
    client = _binding().build_live_client(model=LIVE_MODEL, location="us-central1")
    assert isinstance(client, _FakeClient)
    assert fake_genai_client == [
        {"vertexai": True, "project": "hushh-vertex-test", "location": "us-central1"}
    ]


@pytest.mark.parametrize("location", ["global", "us", "eu", ""])
def test_build_live_client_rejects_multi_region_aliases(fake_genai_client, location):
    with pytest.raises(RuntimeError, match="regional"):
        _binding().build_live_client(model=LIVE_MODEL, location=location)
    assert fake_genai_client == []


def test_build_live_client_rejects_unsupported_region_for_model(fake_genai_client):
    with pytest.raises(RuntimeError, match="not supported"):
        _binding().build_live_client(model=LIVE_MODEL, location="europe-west4")
    assert fake_genai_client == []


def test_build_live_client_rejects_unregistered_model(fake_genai_client):
    with pytest.raises(LiveModelNotRegisteredError):
        _binding().build_live_client(model="gemini-3.1-flash-live-preview", location="us-central1")
    assert fake_genai_client == []


def test_build_live_client_refuses_developer_api_key_mode(fake_genai_client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "developer-key")
    binding = factory.ManagedGeminiRuntimeBinding(
        project="", locations=(), auth_mode=factory.DEVELOPER_API_KEY_AUTH_MODE
    )
    with pytest.raises(RuntimeError, match="Vertex ADC"):
        binding.build_live_client(model=LIVE_MODEL, location="us-central1")
    assert fake_genai_client == []


def test_hosted_environment_cannot_select_developer_key_for_live(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "developer_api_key")
    with pytest.raises(RuntimeError, match="Vertex ADC"):
        factory.build_managed_live_client(model=LIVE_MODEL, location="us-central1")


# --- the declarations really reach the Live model ---------------------------


def test_build_live_config_declares_the_device_tools_verbatim_from_one_home():
    from hushh_mcp.one_voice.instruction import build_instruction
    from hushh_mcp.one_voice.live_client import build_live_config
    from hushh_mcp.one_voice.tools import location_state, registry
    from hushh_mcp.one_voice.tools.base import ScreenContext
    from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS

    # A session opened from /one: no Location page mounted, nothing said yet.
    screen = ScreenContext(screen_id="one_home", route="/one")
    declarations = registry.declarations()
    config = build_live_config(
        system_instruction=build_instruction(
            tool_declarations=declarations,
            screen_ids=list(OPENABLE_SCREENS),
            screen_id=screen.screen_id,
            display_name="Ayesha",
        ),
        tool_declarations=declarations,
        voice_name="Leda",
        resumption_handle=None,
    )

    assert len(config.tools) == 1
    declared = {item.name: item for item in config.tools[0].function_declarations}
    for name in ("resume_device_location_updates", "pause_device_location_updates"):
        spec = next(tool for tool in location_state.TOOLS if tool.name == name)
        assert name in declared, name
        assert declared[name].description == spec.description
        assert declared[name].parameters_json_schema == {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        }
    assert "resume_device_location_updates" in config.system_instruction.parts[0].text
    assert "one_home" in config.system_instruction.parts[0].text
