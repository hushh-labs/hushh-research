"""Consent-first guardrail tests for Kai voice agent system prompts.

These tests validate that the voice agent's system prompts enforce the
consent-first architecture, prevent hallucination of capabilities or data,
maintain brand-aligned persona, and include proper refusal mechanisms for
out-of-scope requests.

This suite tests the *prompt text* — not LLM behavior — to ensure the
contract between the backend and the upstream model always includes the
security and consent constraints required by the Hushh product.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

if "asyncpg" not in sys.modules:
    asyncpg_stub = types.ModuleType("asyncpg")

    class _Pool:  # pragma: no cover - import-time stub only
        pass

    asyncpg_stub.Pool = _Pool
    sys.modules["asyncpg"] = asyncpg_stub

if "db" not in sys.modules:
    db_pkg = types.ModuleType("db")
    db_pkg.__path__ = []
    sys.modules["db"] = db_pkg

if "db.db_client" not in sys.modules:
    db_client_stub = types.ModuleType("db.db_client")

    def _noop_get_db():  # pragma: no cover - import-time stub only
        raise RuntimeError("db not available in unit test")

    db_client_stub.get_db = _noop_get_db
    sys.modules["db.db_client"] = db_client_stub

ROOT = Path(__file__).resolve().parents[1]
if "hushh_mcp.services" not in sys.modules:
    services_pkg = types.ModuleType("hushh_mcp.services")
    services_pkg.__path__ = [str(ROOT / "hushh_mcp" / "services")]
    sys.modules["hushh_mcp.services"] = services_pkg

from hushh_mcp.services.voice_app_knowledge import (  # noqa: E402
    get_kai_voice_identity_context,
)
from hushh_mcp.services.voice_prompt_builder import (  # noqa: E402
    build_voice_planner_context,
    build_voice_planner_system_prompt,
    build_voice_response_composer_context,
    build_voice_response_composer_system_prompt,
)


def _runtime_state() -> dict:
    return {
        "analysis_active": False,
        "analysis_ticker": None,
        "analysis_run_id": None,
        "import_active": False,
        "import_run_id": None,
        "busy_operations": [],
    }


def _planner_prompt() -> str:
    planner_context = build_voice_planner_context(
        transcript="open dashboard",
        runtime_state=_runtime_state(),
        context_payload={
            "structured_screen_context": {
                "route": {"pathname": "/kai", "screen": "kai_home"},
                "surface": {"screen_id": "kai_home"},
            }
        },
    )
    return build_voice_planner_system_prompt(planner_context=planner_context)


def _composer_prompt() -> str:
    composer_context = build_voice_response_composer_context(
        transcript="open dashboard",
        runtime_state=_runtime_state(),
        context_payload={
            "structured_screen_context": {
                "route": {"pathname": "/kai", "screen": "kai_home"},
                "surface": {"screen_id": "kai_home"},
            }
        },
        plan_payload={
            "mode": "execute_and_wait",
            "action_id": "nav.kai_dashboard",
            "slots": {},
            "guards": [],
            "reply_strategy": "llm",
        },
        response_payload={
            "kind": "execute",
            "message": "Opening dashboard.",
            "execution_allowed": True,
        },
        action_result={
            "status": "succeeded",
            "action_id": "nav.kai_dashboard",
            "route_after": "/kai/portfolio",
            "screen_after": "dashboard",
            "result_summary": "Opened portfolio dashboard.",
        },
    )
    return build_voice_response_composer_system_prompt(composer_context=composer_context)


# ---------------------------------------------------------------------------
# 1. Structural integrity — required sections present in both prompts
# ---------------------------------------------------------------------------


def test_planner_prompt_includes_consent_first_rules_section():
    prompt = _planner_prompt()
    assert "Consent-First Rules" in prompt


def test_planner_prompt_includes_tone_and_voice_section():
    prompt = _planner_prompt()
    assert "Tone & Voice" in prompt


def test_planner_prompt_includes_out_of_scope_section():
    prompt = _planner_prompt()
    assert "Out-of-Scope Behaviors" in prompt


def test_composer_prompt_includes_consent_first_rules_section():
    prompt = _composer_prompt()
    assert "Consent-First Rules" in prompt


def test_composer_prompt_includes_tone_and_voice_section():
    prompt = _composer_prompt()
    assert "Tone & Voice" in prompt


def test_composer_prompt_includes_refusal_protocol_section():
    prompt = _composer_prompt()
    assert "Refusal Protocol" in prompt


# ---------------------------------------------------------------------------
# 2. Consent-first language — consent philosophy appears in generated prompts
# ---------------------------------------------------------------------------


def test_planner_prompt_includes_consent_philosophy_text():
    prompt = _planner_prompt()
    assert "consent-first" in prompt.lower()
    assert "VAULT_OWNER" in prompt


def test_composer_prompt_includes_consent_philosophy_text():
    prompt = _composer_prompt()
    assert "consent-first" in prompt.lower()
    assert "VAULT_OWNER" in prompt


# ---------------------------------------------------------------------------
# 3. Refusal invariants — out-of-scope behaviors defined in identity context
# ---------------------------------------------------------------------------


def test_identity_context_defines_out_of_scope_behaviors():
    identity = get_kai_voice_identity_context()
    out_of_scope = identity.get("out_of_scope_behaviors")
    assert isinstance(out_of_scope, list)
    assert len(out_of_scope) >= 4

    combined = " ".join(out_of_scope).lower()
    assert "destructive" in combined
    assert "financial advice" in combined
    assert "consent" in combined or "external" in combined


def test_planner_prompt_includes_out_of_scope_data_sharing():
    prompt = _planner_prompt()
    lowered = prompt.lower()
    assert "share" in lowered or "export" in lowered or "transmit" in lowered


def test_composer_refusal_protocol_covers_data_sharing():
    prompt = _composer_prompt()
    lowered = prompt.lower()
    assert "consent center" in lowered or "consent for data sharing" in lowered


def test_composer_refusal_protocol_covers_financial_advice():
    prompt = _composer_prompt()
    lowered = prompt.lower()
    assert "financial advice" in lowered


def test_composer_refusal_protocol_covers_other_users():
    prompt = _composer_prompt()
    lowered = prompt.lower()
    assert "other users" in lowered or "external accounts" in lowered


# ---------------------------------------------------------------------------
# 4. Grounding constraints — "never invent" / "never claim" language present
# ---------------------------------------------------------------------------


def test_planner_prompt_forbids_fabricating_data():
    prompt = _planner_prompt()
    lowered = prompt.lower()
    assert "never fabricate" in lowered or "never claim access" in lowered


def test_composer_prompt_forbids_fabricating_data():
    prompt = _composer_prompt()
    lowered = prompt.lower()
    assert "never fabricate" in lowered


def test_planner_prompt_forbids_server_side_references():
    prompt = _planner_prompt()
    lowered = prompt.lower()
    assert "server-side" in lowered or "raw api" in lowered


def test_composer_prompt_forbids_server_side_references():
    prompt = _composer_prompt()
    lowered = prompt.lower()
    assert "server-side" in lowered or "raw api" in lowered


# ---------------------------------------------------------------------------
# 5. Tone guidelines — TTS-specific rules appear in prompts
# ---------------------------------------------------------------------------


def test_planner_prompt_includes_tts_tone_rules():
    prompt = _planner_prompt()
    lowered = prompt.lower()
    assert "concise" in lowered or "filler" in lowered


def test_composer_prompt_includes_tts_tone_rules():
    prompt = _composer_prompt()
    lowered = prompt.lower()
    assert "concise" in lowered


def test_identity_tone_guidelines_are_populated():
    identity = get_kai_voice_identity_context()
    tone = identity.get("tone_guidelines")
    assert isinstance(tone, list)
    assert len(tone) >= 3


# ---------------------------------------------------------------------------
# 6. Identity consistency — consent philosophy is populated and non-empty
# ---------------------------------------------------------------------------


def test_identity_consent_philosophy_is_populated():
    identity = get_kai_voice_identity_context()
    philosophy = identity.get("consent_philosophy")
    assert isinstance(philosophy, str)
    assert len(philosophy) > 50  # Substantive, not a placeholder
    assert "VAULT_OWNER" in philosophy


def test_identity_guardrails_include_consent_entries():
    identity = get_kai_voice_identity_context()
    guardrails = identity.get("guardrails")
    assert isinstance(guardrails, list)
    assert len(guardrails) >= 6  # Expanded from original 3

    combined = " ".join(guardrails).lower()
    assert "never claim access" in combined
    assert "share" in combined or "export" in combined or "transmit" in combined
    assert "financial advice" in combined


# ---------------------------------------------------------------------------
# 7. Financial disclaimer — appropriate language for investor context
# ---------------------------------------------------------------------------


def test_planner_prompt_qualifies_financial_data():
    prompt = _planner_prompt()
    lowered = prompt.lower()
    assert "based on available data" in lowered or "financial advice" in lowered


def test_composer_prompt_qualifies_financial_insights():
    prompt = _composer_prompt()
    lowered = prompt.lower()
    assert "based on available data" in lowered


# ---------------------------------------------------------------------------
# 8. Backwards compatibility — existing identity keys unchanged
# ---------------------------------------------------------------------------


def test_identity_preserves_app_name():
    identity = get_kai_voice_identity_context()
    assert identity["app_name"] == "Kai"


def test_identity_preserves_assistant_role():
    identity = get_kai_voice_identity_context()
    assert identity["assistant_role"] == "in_app_voice_interface"


def test_identity_preserves_role_summary_contract():
    identity = get_kai_voice_identity_context()
    assert "Kai is the app" in identity["role_summary"]
    assert "voice" in identity["role_summary"].lower()


def test_identity_preserves_core_capabilities():
    identity = get_kai_voice_identity_context()
    capabilities = identity["core_capabilities"]
    assert len(capabilities) >= 5
    combined = " ".join(capabilities).lower()
    assert "navigate" in combined
    assert "explain" in combined
    assert "pkm" in combined


def test_planner_prompt_still_includes_planning_rules():
    prompt = _planner_prompt()
    assert "Planning Rules" in prompt
    assert "Core Capabilities" in prompt
    assert "Guardrails" in prompt


def test_composer_prompt_still_includes_turn_facts():
    prompt = _composer_prompt()
    assert "Turn Facts" in prompt
    assert "Core Capabilities" in prompt
    assert "Guardrails" in prompt
