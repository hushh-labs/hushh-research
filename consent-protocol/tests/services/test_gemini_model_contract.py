from __future__ import annotations

import pytest

from hushh_mcp.runtime_providers import (
    ManagedGeminiRuntimeBinding,
    generation_config_kwargs,
    resolve_model_entry,
)


def test_gemini_36_strips_legacy_sampling_controls():
    assert generation_config_kwargs(
        "gemini-3.6-flash",
        temperature=0,
        top_p=0.5,
        top_k=10,
        candidate_count=1,
        max_output_tokens=512,
        response_mime_type="application/json",
    ) == {
        "max_output_tokens": 512,
        "response_mime_type": "application/json",
    }


def test_other_models_preserve_their_supported_sampling_controls():
    assert generation_config_kwargs(
        "gemini-3.1-flash-lite",
        temperature=0,
        max_output_tokens=32,
    ) == {
        "temperature": 0,
        "max_output_tokens": 32,
    }


def test_gemini_36_is_text_only_and_global_vertex():
    entry = resolve_model_entry("gemini", "gemini-3.6-flash")
    assert entry.supports_streaming is True
    assert entry.supports_function_calling is True
    assert entry.supports_native_realtime is False
    assert entry.supported_vertex_locations == ("global",)


def test_managed_binding_filters_unsupported_failover_locations():
    binding = ManagedGeminiRuntimeBinding(
        project="test-project",
        locations=("global", "us", "eu"),
        auth_mode="vertex_adc",
    )
    assert binding.locations_for_model("gemini-3.6-flash") == ("global",)


def test_managed_binding_fails_when_global_is_not_configured():
    binding = ManagedGeminiRuntimeBinding(
        project="test-project",
        locations=("us", "eu"),
        auth_mode="vertex_adc",
    )
    with pytest.raises(RuntimeError, match="no configured supported Vertex location"):
        binding.locations_for_model("gemini-3.6-flash")
