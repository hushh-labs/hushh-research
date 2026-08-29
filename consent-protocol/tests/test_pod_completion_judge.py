"""The judge can fail, and cannot report a false green.

A completion judge is only worth having if it is capable of saying "no". This
programme's recurring defect is a check that cannot fail, so the judge gets the
same scrutiny it applies: these pin the three ways it could lie, which are
reporting PASS for something it could not evaluate, counting an unfalsifiable
check as evidence, and calling the whole thing finished while work remains.
"""

from __future__ import annotations

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
