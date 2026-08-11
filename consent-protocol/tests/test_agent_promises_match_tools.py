"""An agent must not be instructed to call a tool it does not hold.

The Finance head's authored instruction ordered `perform_fundamental_analysis`,
`perform_sentiment_analysis` and `perform_valuation_analysis` while its tool list
held exactly `ria` and `investor`. Those three functions are real
(`hushh_mcp/agents/kai/tools.py`) but are decorated with `@hushh_tool` and need an
active `HushhContext` carrying `agent.kai.analyze`, which this ADK runtime does not
establish -- so they were never bound. A model ordered to call a tool it does not
have either refuses or reports an analysis that never ran.

This is the same shape as the `/health` roster literal that `agent_tree`'s own
docstring warns about: a hand-maintained claim about what exists, never checked
against the reading.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hushh_mcp.one_adk.agent_tree as agent_tree  # noqa: E402

# Backticked identifiers in an instruction that look like tool calls. Deliberately
# narrow: snake_case only, so prose like `hussh:pkm_context` and file paths do not
# register as tool promises.
_TOOL_MENTION = re.compile(r"`([a-z][a-z0-9_]{3,})`")

# Words that appear in backticks but are state keys, env vars or file paths rather
# than tools. Listed explicitly so a genuine new tool promise cannot hide in here.
_NOT_TOOLS = frozenset(
    {
        "hushh_mcp",
        "agent_ria",
        "agent_investor",
        "context_allowlist",
        "plaintext_telemetry",
        "system_instruction",
    }
)


def _bound_tool_names(agent) -> set[str]:
    names: set[str] = set()
    for tool in agent.tools or ():
        name = getattr(tool, "name", None)
        if not name or name == "function":
            inner = getattr(tool, "agent", None)
            name = getattr(inner, "name", None)
        if not name:
            func = getattr(tool, "func", None) or getattr(tool, "_func", None)
            name = getattr(func, "__name__", None)
        if name:
            names.add(str(name))
    for sub in agent.sub_agents or ():
        names.add(str(sub.name))
    return names


def _finance_agent(monkeypatch):
    """Build the real Finance head without needing Vertex ADC in the sandbox."""
    monkeypatch.setattr(agent_tree, "build_managed_gemini_adk_model", lambda *a, **k: "stub")
    return agent_tree._build_finance_agent()


def test_the_finance_head_is_not_told_to_call_tools_it_does_not_hold(monkeypatch) -> None:
    finance = _finance_agent(monkeypatch)
    bound = _bound_tool_names(finance)
    assert bound, "the Finance head holds no tools at all — the probe is broken"

    instruction = str(agent_tree._KAI_MANIFEST.system_instruction)
    promised = {
        name
        for name in _TOOL_MENTION.findall(instruction)
        if name not in _NOT_TOOLS and not name.startswith("agent_")
    }
    phantom = sorted(promised - bound)
    assert phantom == [], (
        f"the Finance instruction orders tools it does not hold: {phantom}. "
        f"Bound: {sorted(bound)}. Either bind them or stop naming them."
    )


def test_the_analysis_tools_are_still_unbound_and_the_instruction_says_why(
    monkeypatch,
) -> None:
    """Pins the honest state rather than pretending the capability exists.

    If someone later binds them properly (with a HushhContext), this test fails and
    the instruction should be rewritten to order them again — which is the correct
    prompt to change, at the correct moment.
    """
    bound = _bound_tool_names(_finance_agent(monkeypatch))
    for tool in (
        "perform_fundamental_analysis",
        "perform_sentiment_analysis",
        "perform_valuation_analysis",
    ):
        assert tool not in bound, (
            f"{tool} is now bound — update the Kai instruction to order it again"
        )
    assert "not bound to this agent" in str(agent_tree._KAI_MANIFEST.system_instruction).lower()
