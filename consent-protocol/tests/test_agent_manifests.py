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


def test_one_chat_keeps_tool_progress_in_activity_cards() -> None:
    instruction = load("one").system_instruction
    assert "Do not repeat that plumbing as transcript prose" in instruction
    assert "Available information" in instruction
    assert "Do not announce a profile" in instruction


def test_one_requires_a_fresh_calendar_read_for_live_schedule_answers() -> None:
    """A confirmed reschedule must not be overwritten by earlier chat prose."""
    instruction = load("one").system_instruction
    assert "Schedule questions are live state" in instruction
    assert "Calendar read tool this turn" in instruction
    assert "historical context, never proof of the current schedule" in instruction
    assert "never use an earlier schedule answer" in instruction


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


@pytest.mark.parametrize("path", sorted(MANIFEST_ROOT.glob("*/agent.yaml")))
def test_single_turn_genes_leave_room_for_thinking(path: Path) -> None:
    """Thinking tokens count against max_output_tokens on the fleet model.

    A gene with provider-default thinking and a small cap can spend the whole
    budget thinking and return truncated prose instead of JSON: measured
    2026-09-24 (64-token cap -> 60 thinking tokens, empty answer), seen on UAT
    as receipt_memory "single-turn agent returned invalid JSON", and in every
    live Drive planner turn at 150 tokens. Bound the thinking or keep headroom.
    """
    manifest = ManifestLoader.load(str(path))
    genes = [manifest, *(manifest.subagents or [])]
    for gene in genes:
        if getattr(gene.runtime, "adk_mode", None) != "single_turn":
            continue
        model = gene.model
        thinking = None if isinstance(model, str) else getattr(model, "thinking_level", None)
        budget = gene.performance.max_output_tokens
        assert thinking is not None or budget >= 4096, (
            f"{gene.id}: set model.thinking_level or give max_output_tokens >= 4096 (is {budget})"
        )
        assert budget >= 2048 or thinking == "low", f"{gene.id}: {budget} tokens is too tight"


def test_structure_agent_is_told_the_finance_hierarchy_and_its_source_managed_branches() -> None:
    """The instruction and the reserved-branch registry must agree about Finance.

    The registry reserves every Finance branch but agent_memory for the Finance
    app; the instruction must send chat facts there, never into the hierarchy.
    """
    from hushh_mcp.consent.reserved_branches import is_reserved_path
    from hushh_mcp.services.domain_contracts import FINANCIAL_SOURCE_MANAGED_BRANCHES

    instruction = load("pkm_structure").system_instruction
    assert "Finance hierarchy" in instruction
    for branch in ("profile", "goals", "events", "linked_accounts"):
        assert f"- {branch}:" in instruction
        assert is_reserved_path("financial", branch), branch
    assert "goes under agent_memory" in instruction
    assert not is_reserved_path("financial", "agent_memory")
    assert "reserved_offer" in instruction
    for branch in FINANCIAL_SOURCE_MANAGED_BRANCHES:
        named = branch in instruction or (branch.endswith("_v1") and "ending in _v1" in instruction)
        assert named, branch
        assert is_reserved_path("financial", branch), branch


# The PKM memory agents' model-facing budget, in characters: the composed
# system instruction (shared kernel included), the worked examples, and the
# request scaffold with an empty input. Owner input is excluded because it is
# the owner's, not the instruction's. Measured 2026-10-02 at about nine tenths
# of each cap. The intent prompt had grown to 20,357 characters, carrying its
# instruction twice. Raising a cap is a deliberate edit to this table, made
# with the live eval result that justifies it, never a side effect.
PKM_MEMORY_PROMPT_BUDGET = {
    "agent_memory_segmentation": 5_400,
    "agent_memory_intent": 9_400,
    "agent_memory_merge": 7_300,
    "agent_pkm_structure": 14_200,
}
PKM_MEMORY_KERNEL = MANIFEST_ROOT / "pkm_memory_kernel.v3.md"
PKM_FEW_SHOT = MANIFEST_ROOT / "pkm_memory_few_shot.v1.json"
PKM_FEW_SHOT_MAX_PER_AGENT = 6


