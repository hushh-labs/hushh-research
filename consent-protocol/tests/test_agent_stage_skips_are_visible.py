"""A stage that was never asked must not report as a stage that answered.

Three PKM stages can be routed around entirely: intent, merge and structure.
Each skip site set `*_used_fallback = False` and nothing else, which is the same
thing a SUCCESSFUL model call writes. So `fallback_rate`, the one promotion gate
the live eval has, read healthy precisely when the intelligence was absent.

That mattered more than it sounds. `_should_skip_structure_agent` routes around
the structure agent for financial_core, for anything requiring confirmation, and
for save_class in {ephemeral, ambiguous} -- and "ambiguous" is exactly where a
model earns its place. A metric blind to that cannot be used to decide whether
the model is worth calling at all.

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
