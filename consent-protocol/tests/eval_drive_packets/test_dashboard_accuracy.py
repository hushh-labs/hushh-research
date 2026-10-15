"""Accuracy math on fixed fixtures: AI claim, the founder's labels, and agreement.

Packets: eval judges' final verdicts vs. the founder's Correct / Wrong labels.
Requests: precision of selected documents, misses (recall proxy) and agreement.
Bars are the eval's exact zero-failure sizes. Synthetic values only.
"""

import pytest

from hushh_eval.drive_packets.contracts import JudgmentRow
from hushh_eval.drive_packets.dashboard.accuracy import (
    bars,
    document_claims,
    packet_accuracy,
    request_accuracy,
)
from hushh_eval.drive_packets.dashboard.eval_view import batch_view, final_verdicts, human_queue
from hushh_eval.drive_packets.dashboard.queries import ai_verdict

from ._dashboard_fakes import write_batch


def test_bars_are_the_eval_exact_zero_failure_sizes():
    assert bars() == {"n95": 59, "n999": 2995}


def test_packet_accuracy_counts_both_sides_and_lists_disagreements():
    eval_ready = [
        {"batch": "B001", "packet_key": "a", "ai": "pass"},
        {"batch": "B001", "packet_key": "b", "ai": "pass"},
        {"batch": "B002", "packet_key": "c", "ai": "pass"},
        {"batch": "B002", "packet_key": "d", "ai": "fail"},
        {"batch": "B002", "packet_key": "e", "ai": "unknown"},
    ]
    human = {
        "p1": {"verdict": "correct"},
        "p2": {"verdict": "wrong"},
        "p3": {"verdict": "unsure"},
        "p4": {"verdict": "correct"},
    }
    served_ai = {"p1": "correct", "p2": "correct", "p3": "wrong", "p4": None, "p5": "undecided"}
    result = packet_accuracy(eval_ready, human, served_ai)
    ai = result["ai"]
    assert (ai["correct"], ai["wrong"], ai["undecided"], ai["n"]) == (3, 1, 1, 5)
    assert ai["by_batch"]["B002"] == {"correct": 1, "wrong": 1, "undecided": 1, "n": 3}
    assert ai["lower_bound_95"] == pytest.approx(0.2486, abs=1e-3)  # exact CP, 3 of 4
    mine = result["human"]
    assert (mine["correct"], mine["wrong"], mine["unsure"], mine["n"]) == (2, 1, 1, 4)
    agreement = result["agreement"]
    assert (agreement["both"], agreement["agree"], agreement["disagree"]) == (2, 1, 1)
    assert agreement["disagreements"] == [{"packet_id": "p2", "ai": "correct", "human": "wrong"}]
    assert agreement["served_packets_with_ai_verdict"] == 4
    assert result["bars"] == {"n95": 59, "n999": 2995}


def test_packet_accuracy_with_nothing_judged_reports_zero_samples():
    result = packet_accuracy([], {}, {})
    assert result["ai"]["n"] == 0 and result["ai"]["lower_bound_95"] is None
    assert result["human"]["n"] == 0 and result["agreement"]["both"] == 0


def test_request_precision_counts_selected_documents_and_misses():
    documents = [
        {
            "document_id": "d1",
            "selected": True,
            "period_start": "2026-09-01",
            "period_end": "2026-09-30",
            "period_role": "content_period",
        },
        {"document_id": "d2", "selected": True, "period_start": None, "period_end": None},
        {"document_id": "d3", "selected": False},
        {"document_id": "d4", "selected": False},
        {
            "document_id": "d5",
            "selected": True,
            "period_start": "2026-01-01",
            "period_end": "2026-01-31",
            "flags": ["selected_without_content_dates"],
        },
    ]
    labels = {
        None: {"verdict": "right"},
        "d1": {"verdict": "right"},
        "d2": {"verdict": "wrong"},
        "d3": {"verdict": "missed"},
        "d4": {"verdict": "right"},
        "d5": {"verdict": "unsure"},
        "not-listed": {"verdict": "missed"},
    }
    result = request_accuracy([("ask-1", documents, labels)], [])
    dry = result["by_source"]["dry_run"]
    assert dry["system_selected"] == 3 and dry["system_selected_dates_proven"] == 1
    human = dry["human"]
    assert (human["right"], human["wrong"], human["unsure"], human["missed"], human["n"]) == (
        2,
        1,
        1,
        2,
        6,
    )
    assert (human["right_on_selected"], human["wrong_on_selected"]) == (1, 1)
    assert human["precision"] == pytest.approx(0.5)
    assert human["misses"] == 2 and human["recall_proxy"] == pytest.approx(1 / 3)
    agreement = dry["agreement"]
    assert (agreement["both"], agreement["agree"], agreement["disagree"]) == (4, 2, 2)
    assert {item["document_id"] for item in agreement["disagreements"]} == {"d2", "d3"}
    assert result["human"]["precision"] == pytest.approx(0.5)
    assert result["by_source"]["real"]["subjects"] == 0


