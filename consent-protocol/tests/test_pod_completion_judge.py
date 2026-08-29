"""The judge can fail, and cannot report a false green.

A completion judge is only worth having if it is capable of saying "no". This
programme's recurring defect is a check that cannot fail, so the judge gets the
same scrutiny it applies: these pin the three ways it could lie, which are
reporting PASS for something it could not evaluate, counting an unfalsifiable
check as evidence, and calling the whole thing finished while work remains.
"""

from __future__ import annotations

import datetime as _dt
import importlib.util
import sys
from pathlib import Path

import pytest
import yaml

_JUDGE = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_completion_judge.py"
_spec = importlib.util.spec_from_file_location("pod_completion_judge", _JUDGE)
judge_mod = importlib.util.module_from_spec(_spec)
sys.modules["pod_completion_judge"] = judge_mod
_spec.loader.exec_module(judge_mod)  # type: ignore[union-attr]

_LEDGER = Path(__file__).resolve().parents[2] / "config" / "pod-completion-ledger.yaml"


def _item(ident, **over):
    base = {
        "id": ident,
        "requirement": "Test",
        "statement": f"{ident} holds",
        "falsifiable": True,
        "check": {"kind": "command", "command": "true"},
    }
    base.update(over)
    return base


def test_a_passing_ledger_reports_finished():
    report = judge_mod.judge([_item("a"), _item("b")])
    assert report.finished
    assert len(report.passing) == 2


def test_a_failing_item_makes_the_whole_thing_unfinished():
    """The judge must be able to say no. Without this it is decoration."""
    report = judge_mod.judge(
        [_item("ok"), _item("bad", check={"kind": "command", "command": "false"})]
    )
    assert not report.finished
    assert [v.id for v in report.failing] == ["bad"]


def test_something_it_could_not_evaluate_is_UNKNOWN_never_PASS():
    """The most dangerous lie available to a judge: answering green because it
    did not look. A missing tool is 'we could not check', not 'it is fine'."""
    report = judge_mod.judge(
        [
            _item(
                "needs-tool",
                check={
                    "kind": "command",
                    "command": "true",
                    "requires": ["a-tool-that-does-not-exist"],
                },
            )
        ]
    )
    assert [v.status for v in report.verdicts] == [judge_mod.UNKNOWN]
    assert not report.passing
    assert not report.finished, "unknown must never count as done"


def test_a_manual_item_is_never_reported_as_passing():
    report = judge_mod.judge([_item("human", check={"kind": "manual", "note": "needs a person"})])
    assert report.verdicts[0].status == judge_mod.UNKNOWN
    assert not report.finished


def test_an_unfalsifiable_check_is_a_defect_not_a_pass():
    """A check that cannot fail proves nothing, so it must not be counted as
    evidence even when it 'passes'."""
    report = judge_mod.judge([_item("hollow", falsifiable=False)])
    assert report.verdicts[0].status == judge_mod.PASS
    assert report.unfalsifiable, "an unfalsifiable item must be surfaced"
    assert not report.finished, "a hollow check must not let the ledger read as finished"


def test_a_blocked_item_is_unknown_rather_than_nagged_as_failing():
    """A judge that nags about the unfixable trains people to ignore it, so an
    item gated on something outside our control is reported, not shouted."""
    report = judge_mod.judge([_item("gated", blocked_by="a founder decision")])
    v = report.verdicts[0]
    assert v.status == judge_mod.UNKNOWN
    assert "founder decision" in v.detail
    assert not report.failing


def test_a_missing_file_makes_a_grep_check_unknown_not_passing():
    report = judge_mod.judge(
        [_item("gone", check={"kind": "grep", "path": "no/such/file.txt", "pattern": "x"})]
    )
    assert report.verdicts[0].status == judge_mod.UNKNOWN


def test_an_empty_ledger_is_not_finished():
    """Zero items all passing is the emptiest possible false green."""
    assert not judge_mod.judge([]).finished


def test_the_report_names_what_is_still_unfinished():
    report = judge_mod.judge(
        [_item("bad", check={"kind": "command", "command": "false"}, owner_action="do the thing")]
    )
    text = judge_mod.render(report)
    assert "DID WE FINISH IT?" in text
    assert "NO." in text
    assert "do the thing" in text


# --------------------------------------------------------------------------- #
# The real ledger has to obey its own rules.
# --------------------------------------------------------------------------- #


def test_the_shipped_ledger_parses_and_every_item_declares_falsifiability():
    data = yaml.safe_load(_LEDGER.read_text(encoding="utf-8"))
    items = data["assertions"]
    assert items, "the ledger is empty"
    for item in items:
        assert item.get("id"), f"an assertion has no id: {item}"
        assert item.get("statement"), f"{item['id']} has no statement"
        assert "falsifiable" in item, f"{item['id']} does not say whether it can fail"
        assert item.get("check", {}).get("kind") in judge_mod.CHECKS, (
            f"{item['id']} has an unrunnable check kind"
        )


def test_every_shipped_assertion_is_falsifiable():
    """If an item cannot fail, it is not tracking anything. Fix the check rather
    than lowering the bar."""
    data = yaml.safe_load(_LEDGER.read_text(encoding="utf-8"))
    hollow = [i["id"] for i in data["assertions"] if not i.get("falsifiable")]
    assert not hollow, f"these assertions cannot fail, so they prove nothing: {hollow}"


def test_ledger_ids_are_unique():
    data = yaml.safe_load(_LEDGER.read_text(encoding="utf-8"))
    ids = [i["id"] for i in data["assertions"]]
    assert len(ids) == len(set(ids)), "duplicate assertion ids make the report ambiguous"


