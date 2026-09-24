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
from hushh_mcp.runtime_providers import gemini_config, model_catalog, registry

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
    # There is exactly one name for the fleet text model. GEMINI_MODEL_VERTEX and
    # KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL were aliases of this value and are gone.
    assert not hasattr(constants, "GEMINI_MODEL_VERTEX")
    assert not hasattr(constants, "KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL")


def test_alias_resolves_to_the_switched_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(constants, "GEMINI_MODEL", "gemini-3.8-flash")
    assert gemini_config.resolve_fleet_model_name("gemini-default") == "gemini-3.8-flash"
    assert gemini_config.resolve_fleet_model_name("") == "gemini-3.8-flash"
    assert gemini_config.resolve_fleet_model_name("gemini-3.7-flash") == "gemini-3.7-flash"


def test_three_eight_flash_shares_the_flash_contract_and_has_a_vertex_location() -> None:
    assert gemini_config.is_gemini_flash_v3("gemini-3.8-flash")
    assert gemini_config.is_gemini_38_flash("models/gemini-3.8-flash")
    assert gemini_config.is_gemini_flash_v3("gemini-3.7-flash")
    assert not gemini_config.is_gemini_flash_v3("gemini-embedding-001")
    assert not gemini_config.is_gemini_flash_v3("gemini-3.8-flash-live-preview")
    entry = registry.resolve_model_entry("gemini", "gemini-3.8-flash")
    assert entry.supported_vertex_locations == ("global", "us", "eu")
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
    text_models = module._managed_manifest_models()
    assert "gemini-default" not in text_models
    assert "gemini-3.8-flash" in text_models
    assert all("live" not in model for model in text_models)


def test_registry_holds_exactly_the_last_two_gemini_releases() -> None:
    """Founder rule 2026-09-14: the catalog lists only the last two Gemini releases at all
    times. A roll-forward replaces the oldest, it never adds a third. The embedding model
    is retrieval, not generation, and stays beside them."""
    gemini_rows = [entry for entry in registry._MODELS if entry.provider == "gemini"]
    assert gemini_rows[0].aliases == ("gemini-default", "default")
    assert gemini_rows[0].model == GEMINI_MODEL
    generation_ids = [
        entry.model for entry in gemini_rows[1:] if not entry.supports_native_realtime
    ]
    assert generation_ids == ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-embedding-001"]
    assert model_catalog.FLEET_TEXT_MODEL_CHOICES == ("gemini-3.8-flash", "gemini-3.7-flash")
    assert set(model_catalog._LABELS) == set(model_catalog.FLEET_TEXT_MODEL_CHOICES)
    assert FLEET_TEXT_MODEL_DEFAULT in model_catalog.FLEET_TEXT_MODEL_CHOICES
    for retired in ("gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview"):
        assert not model_catalog.is_selectable_text_model(retired)
        assert (registry.normalize_provider("gemini"), retired) not in registry._MODEL_BY_KEY


def test_no_manifest_pins_a_non_flash_text_model() -> None:
    """Founder directive 2026-09-02: the text fleet runs Flash (3.8, else 3.7) and never a
    Pro preview. Manifests name the alias; only the Live head and the deliberate
    live-preview pins may name a model directly."""
    offenders = []
    for path in sorted(AGENTS.glob("*/agent.yaml")):
        text = path.read_text()
        for match in re.finditer(r"^\s*(?:model|name):\s*(gemini-\S+)\s*$", text, re.M):
            model = match.group(1)
            if model == "gemini-default" or "live" in model:
                continue
            offenders.append(f"{path.parent.name}: {model}")
    assert offenders == [], f"text agents must name gemini-default, not a model: {offenders}"
    assert "gemini-3.1-pro-preview" not in "\n".join(
        p.read_text() for p in AGENTS.glob("*/agent.yaml")
    ), "gemini-3.1-pro-preview is banned from the fleet"
