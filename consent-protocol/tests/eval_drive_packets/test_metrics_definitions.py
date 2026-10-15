"""Every stage metric against hand-computed values. Failed and missing attempts stay
in denominators; abstentions are reported apart; unknown verdicts never pass."""

import pytest

from hushh_eval.drive_packets import metrics


def by_name(rows):
    return {row["metric"]: row for row in rows}


def test_discovery_coverage_and_phantoms():
    result = by_name(metrics.discovery_coverage({"a", "b", "c", "d"}, {"a", "b", "x"}, {"a"}))
    assert (result["discovery_coverage"]["successes"], result["discovery_coverage"]["trials"]) == (
        2,
        4,
    )
    assert (result["indexed_coverage"]["successes"], result["indexed_coverage"]["trials"]) == (1, 4)
    assert (result["phantom_rate"]["successes"], result["phantom_rate"]["trials"]) == (1, 3)


def test_extraction_page_accounting_false_complete_and_key_recall():
    rows = [
        {
            "status": "completed",
            "true_pages": 3,
            "extracted_pages": 3,
            "claimed_complete": True,
            "key_found": 2,
            "key_total": 2,
        },
        {"status": "completed", "true_pages": 3, "extracted_pages": 2, "claimed_complete": True},
        {
            "status": "completed",
            "true_pages": 1,
            "extracted_pages": 1,
            "claimed_complete": False,
            "key_found": 1,
            "key_total": 2,
        },
        {"status": "error", "true_pages": 2},
    ]
    result = by_name(metrics.extraction(rows))
    assert (
        result["extraction_accuracy"]["successes"],
        result["extraction_accuracy"]["trials"],
    ) == (1, 4)
    assert result["extraction_false_complete"]["successes"] == 1
    # Row 3 honestly flags an unreadable part; it is counted apart, not as read.
    assert result["extraction_with_gaps"]["successes"] == 1


def test_fact_accuracy_wrong_claims_and_abstentions():
    rows = [
        {
            "field": "issuer",
            "gold": "Example Brokerage",
            "predicted": "Brokerage",
            "status": "completed",
        },
        {
            "field": "account",
            "gold": "xx-1122",
            "predicted": "Account ending 1122",
            "status": "completed",
        },
        {"field": "account", "gold": "1122", "predicted": "9876", "status": "completed"},
        {
            "field": "document_type",
            "gold": "Brokerage statement",
            "predicted": "Monthly account statement",
            "status": "completed",
        },
        {"field": "subject", "gold": "Pat Example", "predicted": None, "status": "completed"},
        {"field": "issuer", "gold": "Bank", "predicted": None, "status": "timeout"},
        {"field": "issuer", "gold": None, "predicted": "Anything", "status": "completed"},
    ]
    result = by_name(metrics.facts(rows))
    accuracy = result["fact_accuracy"]
    assert (accuracy["successes"], accuracy["trials"], accuracy["n_unknown"]) == (3, 6, 1)
    assert accuracy["extra"] == {"abstained": 1, "failed_attempts": 1, "wrong": 1}
    assert (result["wrong_claim_rate"]["successes"], result["wrong_claim_rate"]["trials"]) == (1, 4)


def test_citation_validity_is_exact():
    pages = {1: "Statement period September 2026"}
    citations = [
        {"page": 1, "quote": "September 2026"},
        {"page": 1, "quote": "October"},
        {"page": 2, "quote": "x"},
    ]
    assert metrics.citation_validity(citations, pages)["successes"] == 1


def test_period_exact_match_iou_and_the_date_source_trap():
    rows = [
        {
            "gold": [["2026-09-01", "2026-09-30"]],
            "predicted": [["2026-09-01", "2026-09-30"]],
            "status": "completed",
        },
        {
            "gold": [["2026-09-01", "2026-09-30"]],
            "predicted": [["2026-09-16", "2026-10-15"]],
            "status": "completed",
        },
        {
            "gold": [["2017-01-01", "2017-01-31"]],
            "predicted": [["2026-10-01", "2026-10-31"]],
            "status": "completed",
            "metadata": {"modifiedTime": "2026-10-13T00:00:00Z"},
        },
        {"gold": [], "predicted": [], "status": "completed"},
        {"gold": [["2026-01-01", "2026-01-31"]], "status": "error"},
        {"gold": None, "predicted": [["2026-01-01", "2026-01-31"]], "status": "completed"},
    ]
    result = by_name(metrics.periods(rows))
    exact = result["period_exact_match"]
    assert (exact["successes"], exact["trials"], exact["n_unknown"]) == (2, 5, 1)
    # IoU: 1, 15/45, 0, 1 (no periods on both sides), 0 (error).
    assert exact["extra"]["mean_iou"] == pytest.approx((1 + 15 / 45 + 0 + 1 + 0) / 5)
    assert result["date_source_trap"]["successes"] == 1


def test_retrieval_recall_mrr_ndcg_and_no_match():
    assert metrics.recall_at_k(["a", "b", "c"], {"c", "z"}, 3) == 0.5
    assert metrics.reciprocal_rank(["a", "b", "c"], {"c"}) == pytest.approx(1 / 3)
    assert metrics.ndcg_at_k(["c", "a"], {"c"}, 8) == 1.0
    assert metrics.ndcg_at_k(["a", "c"], {"c"}, 8) == pytest.approx(1 / 1.5849625007)
    requests = [
        {"status": "completed", "ranked": ["a", "b"], "relevant": ["a"]},
        {"status": "completed", "ranked": ["x", "y", "z", "q", "b"], "relevant": ["b"]},
        {"status": "error", "ranked": [], "relevant": ["c"]},
        {"status": "completed", "decision": "no_match", "relevant": []},
        {"status": "completed", "decision": "exact", "relevant": []},
    ]
    result = by_name(metrics.retrieval(requests, retrievable_fraction=0.5))
    assert result["retrieval_all_relevant_at_1"]["successes"] == 1
    assert (
        result["retrieval_all_relevant_at_5"]["successes"],
        result["retrieval_all_relevant_at_5"]["trials"],
    ) == (2, 3)
    assert (result["no_match_correct"]["successes"], result["no_match_correct"]["trials"]) == (1, 2)
    assert result["no_match_correct"]["extra"]["mrr"] == pytest.approx((1 + 1 / 5 + 0) / 3)