@pytest.mark.parametrize("kind", sorted(judge_mod.CHECKS))
def test_every_check_kind_has_a_runner(kind):
    assert callable(judge_mod.CHECKS[kind])


# --------------------------------------------------------------------------- #
# Controls and void runs, borrowed from the house judging contract
# (.codex/skills/puppy-one-harness/references/judging-contract.md): a void run
# publishes NO result, "not a number with a caveat, because a number with a
# caveat gets quoted without the caveat".
# --------------------------------------------------------------------------- #


def test_the_controls_run_before_any_real_grading():
    """They are worthless as a separate step someone can skip, so they run on
    every invocation."""
    calls = []
    real = judge_mod.run_controls
    judge_mod.run_controls = lambda *a, **k: calls.append("ran")
    try:
        judge_mod.judge([_item("x")])
    finally:
        judge_mod.run_controls = real
    assert calls == ["ran"]


def test_a_grader_that_is_not_reading_voids_the_run(monkeypatch):
    """Negative control passes => the judge is not reading, so nothing it says is
    worth having. It must refuse to publish rather than emit a caveated number."""
    # Patch the CHECKS entry, not the module attribute: the dict captured the
    # original function at import, so rebinding the name would leave the judge
    # calling the real runner and the test would pass for the wrong reason.
    monkeypatch.setitem(
        judge_mod.CHECKS, "command", lambda *_a, **_k: (judge_mod.PASS, "always pass")
    )
    with pytest.raises(judge_mod.VoidRun, match="not reading"):
        judge_mod.run_controls()


def test_a_grader_that_over_flags_voids_the_run(monkeypatch):
    """Positive control fails => its complaints are noise nobody can act on."""
    monkeypatch.setitem(
        judge_mod.CHECKS, "command", lambda *_a, **_k: (judge_mod.FAIL, "always fail")
    )
    with pytest.raises(judge_mod.VoidRun, match="over-flags"):
        judge_mod.run_controls()


def test_controls_pass_against_the_real_runners():
    """The controls themselves must hold on the shipped implementation, or every
    run is void and the judge is useless."""
    judge_mod.run_controls()


# --------------------------------------------------------------------------- #
# Receipts. The half of the design that lets the judge ever say YES, and the
# half most likely to rot back into a hand-typed verdict if nothing pins it.
# --------------------------------------------------------------------------- #


def _receipt(**over):
    check = {
        "kind": "receipt",
        "verified_on": _dt.date.today().isoformat(),
        "expires_after_days": 30,
        "reproduce": "config/pod-completion-ledger.yaml",  # any tracked path
    }
    check.update(over)
    return _item("r", check=check)


def test_a_fresh_receipt_passes():
    report = judge_mod.judge([_receipt()])
    assert report.finished
    assert "fresh until" in report.passing[0].detail


def test_a_stale_receipt_fails_rather_than_going_unknown():
    """A proof with an expiry is the whole point. If it decayed to UNKNOWN the
    judge would report 'we could not look' for something anyone can re-run, and
    'run it again' is actionable in a way that a blind spot is not."""
    old = (_dt.date.today() - _dt.timedelta(days=31)).isoformat()
    report = judge_mod.judge([_receipt(verified_on=old, expires_after_days=30)])
    assert [v.status for v in report.verdicts] == [judge_mod.FAIL]
    assert "re-run" in report.verdicts[0].detail


def test_a_receipt_whose_reproduction_path_is_not_in_the_tree_fails():
    """The failure this check was written for: two receipts once pointed at
    scratchpad scripts that no clone contained, so the 'proof' was a sentence
    nobody else could re-run. That is a claim, not evidence."""
    report = judge_mod.judge([_receipt(reproduce="scratchpad/prove_identity.py")])
    assert report.verdicts[0].status == judge_mod.FAIL
    assert "is not in the tree" in report.verdicts[0].detail


def test_a_receipt_that_was_never_earned_fails_and_says_what_is_pending():
    report = judge_mod.judge([_receipt(verified_on=None, pending="nobody has run the driver yet")])
    assert report.verdicts[0].status == judge_mod.FAIL
    assert "nobody has run the driver yet" in report.verdicts[0].detail


def test_a_malformed_receipt_date_fails_instead_of_passing():
    report = judge_mod.judge([_receipt(verified_on="last tuesday")])
    assert report.verdicts[0].status == judge_mod.FAIL


def test_every_shipped_receipt_points_at_a_path_that_exists():
    """Guards the shipped ledger, not just the runner. A receipt is only worth
    the reproduction somebody else can run."""
    items = yaml.safe_load(_LEDGER.read_text())["assertions"]
    repo = _LEDGER.resolve().parents[1]
    missing = [
        (i["id"], i["check"].get("reproduce"))
        for i in items
        if i.get("check", {}).get("kind") == "receipt"
        and not (repo / str(i["check"].get("reproduce") or "")).exists()
    ]
    assert not missing, f"receipts pointing at paths no clone has: {missing}"


def test_the_shipped_ledger_can_still_reach_yes():
    """The fatal flaw this replaced: every remaining unknown must be something a
    person can act on, not a check kind that is UNKNOWN by construction. An item
    that is permanently `manual` makes the nag red forever, which is how a nag
    becomes furniture nobody reads."""
    items = yaml.safe_load(_LEDGER.read_text())["assertions"]
    permanent = [
        i["id"]
        for i in items
        if i.get("check", {}).get("kind") == "manual" and not i.get("blocked_by")
    ]
    assert not permanent, f"these items can never pass, so the judge can never say YES: {permanent}"
