"""Strict product-agent manifest invariants."""

from __future__ import annotations

import pathlib
import re
from pathlib import Path

import pytest

from hushh_mcp.constants import GEMINI_MODEL
from hushh_mcp.hushh_adk.manifest import AgentManifestV2, ManifestLoader
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_ROOT = ROOT / "hushh_mcp" / "agents"
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def load(name: str) -> AgentManifestV2:
    return ManifestLoader.load(str(MANIFEST_ROOT / name / "agent.yaml"))


@pytest.mark.parametrize("path", sorted(MANIFEST_ROOT.glob("*/agent.yaml")))
def test_authored_manifest_is_strict_v2(path: Path) -> None:
    manifest = ManifestLoader.load(str(path))
    assert manifest.manifest_version == 2
    assert SEMVER_PATTERN.fullmatch(manifest.version)
    assert manifest.id.startswith("agent_") or manifest.id in {
        "memory_intent",
        "memory_merge",
        "memory_segmentation",
        "pkm_structure",
    }
    assert manifest.name.strip()
    assert manifest.description.strip()
    assert not (set(manifest.required_scopes) & set(manifest.optional_scopes))
    assert manifest.privacy.plaintext_telemetry is False


def test_one_is_the_only_product_head_and_invocation_is_narrow() -> None:
    one = load("one")
    assert one.id == "agent_one"
    assert one.parent is None or one.parent == "agent_one"
    assert one.required_scopes == ["cap.one.invoke"]
    assert "agent_orchestrator" in one.legacy_ids
    assert not (MANIFEST_ROOT / "orchestrator" / "agent.yaml").exists()


def test_core_specialists_have_distinct_ids_and_reserved_authority() -> None:
    manifests = [load(name) for name in ("kai", "nav", "kyc", "location")]
    assert len({manifest.id for manifest in manifests}) == 4
    assert load("kai").required_scopes == ["agent.kai.analyze"]
    assert load("nav").required_scopes == ["agent.nav.review"]
    assert load("kyc").required_scopes == ["agent.kyc.process"]
    assert load("location").required_scopes == ["cap.location.live.share"]


def test_kai_chat_behavior_is_manifest_owned() -> None:
    manifest = load("kai")
    chat = next(child for child in manifest.subagents if child.id == "agent_kai_chat")
    assert chat.runtime.adk_mode == "chat"
    assert "pkm.profile_summary" in chat.privacy.context_allowlist
    assert "insufficient data" in chat.system_instruction


def test_kyc_owns_strict_zero_knowledge_formatter_contract() -> None:
    capabilities = load("kyc").capabilities
    formatter = capabilities["approved_disclosure_formatter"]
    assert capabilities["drafting_contract_owned_by_adk"] is True
    assert capabilities["strict_client_zk_draft_rendering"] is True
    assert formatter["contract_id"] == "agent_kyc.approved_disclosure_formatter.v1"
    assert formatter["strict_client_zk"] is True
    assert formatter["backend_plaintext_allowed"] is False


def test_kyc_llm_genes_are_manifest_owned_single_turn_contracts() -> None:
    manifest = load("kyc")
    genes = {child.id: child for child in manifest.subagents}
    expected = {
        "agent_kyc_route",
        "agent_kyc_redraft",
        "agent_kyc_redraft_full",
        "agent_kyc_extract_and_draft",
    }
    assert expected <= genes.keys()
    for gene_id in expected:
        gene = genes[gene_id]
        assert gene.runtime.adk_mode == "single_turn"
        assert gene.runtime.transport == ["in_process"]
        assert gene.system_instruction.strip()
        assert gene.privacy.plaintext_telemetry is False
        assert gene.performance.max_output_tokens > 0
        assert gene.rollout.rollback.strip()


def test_portfolio_import_extractor_is_manifest_owned_single_turn_contract() -> None:
    manifest = load("portfolio_import")
    genes = {child.id: child for child in manifest.subagents}
    expected = {
        "agent_portfolio_import_extract": 32768,
        "agent_portfolio_import_relevance": 256,
        "agent_portfolio_import_comprehensive": 32768,
    }
    assert set(expected) <= genes.keys()
    for gene_id, output_tokens in expected.items():
        gene = genes[gene_id]
        assert gene.model.name == "gemini-default"
        assert resolve_fleet_model_name(gene.model.name) == GEMINI_MODEL
        assert gene.runtime.adk_mode == "single_turn"
        assert gene.runtime.transport == ["in_process"]
        assert gene.privacy.plaintext_telemetry is False
        assert gene.performance.max_output_tokens == output_tokens
        assert gene.rollout.rollback.strip()


def test_memory_attribute_learner_is_manifest_owned_single_turn_contract() -> None:
    manifest = load("personal_information")
    gene = next(
        child
        for child in manifest.subagents
        if child.id == "agent_personal_information_attribute_learner"
    )
    assert gene.name == "Attribute Learner"
    assert gene.model.name == "gemini-default"
    assert resolve_fleet_model_name(gene.model.name) == GEMINI_MODEL
    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False
    assert gene.performance.max_output_tokens == 2048
    assert gene.rollout.rollback.strip()