def _pkm_memory_prompts() -> dict[str, tuple[str, str]]:
    from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService

    service = PKMAgentLabService()
    common = dict(message="", current_domains=[], simulated_state=None, strict_small_model=False)
    built = [
        (
            service.memory_segmentation_manifest,
            service._build_memory_segmentation_prompt(message="", strict_small_model=False),
        ),
        (
            service.memory_intent_manifest,
            service._build_memory_intent_prompt(**common, registry_choices=[]),
        ),
        (
            service.memory_merge_manifest,
            service._build_memory_merge_prompt(**common, intent_frame={}),
        ),
        (
            service.structure_manifest,
            service._build_structure_prompt(
                **common, registry_choices=[], intent_frame={}, merge_decision={}
            ),
        ),
    ]
    return {manifest.id: (manifest.system_instruction, prompt) for manifest, prompt in built}


@pytest.mark.parametrize("agent_id", sorted(PKM_MEMORY_PROMPT_BUDGET))
def test_pkm_memory_agent_stays_inside_its_prompt_budget(agent_id: str) -> None:
    instruction, prompt = _pkm_memory_prompts()[agent_id]
    size = len(instruction) + len(prompt)
    assert size <= PKM_MEMORY_PROMPT_BUDGET[agent_id], (
        f"{agent_id} reads {size} characters, over its {PKM_MEMORY_PROMPT_BUDGET[agent_id]} cap: "
        "state a principle instead of adding a case, or raise the cap with eval evidence"
    )


def test_pkm_memory_kernel_is_composed_once_into_every_memory_agent() -> None:
    kernel = PKM_MEMORY_KERNEL.read_text(encoding="utf-8").strip()
    prompts = _pkm_memory_prompts()
    assert set(prompts) == set(PKM_MEMORY_PROMPT_BUDGET)
    for agent_id, (instruction, prompt) in prompts.items():
        assert instruction.count(kernel) == 1, agent_id
        assert kernel not in prompt, f"{agent_id} restates the kernel in its prompt"
        assert instruction not in prompt, f"{agent_id} sends its instruction twice"


def test_pkm_few_shot_set_is_small_versioned_and_never_the_graded_text() -> None:
    """Each worked example names eval cases grading its principle, never their text.

    An example equal to a graded case would let the eval reward a memorized
    answer; an example naming no existing case is not exercised by anything.
    """

    import json
    from collections import Counter

    from scripts import eval_pkm_structure_agent as eval_script
    from scripts import pkm_eval_document as document_eval

    payload = json.loads(PKM_FEW_SHOT.read_text(encoding="utf-8"))
    assert payload["version"] == 1 and PKM_FEW_SHOT.name.endswith(".v1.json")
    examples = payload["examples"]
    counts = Counter(example["agent"] for example in examples)
    assert set(counts) <= set(PKM_MEMORY_PROMPT_BUDGET)
    assert max(counts.values()) <= PKM_FEW_SHOT_MAX_PER_AGENT
    cases = {}
    for phase in eval_script.PHASE_ORDER:
        if phase == eval_script.DOCUMENT_PHASE:
            continue
        personas, _ = eval_script.build_phase_personas(phase=phase, max_prompts_per_persona=200)
        cases.update({case.case_id: case.message for case in personas[0]["prompts"]})
    sections = {
        passage.section
        for passage in document_eval.parse_document(
            document_eval.DOCUMENT_PATH.read_text(encoding="utf-8")
        )
    }
    graded_text = {message.strip().lower() for message in cases.values()}
    for example in examples:
        assert example["exercised_by"], example["id"]
        for reference in example["exercised_by"]:
            if reference.startswith("document:"):
                assert reference.removeprefix("document:") in sections, reference
            else:
                assert reference in cases, reference
        assert example["input"]["message"].strip().lower() not in graded_text, example["id"]