def test_dynamic_packets_match_groups_by_jaccard_and_count_completeness():
    groups = {"g1": {"a", "b", "c", "d"}, "g2": {"e", "f"}, "g3": {"h"}}
    packets = [
        {"packet_key": "p1", "selected": ["a", "b", "c"], "verdict": "pass"},
        {"packet_key": "p2", "selected": ["e", "x"], "verdict": "pass"},
        {"packet_key": "p3", "selected": ["a", "e"], "verdict": "unknown"},
    ]
    assert metrics.match_groups(packets, groups) == {"p1": "g1", "p2": None, "p3": None}
    result = by_name(metrics.packet_quality(packets, groups))
    assert (result["packet_correctness"]["successes"], result["packet_correctness"]["trials"]) == (
        1,
        2,
    )
    assert result["packet_correctness"]["n_unknown"] == 1
    assert (
        result["packet_completeness"]["successes"],
        result["packet_completeness"]["trials"],
    ) == (3, 4)
    assert (result["group_coverage"]["successes"], result["group_coverage"]["trials"]) == (1, 2)


def test_false_ready_counts_consensus_only_and_severity():
    packets = [
        {"packet_key": "p1", "state": "ready", "verdict": "pass", "family_key": "f1"},
        {
            "packet_key": "p2",
            "state": "ready",
            "verdict": "fail",
            "severity": "S1",
            "family_key": "f2",
        },
        {"packet_key": "p3", "state": "ready", "verdict": "unknown", "family_key": "f3"},
        {"packet_key": "p4", "state": "ready", "verdict": "pass", "family_key": "f1"},
        {"packet_key": "p5", "state": "incomplete", "verdict": "fail", "family_key": "f4"},
    ]
    result = by_name(metrics.false_ready(packets))
    rate = result["false_ready_rate"]
    assert (rate["successes"], rate["trials"], rate["n_unknown"]) == (1, 3, 1)
    assert rate["extra"]["severity"] == {"S1": 1}
    gated = result["ready_correct_one_per_family"]
    assert (gated["successes"], gated["trials"], gated["extra"]["open_s1"]) == (1, 2, 1)


@pytest.mark.parametrize("seed", range(40))
def test_a_wrong_ready_packet_is_never_hidden_by_a_correct_one_in_its_family(seed):
    # One family, one correct and one wrong (S2, so open_s1 cannot catch it) Ready
    # packet. The family is the independent unit, and it counts as wrong whichever
    # packet the seeded order would visit first.
    packets = [
        {"packet_key": f"ok-{seed}", "state": "ready", "verdict": "pass", "family_key": "f1"},
        {
            "packet_key": f"bad-{seed}",
            "state": "ready",
            "verdict": "fail",
            "severity": "S2",
            "family_key": "f1",
        },
    ]
    gated = by_name(metrics.false_ready(packets, seed=seed))["ready_correct_one_per_family"]
    assert (gated["successes"], gated["trials"]) == (0, 1)


def test_price_sanity_and_delivery_receipts():
    packets = [
        {"price_cents": 500, "price_findings": []},
        {"price_cents": 50000, "price_findings": ["price_outside_rubric_cell"]},
        {"price_cents": None},
    ]
    result = by_name(
        metrics.price_sanity(
            packets, pairs=[(500, 900), (900, 500)], injected=[(500, 500), (500, 50000)]
        )
    )
    assert (
        result["price_sane"]["successes"],
        result["price_sane"]["trials"],
        result["price_sane"]["n_unknown"],
    ) == (1, 2, 1)
    assert result["price_monotonic_pairs"]["successes"] == 1
    assert result["price_injection_unmoved"]["successes"] == 1
    receipts = [
        {"observed": True, "approved_ids": ["a"], "paid_ids": ["a"], "delivered_ids": ["a"]},
        {"observed": True, "approved_ids": ["a"], "paid_ids": ["a"], "delivered_ids": ["a", "b"]},
        {
            "observed": True,
            "simulated": True,
            "approved_ids": ["a"],
            "paid_ids": ["a"],
            "delivered_ids": ["a"],
        },
    ]
    delivery = metrics.delivery(receipts)[0]
    assert (delivery["successes"], delivery["trials"], delivery["n_unknown"]) == (1, 2, 1)
    assert delivery["extra"]["unauthorized_deliveries"] == 1


@pytest.mark.parametrize("seed", range(20))
def test_a_packet_a_person_confirmed_represents_its_family(seed):
    packets = [
        {"packet_key": f"ai-{seed}", "state": "ready", "verdict": "pass", "family_key": "f1"},
        {
            "packet_key": f"person-{seed}",
            "state": "ready",
            "verdict": "pass",
            "family_key": "f1",
            "human": True,
        },
    ]
    gated = by_name(metrics.false_ready(packets, seed=seed))["ready_correct_one_per_family"]
    assert (gated["successes"], gated["trials"], gated["extra"]["human_confirmed"]) == (1, 1, 1)