def test_location_transcriber_is_manifest_owned_single_turn_contract() -> None:
    manifest = load("location")
    gene = next(child for child in manifest.subagents if child.id == "agent_location_transcriber")
    assert gene.name == "Location Transcriber"
    assert gene.model.name == "gemini-default"
    assert resolve_fleet_model_name(gene.model.name) == GEMINI_MODEL
    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False
    assert "location.voice.recording" in gene.privacy.context_allowlist
    assert gene.performance.max_output_tokens == 2048
    assert gene.rollout.rollback.strip()


def test_ria_brochure_reader_is_manifest_owned_single_turn_contract() -> None:
    manifest = load("kai")
    gene = next(child for child in manifest.subagents if child.id == "agent_ria_brochure")
    assert gene.name == "RIA Brochure Reader"
    assert gene.model.name == "gemini-default"
    assert resolve_fleet_model_name(gene.model.name) == GEMINI_MODEL
    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False
    assert "ria.brochure.text" in gene.privacy.context_allowlist
    assert gene.performance.max_output_tokens == 2048
    assert gene.rollout.rollback.strip()


def test_kai_portfolio_optimizer_is_manifest_owned_single_turn_contract() -> None:
    manifest = load("kai")
    gene = next(
        child for child in manifest.subagents if child.id == "agent_kai_portfolio_optimizer"
    )
    assert gene.name == "Portfolio Optimizer"
    assert gene.model.name == "gemini-default"
    assert resolve_fleet_model_name(gene.model.name) == GEMINI_MODEL
    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False
    assert "hussh:pkm_context" in gene.privacy.context_allowlist
    assert gene.performance.max_output_tokens == 4096
    assert gene.rollout.rollback.strip()


def test_connected_systems_schema_mapper_is_manifest_owned_and_toolless() -> None:
    manifest = load("connected_systems")
    mapper = next(child for child in manifest.subagents if child.id == "crm_schema_mapper")
    assert mapper.model.name == "gemini-default"
    assert resolve_fleet_model_name(mapper.model.name) == GEMINI_MODEL
    assert mapper.runtime.adk_mode == "single_turn"
    assert mapper.runtime.transport == ["in_process"]
    assert mapper.privacy.plaintext_telemetry is False
    assert mapper.rollout.kill_switch == "CONNECTED_SYSTEMS_SCHEMA_MAPPER_ENABLED"
    assert "credential" in mapper.system_instruction.lower()
    assert "record" in mapper.system_instruction.lower()


def test_gemini_model_matrix_uses_current_workload_equivalents() -> None:
    agentic_manifests = (
        "connections",
        "connected_systems",
        "email",
        "financial_guard",
        "kai",
        "kyc",
        "location",
        "memory_merge",
        "nav",
        "onboarding",
        "personal_information",
        "pkm_structure",
        "portfolio_import",
    )
    for name in agentic_manifests:
        assert load(name).model_config_for_runtime().name == GEMINI_MODEL, name

    # Founder directive 2026-09-02: every text agent runs the switched Flash model. The
    # reducer and the memory chain's salience workers no longer carry their own pins
    # (gemini-3.1-flash-lite and gemini-3.1-pro-preview), so one switch moves the fleet.
    for name in ("memory_intent", "memory_segmentation"):
        assert load(name).model_config_for_runtime().name == GEMINI_MODEL, name
    one = load("one")
    assert one.model_config_for_runtime().name == GEMINI_MODEL
    assert one.capabilities["heads"] == {
        "text": "gemini-default",
        "specialist_text": "gemini-default",
    }


def test_one_command_runtime_has_no_legacy_voice_backends() -> None:
    assert not (ROOT / "api" / "routes" / "kai" / "agent_voice.py").exists()
    assert not (ROOT / "hushh_mcp" / "services" / "agent_voice_service.py").exists()
    kai_routes = (ROOT / "api" / "routes" / "kai" / "__init__.py").read_text()
    assert "/agent/voice/stt" not in kai_routes
    assert "/agent/voice/tts" not in kai_routes


def test_every_declared_kill_switch_is_actually_read_in_code() -> None:
    """A kill switch nobody reads is worse than none.

    It advertises a control an operator would reach for during an incident and find
    inert. Three were declared and unread (CALENDAR_AGENT_DISABLED,
    HUSHH_INVESTOR_AGENT_DISABLED, HUSHH_RIA_AGENT_DISABLED) before the field was made
    optional on 2026-09-02; declare one only when the runtime honours it.
    """
    protocol_root = pathlib.Path(__file__).resolve().parents[1]
    searchable: list[str] = []
    for directory in ("hushh_mcp", "api"):
        for path in (protocol_root / directory).rglob("*.py"):
            searchable.append(path.read_text(encoding="utf-8"))
    haystack = "\n".join(searchable)

    unread: list[str] = []
    for path in sorted((protocol_root / "hushh_mcp" / "agents").glob("*/agent.yaml")):
        for match in re.finditer(r"^\s*kill_switch:\s*([A-Z0-9_]+)\s*$", path.read_text(), re.M):
            switch = match.group(1)
            if switch not in haystack:
                unread.append(f"{path.parent.name}: {switch}")
    assert unread == [], f"declared kill switches that no code reads: {unread}"
