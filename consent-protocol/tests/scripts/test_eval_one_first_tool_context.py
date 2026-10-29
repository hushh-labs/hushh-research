"""Prove evaluation admission before probing, without owner authority or model calls."""

import pytest

from scripts import eval_one_first_tool as harness


def test_mail_selection_requires_declared_synthetic_chat_context():
    case = next(
        case for case in harness.load_cases() if case.id == "delegation.read_recent_mail_v2"
    )
    calls = []

    def probe(instruction, prompt, screen):
        calls.append(instruction)
        return "ask_email_agent"

    empty = harness.production_instruction()
    with pytest.raises(ValueError, match="forbidden by its runtime context"):
        harness.score_cases([case], probe, empty, reps=1)
    assert calls == []

    admitted = harness.production_instruction(case.runtime_context)
    assert "MAIL READ ADMISSION: enabled for this typed chat." in admitted
    assert "recipient_names and cc_names are unavailable" not in admitted  # shipping client
    result = harness.score_cases(
        [case], probe, empty, reps=1, instruction_overrides={case.id: admitted}
    )
    assert result[0].hit and calls == [admitted]
    # Selecting an evaluation context must not mutate the neutral context.
    assert harness.production_instruction() == empty


def test_device_receipt_tools_reach_only_typed_chat_rosters():
    # Showing them on every surface scored a paused-inbox answer as a receipt call.
    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES

    declarations = harness.build_roster_declarations()
    assert RECEIPT_TOOL_NAMES <= {item.name for item in declarations}
    typed = harness.production_instruction("typed_chat")
    typed_names = {item.name for item in harness.surface_declarations(declarations, typed)}
    assert RECEIPT_TOOL_NAMES <= typed_names
    empty = harness.surface_declarations(declarations, harness.production_instruction())
    assert not RECEIPT_TOOL_NAMES & {item.name for item in empty}
    assert len(empty) == len(declarations) - len(RECEIPT_TOOL_NAMES)