def test_real_and_dry_run_sides_add_up():
    real_docs = [
        {"document_id": "p1", "selected": True, "flags": ["selected_without_content_dates"]}
    ]
    result = request_accuracy(
        [("ask-1", [{"document_id": "d1", "selected": True}], {"d1": {"verdict": "right"}})],
        [("req-1", real_docs, {"p1": {"verdict": "wrong"}})],
    )
    assert result["system_selected"] == 2 and result["system_selected_dates_proven"] == 0
    assert result["by_source"]["real"]["human"]["wrong_on_selected"] == 1
    assert result["human"]["precision"] == pytest.approx(0.5)
    assert result["agreement"] == {"both": 2, "agree": 1, "disagree": 1}


def test_document_claims_name_documents_and_trust_the_engines_period_proof():
    claims = document_claims(
        [
            {"selected": True},
            {"file_id": "f9", "selected": False},
            {
                "document_id": None,
                "position": 4,
                "selected": True,
                "period_proven": False,
                "period_start": "2026-09-01",
                "period_end": "2026-09-30",
                "period_role": "content_period",
            },
            {"document_id": "d7", "selected": True, "period_proven": True},
        ]
    )
    assert set(claims) == {"#0", "f9", "p4", "d7"} and claims["#0"]["selected"] is True
    assert claims["p4"] == {"selected": True, "dates_proven": False}
    assert claims["d7"] == {"selected": True, "dates_proven": True}


def _judgment(key, judge, verdict, variant="primary", severity=None):
    return JudgmentRow(
        batch_id="B001",
        packet_key=key,
        judge_id=judge,
        model_version=None,
        prompt_sha256=None,
        seed=None,
        variant=variant,
        verdict=verdict,
        failed_checks=[] if verdict == "pass" else ["x"],
        severity=severity,
        citations_valid=None,
    )


def test_a_deterministic_failure_is_final_and_a_person_is_not_an_ai_judge():
    rows = [
        _judgment("k1", "consensus", "pass", "consensus"),
        _judgment("k1", "deterministic", "fail", severity="S1"),
        _judgment("k2", "J1", "fail"),
        _judgment("k2", "consensus", "unknown", "consensus"),
        _judgment("k2", "human", "pass"),
    ]
    verdicts = final_verdicts(rows)
    assert verdicts["k1"] == {"ai": "fail", "severity": "S1", "human": None}
    assert verdicts["k2"] == {"ai": "unknown", "severity": None, "human": "pass"}


def test_served_packet_ai_verdict_uses_the_newest_batch():
    assert ai_verdict([]) is None
    assert ai_verdict([{"judge": "J1", "verdict": "pass", "batch": "B003"}]) is None
    assert (
        ai_verdict(
            [
                {"judge": "consensus", "verdict": "fail", "batch": "B001"},
                {"judge": "consensus", "verdict": "pass", "batch": "B003"},
            ]
        )
        == "correct"
    )
    assert (
        ai_verdict(
            [
                {"judge": "consensus", "verdict": "pass", "batch": "B003"},
                {"judge": "deterministic", "verdict": "fail", "batch": "B001"},
            ]
        )
        == "wrong"
    )


def test_eval_batch_view_uses_the_founder_report_metric(tmp_path):
    root = tmp_path / "eval"
    root.mkdir(mode=0o700)
    path = write_batch(
        root, "B007", {"a": "pass", "b": "fail", "c": "unknown", "d": "pass"}, human={"b": "fail"}
    )
    view = batch_view(path)
    assert (view["ready_wrong"], view["ready_total"], view["undecided"]) == (1, 3, 1)
    assert view["code_sha"] == "abc1234def"
    assert view["founder_report_lines"][1] == "Ready packets wrong: 1 of 3."
    assert view["gates"]["listing"]["reasons"] == ["ready_packet_wrong"]
    assert human_queue([path]) == {"wrong": 0, "undecided": 1, "high_risk": 3}
