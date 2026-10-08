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
    result = harness.score_cases(
        [case], probe, empty, reps=1, instruction_overrides={case.id: admitted}
    )
    assert result[0].hit and calls == [admitted]
    # Selecting an evaluation context must not mutate the neutral context.
    assert harness.production_instruction() == empty
