"""HUSSH_GEMINI_TEXT_MODEL moves every text agent at once; pins that name another family stay put.

The switch is proven through the pure resolver, never by reloading the constants
module: a reload would mint fresh Enum classes and break every later test that
compares ConsentScope members.
"""

from __future__ import annotations

import pathlib
import re

import pytest

from hushh_mcp import constants
from hushh_mcp.constants import FLEET_TEXT_MODEL_DEFAULT, GEMINI_MODEL, fleet_text_model_from_env
from hushh_mcp.runtime_providers import gemini_config, registry

AGENTS = pathlib.Path(__file__).resolve().parents[1] / "hushh_mcp" / "agents"


def test_no_manifest_pins_a_flash_generation() -> None:
    offenders = []
    for path in sorted(AGENTS.glob("*/agent.yaml")):
        if re.search(r"gemini-3\.\d+-flash\b(?!-live|-lite)", path.read_text()):
            offenders.append(path.parent.name)
    assert offenders == [], f"manifests must say gemini-default, not a generation: {offenders}"


def test_switch_moves_the_fleet_default() -> None:
    assert (
        fleet_text_model_from_env({"HUSSH_GEMINI_TEXT_MODEL": "gemini-3.8-flash"})
        == "gemini-3.8-flash"
    )
    assert (
        fleet_text_model_from_env({"HUSSH_GEMINI_TEXT_MODEL": "  gemini-3.8-flash  "})
        == "gemini-3.8-flash"
    )
    assert fleet_text_model_from_env({}) == FLEET_TEXT_MODEL_DEFAULT
    assert fleet_text_model_from_env({"HUSSH_GEMINI_TEXT_MODEL": "   "}) == FLEET_TEXT_MODEL_DEFAULT
    assert GEMINI_MODEL == fleet_text_model_from_env()
    assert constants.GEMINI_MODEL_VERTEX == GEMINI_MODEL
    assert constants.KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL == GEMINI_MODEL


def test_alias_resolves_to_the_switched_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.8-flash")
    assert gemini_config.resolve_fleet_model_name("gemini-default") == "gemini-3.8-flash"
    assert gemini_config.resolve_fleet_model_name("") == "gemini-3.8-flash"
    assert (
        gemini_config.resolve_fleet_model_name("gemini-3.1-pro-preview") == "gemini-3.1-pro-preview"
    )


def test_three_eight_flash_shares_the_flash_contract_and_has_a_vertex_location() -> None:
    assert gemini_config.is_gemini_flash_v3("gemini-3.8-flash")
    assert gemini_config.is_gemini_38_flash("models/gemini-3.8-flash")
    assert not gemini_config.is_gemini_flash_v3("gemini-3.5-flash")
    assert not gemini_config.is_gemini_flash_v3("gemini-3.1-flash-lite")
    assert not gemini_config.is_gemini_flash_v3("gemini-3.1-flash-live-preview")
    entry = registry.resolve_model_entry("gemini", "gemini-3.8-flash")
    assert entry.supported_vertex_locations == ("global",)
    assert entry.supports_prompt_caching is True


def test_vertex_readiness_probe_never_probes_the_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deploy-time probe collects manifest models; the alias must resolve to the
    switched model before it reaches Vertex (UAT run 33676580380 probed the literal
    "gemini-default" and failed as candidate_misconfigured)."""
    import importlib.util

    script = (
        pathlib.Path(__file__).resolve().parents[1] / "scripts" / "verify_managed_vertex_runtime.py"
    )
    spec = importlib.util.spec_from_file_location("verify_managed_vertex_runtime", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.8-flash")
    text_models, live_model = module._managed_manifest_models()
    assert "gemini-default" not in text_models
    assert "gemini-3.8-flash" in text_models
    assert live_model == "gemini-3.1-flash-live-preview"


def test_31_pro_preview_maps_minimal_thinking_to_low() -> None:
    """Vertex rejects thinking_level MINIMAL for gemini-3.1-pro-preview (400, verified live
    2026-09-02) and accepts LOW; the readiness probe sends MINIMAL for every text model."""
    from google.genai import types

    minimal = gemini_config.build_generate_content_config(
        types,
        "gemini-3.1-pro-preview",
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL),
    )
    assert minimal.thinking_config.thinking_level == types.ThinkingLevel.LOW
    high = gemini_config.build_generate_content_config(
        types,
        "gemini-3.1-pro-preview",
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.HIGH),
    )
    assert high.thinking_config.thinking_level == types.ThinkingLevel.HIGH
    as_dict = gemini_config.build_generate_content_config(
        types, "gemini-3.1-pro-preview", thinking_config={"thinking_level": "MINIMAL"}
    )
    assert str(as_dict.thinking_config.thinking_level).upper().endswith("LOW")
    flash = gemini_config.build_generate_content_config(
        types,
        "gemini-3.7-flash",
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL),
    )
    assert flash.thinking_config is None
