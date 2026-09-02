"""HUSSH_GEMINI_TEXT_MODEL moves every text agent at once; pins that name another family stay put."""

from __future__ import annotations

import importlib
import pathlib
import re

import pytest

from hushh_mcp import constants
from hushh_mcp.runtime_providers import gemini_config, registry

AGENTS = pathlib.Path(__file__).resolve().parents[1] / "hushh_mcp" / "agents"


def test_no_manifest_pins_a_flash_generation() -> None:
    offenders = []
    for path in sorted(AGENTS.glob("*/agent.yaml")):
        if re.search(r"gemini-3\.\d+-flash\b(?!-live|-lite)", path.read_text()):
            offenders.append(path.parent.name)
    assert offenders == [], f"manifests must say gemini-default, not a generation: {offenders}"


def test_switch_moves_the_fleet_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSSH_GEMINI_TEXT_MODEL", "gemini-3.8-flash")
    reloaded = importlib.reload(constants)
    try:
        assert reloaded.GEMINI_MODEL == "gemini-3.8-flash"
        assert reloaded.GEMINI_MODEL_VERTEX == "gemini-3.8-flash"
        assert reloaded.KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL == "gemini-3.8-flash"
    finally:
        monkeypatch.delenv("HUSSH_GEMINI_TEXT_MODEL")
        importlib.reload(constants)
    assert constants.GEMINI_MODEL == constants.FLEET_TEXT_MODEL_DEFAULT


def test_switch_blank_falls_back_to_the_proven_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSSH_GEMINI_TEXT_MODEL", "   ")
    reloaded = importlib.reload(constants)
    try:
        assert reloaded.GEMINI_MODEL == reloaded.FLEET_TEXT_MODEL_DEFAULT
    finally:
        monkeypatch.delenv("HUSSH_GEMINI_TEXT_MODEL")
        importlib.reload(constants)


def test_three_eight_flash_shares_the_flash_contract_and_has_a_vertex_location() -> None:
    assert gemini_config.is_gemini_flash_v3("gemini-3.8-flash")
    assert gemini_config.is_gemini_38_flash("models/gemini-3.8-flash")
    assert not gemini_config.is_gemini_flash_v3("gemini-3.1-flash-lite")
    assert not gemini_config.is_gemini_flash_v3("gemini-3.1-flash-live-preview")
    entry = registry.resolve_model_entry("gemini", "gemini-3.8-flash")
    assert entry.supported_vertex_locations == ("global",)
    assert entry.supports_prompt_caching is True
