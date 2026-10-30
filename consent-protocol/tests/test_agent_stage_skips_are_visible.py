"""A stage that was never asked must not report as a stage that answered.

Three PKM stages can be routed around entirely: intent, merge and structure.
Each skip site set `*_used_fallback = False` and nothing else, which is the same
thing a SUCCESSFUL model call writes. So `fallback_rate`, the one promotion gate
the live eval has, read healthy precisely when the intelligence was absent.

That mattered more than it sounds. `_should_skip_structure_agent` used to route
around the structure agent for anything requiring confirmation and for save_class
in {ephemeral, ambiguous}, so a sensitive fact that needed the owner's OK was filed
by a fallback that clipped it to 240 characters. It now skips only what the intent
agent said is not memory: `no_op`, and a live `command`.

These assertions are about observability, not about whether skipping is correct.
Whether each skip should exist is a separate decision, and it cannot be made
while the measurement lies.
"""

from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService


def flags(**kwargs) -> dict:
    base = {"validation_hints": [], "fallback_used": False}
    base.update(kwargs)
    return PKMAgentLabService._drift_flags_from_preview(**base)  # noqa: SLF001


def test_a_skip_is_reported():
    for stage in ("intent_skipped", "merge_skipped", "structure_skipped"):
        result = flags(**{stage: True})
        assert result[stage] is True, f"{stage} must surface on its own"
        assert result["stage_skipped"] is True


def test_a_skip_is_never_folded_into_fallback_used():
    # The whole defect. If a skip raised fallback_used, it would at least be
    # visible -- but it would then be indistinguishable from a model that
    # answered badly, which is a different problem with a different fix.
    result = flags(structure_skipped=True)
    assert result["stage_skipped"] is True
    assert result["fallback_used"] is False


def test_a_fallback_is_not_reported_as_a_skip():
    # The inverse, so the two can never be conflated in either direction.
    result = flags(structure_used_fallback=True)
    assert result["fallback_used"] is True
    assert result["stage_skipped"] is False


def test_a_clean_run_reports_neither():
    result = flags()
    assert result["fallback_used"] is False
    assert result["stage_skipped"] is False


def test_only_a_no_op_or_a_command_skips_the_structure_agent():
    skip = PKMAgentLabService._should_skip_structure_agent  # noqa: SLF001
    assert skip(intent_frame={"intent_class": "command", "mutation_intent": "no_op"})
    assert skip(intent_frame={"intent_class": "note", "mutation_intent": "no_op"})
    # The loss point: a durable statement that needs the owner's confirmation
    # (pay, a visa, a new domain) used to skip the structure agent entirely.
    assert not skip(
        intent_frame={
            "save_class": "durable",
            "intent_class": "profile_fact",
            "mutation_intent": "create",
            "requires_confirmation": True,
        }
    )


def test_the_fallback_entity_keeps_the_whole_statement():
    # Negative control, the old record: summary[:240] and observations[:500].
    statement = "Compensation: " + " ".join(
        f"component {index} is synthetic" for index in range(40)
    )
    assert len(statement) > 500
    record = PKMAgentLabService._build_entity_record(  # noqa: SLF001
        message=statement,
        intent_frame={"intent_class": "profile_fact"},
        merge_decision={"target_domain": "professional"},
    )
    assert record["summary"] == statement
    assert record["observations"] == [statement]
