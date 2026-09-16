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
