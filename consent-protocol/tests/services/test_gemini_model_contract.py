"""Pins the Gemini generation contract to the live probe of 2026-09-14.

Measured matrix (each supported model, each check):
  baseline                 accept 200
  thinking_level LOW       accept 200
  thinking_level MEDIUM    accept 200
  thinking_level HIGH      accept 200
  thinking_level MINIMAL   reject 400 INVALID_ARGUMENT
                           "Thinking level is unsupported: THINKING_LEVEL_MINIMAL"
  temperature 0.2          accept 200 (silent acceptance; the field no longer means anything)
  function_response no id  accept 200 (the model returns function_call.id)
  function_response id     accept 200 (id and name echoed back)

The adapter therefore strips the sampling fields, passes LOW / MEDIUM / HIGH through,
maps MINIMAL to LOW, and leaves every other model id untouched.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from google.genai import types as genai_types

from hushh_mcp.constants import GEMINI_MODEL
from hushh_mcp.runtime_providers import (
    ManagedGeminiRuntimeBinding,
    gemini_config,
    generation_config_kwargs,
    resolve_model_entry,
)

SUPPORTED = gemini_config.SUPPORTED_GEMINI_TEXT_MODELS
ACCEPTED_LEVELS = ("LOW", "MEDIUM", "HIGH")


def test_supported_ids_are_exactly_the_two_measured_releases() -> None:
    assert SUPPORTED == ("gemini-3.8-flash", "gemini-3.7-flash")
    assert GEMINI_MODEL in SUPPORTED
    for model in SUPPORTED:
        assert gemini_config.is_supported_gemini_text_model(model)
        assert gemini_config.is_supported_gemini_text_model(f"models/{model}")
        assert gemini_config.is_supported_gemini_text_model(model.upper())
    for other in (
        "gemini-3.6-flash",
        "gemini-3.1-pro-preview",
        "gemini-3.8-flash-live-preview",
        "gemini-3.1-flash-lite",
        "gemini-embedding-001",
        "",
        None,
    ):
        assert not gemini_config.is_supported_gemini_text_model(other)


def test_retired_generation_helpers_are_gone() -> None:
    for name in (
        "GEMINI_36_FLASH",
        "is_gemini_36_flash",
        "GEMINI_31_PRO_PREVIEW",
        "is_gemini_31_pro_preview",
        "_GEMINI_31_PRO_UNSUPPORTED_FIELDS",
        "_coerce_thinking_level_for_31_pro",
    ):
        assert not hasattr(gemini_config, name), name


def test_deprecated_flash_v3_alias_names_the_supported_set() -> None:
    # tests/test_fleet_text_model_switch.py still imports the old name.
    assert gemini_config.is_gemini_flash_v3 is gemini_config.is_supported_gemini_text_model


@pytest.mark.parametrize("model", SUPPORTED)
def test_supported_model_strips_legacy_sampling_controls(model: str) -> None:
    # temperature 0.2 measured "accept 200, silent acceptance": the provider ignores it,
    # so the adapter removes it rather than let a caller believe it took effect.
    assert generation_config_kwargs(
        model,
        temperature=0.2,
        top_p=0.5,
        top_k=10,
        candidate_count=1,
        max_output_tokens=512,
        response_mime_type="application/json",
    ) == {
        "max_output_tokens": 512,
        "response_mime_type": "application/json",
    }


@pytest.mark.parametrize("model", SUPPORTED)
def test_supported_model_baseline_passes_without_thinking_config(model: str) -> None:
    assert generation_config_kwargs(model, max_output_tokens=64) == {"max_output_tokens": 64}


@pytest.mark.parametrize("model", SUPPORTED)
@pytest.mark.parametrize("level", ACCEPTED_LEVELS)
def test_supported_model_passes_accepted_thinking_levels_through(model: str, level: str) -> None:
    enum_level = getattr(genai_types.ThinkingLevel, level)
    sdk_cfg = genai_types.ThinkingConfig(thinking_level=enum_level, include_thoughts=False)
    result = generation_config_kwargs(model, thinking_config=sdk_cfg)
    assert result["thinking_config"] is sdk_cfg
    assert result["thinking_config"].thinking_level == enum_level

    result = generation_config_kwargs(model, thinking_config={"thinking_level": level})
    assert result == {"thinking_config": {"thinking_level": level}}


@pytest.mark.parametrize("model", SUPPORTED)
def test_supported_model_maps_minimal_to_low(model: str) -> None:
    # MINIMAL measured reject 400 INVALID_ARGUMENT on both releases; LOW measured accept.
    sdk_cfg = genai_types.ThinkingConfig(
        thinking_level=genai_types.ThinkingLevel.MINIMAL,
        include_thoughts=True,
        thinking_budget=128,
    )
    result = generation_config_kwargs(model, thinking_config=sdk_cfg)
    rebuilt = result["thinking_config"]
    assert isinstance(rebuilt, genai_types.ThinkingConfig)
    assert rebuilt.thinking_level == genai_types.ThinkingLevel.LOW
    assert rebuilt.include_thoughts is True
    assert rebuilt.thinking_budget == 128
    # The caller's object is not mutated.
    assert sdk_cfg.thinking_level == genai_types.ThinkingLevel.MINIMAL

    for spelled in ("MINIMAL", "minimal", "THINKING_LEVEL_MINIMAL"):
        result = generation_config_kwargs(model, thinking_config={"thinking_level": spelled})
        assert result == {"thinking_config": {"thinking_level": "LOW"}}


@pytest.mark.parametrize("model", SUPPORTED)
def test_supported_model_keeps_include_thoughts_and_budget(model: str) -> None:
    result = generation_config_kwargs(
        model,
        thinking_config={"include_thoughts": True, "thinking_budget": 256, "thinking_level": None},
    )
    assert result == {"thinking_config": {"include_thoughts": True, "thinking_budget": 256}}
    only_none = generation_config_kwargs(model, thinking_config={"thinking_level": None})
    assert "thinking_config" not in only_none


@pytest.mark.parametrize("model", SUPPORTED)
def test_supported_model_drops_a_minimal_config_it_cannot_rebuild(model: str) -> None:
    class Unbuildable:
        thinking_level = "MINIMAL"

        def __init__(self, **_: object) -> None:
            raise TypeError("cannot rebuild")

    cfg = Unbuildable.__new__(Unbuildable)
    result = generation_config_kwargs(model, thinking_config=cfg, max_output_tokens=8)
    assert result == {"max_output_tokens": 8}


def test_unsupported_ids_pass_through_unchanged() -> None:
    minimal = genai_types.ThinkingConfig(thinking_level=genai_types.ThinkingLevel.MINIMAL)
    for model in ("gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.1-pro-preview", None):
        result = generation_config_kwargs(
            model,
            temperature=0,
            top_p=0.5,
            top_k=10,
            candidate_count=1,
            max_output_tokens=32,
            thinking_config=minimal,
            response_schema=None,
        )
        assert result == {
            "temperature": 0,
            "top_p": 0.5,
            "top_k": 10,
            "candidate_count": 1,
            "max_output_tokens": 32,
            "thinking_config": minimal,
        }
        assert result["thinking_config"] is minimal


def test_build_generate_content_config_uses_the_contract() -> None:
    for model in SUPPORTED:
        cfg = gemini_config.build_generate_content_config(
            genai_types,
            model,
            temperature=0.2,
            max_output_tokens=16,
            thinking_config=genai_types.ThinkingConfig(
                thinking_level=genai_types.ThinkingLevel.MINIMAL
            ),
        )
        assert isinstance(cfg, genai_types.GenerateContentConfig)
        assert cfg.temperature is None
        assert cfg.max_output_tokens == 16
        assert cfg.thinking_config.thinking_level == genai_types.ThinkingLevel.LOW


@pytest.mark.parametrize("model", SUPPORTED)
def test_thinking_config_for_follows_the_matrix(model: str) -> None:
    assert gemini_config.thinking_config_for(model, None, genai_types) is None
    assert gemini_config.thinking_config_for(model, "  ", genai_types) is None
    for level in ACCEPTED_LEVELS:
        for spelled in (level, level.lower(), level.capitalize()):
            built = gemini_config.thinking_config_for(model, spelled, genai_types)
            assert isinstance(built, genai_types.ThinkingConfig)
            assert built.thinking_level == getattr(genai_types.ThinkingLevel, level)
    coerced = gemini_config.thinking_config_for(model, "minimal", genai_types)
    assert coerced.thinking_level == genai_types.ThinkingLevel.LOW
    with pytest.raises(ValueError, match="unknown thinking_level"):
        gemini_config.thinking_config_for(model, "turbo", genai_types)


def test_thinking_config_for_leaves_other_ids_as_authored() -> None:
    built = gemini_config.thinking_config_for("gemini-3.1-flash-lite", "minimal", genai_types)
    assert built.thinking_level == genai_types.ThinkingLevel.MINIMAL
    assert gemini_config.thinking_config_for("gemini-3.1-flash-lite", None, genai_types) is None


def test_thinking_config_for_works_with_a_duck_typed_types_module() -> None:
    # The ADK factories hand in whichever google.genai types module they hold; the helper
    # must not depend on the enum being present.
    module = SimpleNamespace(ThinkingConfig=lambda **kw: SimpleNamespace(**kw))
    built = gemini_config.thinking_config_for(GEMINI_MODEL, "minimal", module)
    assert built.thinking_level == "LOW"


def test_supported_models_are_text_only_on_global_vertex() -> None:
    for model in SUPPORTED:
        entry = resolve_model_entry("gemini", model)
        assert entry.supports_streaming is True
        assert entry.supports_function_calling is True
        assert entry.supports_native_realtime is False
        assert entry.supported_vertex_locations == ("global",)


def test_gemini_default_resolves_to_a_supported_release() -> None:
    entry = resolve_model_entry("gemini", "default")
    assert entry.model == GEMINI_MODEL
    assert entry.model in SUPPORTED
    assert entry.supported_vertex_locations == ("global",)


def test_managed_binding_filters_unsupported_failover_locations() -> None:
    binding = ManagedGeminiRuntimeBinding(
        project="test-project",
        locations=("global", "us", "eu"),
        auth_mode="vertex_adc",
    )
    for model in SUPPORTED:
        assert binding.locations_for_model(model) == ("global",)


def test_managed_binding_fails_when_global_is_not_configured() -> None:
    binding = ManagedGeminiRuntimeBinding(
        project="test-project",
        locations=("us", "eu"),
        auth_mode="vertex_adc",
    )
    with pytest.raises(RuntimeError, match="no configured supported Vertex location"):
        binding.locations_for_model(GEMINI_MODEL)
