"""An ungrounded turn must say so, rather than sound like a grounded one.

`_one_runtime_instruction` injected the owner's projection when it had one and, when
it did not, appended nothing at all -- there was no else-branch. So the prompt for an
ungrounded turn was byte-identical to a grounded one minus that block, while the
always-present persona kept asserting continuity ("hold the relationship... so they
never have to repeat themselves"). The model was told it remembers and never told that
this particular turn carries nothing, and answered accordingly.

Pod turns hit this hardest: `pod_turn.py` passes `pkm_context=None` on every turn.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.one_adk.agent_tree import (  # noqa: E402
    STATE_GROUNDING_REASON,
    STATE_PKM_CONTEXT,
    _one_runtime_instruction,
)

_ABSENCE_MARKER = "NO OWNER INFORMATION"
_PRESENCE_MARKER = "CONSENTED TURN INFORMATION"


class _Ctx:
    """The ReadonlyContext shape the instruction provider actually reads."""

    def __init__(self, state: dict) -> None:
        self.state = state


def test_a_grounded_turn_is_unchanged() -> None:
    """The whole point is to add a statement of absence, not to alter presence."""
    out = _one_runtime_instruction(_Ctx({STATE_PKM_CONTEXT: "Owner prefers concise summaries."}))
    assert _PRESENCE_MARKER in out
    assert "Owner prefers concise summaries." in out
    assert _ABSENCE_MARKER not in out


def test_an_ungrounded_turn_says_it_has_nothing() -> None:
    out = _one_runtime_instruction(_Ctx({STATE_PKM_CONTEXT: ""}))
    assert _ABSENCE_MARKER in out
    assert _PRESENCE_MARKER not in out
    # It must forbid the specific failure, not merely note the absence: the persona
    # is still telling the model it remembers this person.
    assert "Do not imply you remember them" in out


def test_the_statement_carries_the_reason_when_one_is_known() -> None:
    """`resolve_grounding` computes a reason for every branch and the route used to
    drop it. "No records stored yet" and "your vault is locked" are different answers."""
    out = _one_runtime_instruction(
        _Ctx(
            {
                STATE_PKM_CONTEXT: "",
                STATE_GROUNDING_REASON: "pod holds no records for this owner yet",
            }
        )
    )
    assert "pod holds no records for this owner yet" in out


def test_a_missing_reason_still_states_the_absence() -> None:
    """A pod turn passes pkm_context=None with no reason attached. The generic
    statement is still far better than silence, so it must not depend on the reason."""
    out = _one_runtime_instruction(_Ctx({STATE_PKM_CONTEXT: ""}))
    assert _ABSENCE_MARKER in out
    assert "()" not in out, "an absent reason must not render as empty parentheses"


def test_absence_is_stated_on_every_return_path() -> None:
    """`_one_runtime_instruction` returns from several branches depending on voice
    context. The grounding statement is concatenated once and must reach all of them —
    a branch that returns early without it is silently ungrounded again."""
    for voice_context in (
        None,
        {},
        {"route_family": "/one", "available_action_ids": ["one.open"]},
    ):
        state = {STATE_PKM_CONTEXT: ""}
        if voice_context is not None:
            state["hussh:voice_context"] = voice_context
        assert _ABSENCE_MARKER in _one_runtime_instruction(_Ctx(state))


def test_the_reason_is_bounded() -> None:
    """It reaches the model prompt, so it is length-capped like every other injection."""
    out = _one_runtime_instruction(
        _Ctx({STATE_PKM_CONTEXT: "", STATE_GROUNDING_REASON: "x" * 5000})
    )
    assert "x" * 201 not in out
