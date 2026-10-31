"""Each known failure class is caught by a deterministic check; its clean twin passes."""

import copy
import importlib.util
from pathlib import Path

import pytest

from hushh_eval.drive_packets.deterministic import (
    check_charges,
    check_cross_selection,
    check_delivery,
    check_packet,
    date_source_trap,
    execution_claims,
)

GENERATOR = (
    Path(__file__).resolve().parents[1] / "fixtures/drive_packet_eval/generate_adversarial.py"
)
spec = importlib.util.spec_from_file_location("generate_adversarial", GENERATOR)
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)


def members(*documents):
    return [
        {
            "document_id": item["document_id"],
            "content_sha256": item["content_sha256"],
            "facts": item["facts"],
            "pages": {int(k): v for k, v in item["pages"].items()},
            "metadata": item["metadata"],
            "complete": item["complete"],
        }
        for item in documents
    ]


def codes(packet, documents, **kwargs):
    return {finding.code for finding in check_packet(packet, members(*documents), **kwargs)}


def clean_statement_packet():
    sep = fx.statement("doc-sep")
    return fx.proposal(["doc-sep"], periods=fx.september(sep)), [sep]


def test_clean_statement_packet_passes():
    packet, documents = clean_statement_packet()
    assert codes(packet, documents, verification=fx.verdict()) == set()


def test_wire_request_shown_as_executed_is_s1_and_bounded_copy_passes():
    wire = fx.wire_request("doc-wire")
    claims = fx.proposal(
        ["doc-wire"],
        periods=[],
        scope="no_period_claim",
        title="Requested wire transfer",
        description="Requested transfer: settlement confirmed by bank",
        pricing=fx.pricing(scope="single"),
    )
    assert "request_shown_executed" in codes(claims, [wire])
    bounded = {
        **claims,
        "title": "Wire transfer requests",
        "description": "Documents requesting a wire transfer; execution is unverified.",
        "coverage_summary": "Request records only; no completed action or reporting period verified.",
        "utility_rationale": "Request documents are useful as records; completion is unverified.",
        "pricing": {
            **claims["pricing"],
            "rationale": "Estimate for request documents only; completion is unverified.",
        },
    }
    assert codes(bounded, [wire]) == set()
    # Negation only counts inside the same clause.
    assert execution_claims("not executed, funds moved") == ["moved"]
    assert execution_claims("no completed action") == []


def test_period_taken_from_file_modified_month_is_s1():
    trap = fx.statement("doc-trap", month="10", last=31, modified="2026-10-13T09:00:00Z")
    trap["facts"]["periods"][0]["citations"] = fx.cite("Monthly statement")
    packet = fx.proposal(["doc-trap"], periods=[dict(trap["facts"]["periods"][0])])
    assert "period_from_file_date" in codes(packet, [trap])
    clean = fx.statement("doc-clean", month="10", last=31, modified="2026-10-13T09:00:00Z")
    assert (
        codes(fx.proposal(["doc-clean"], periods=[dict(clean["facts"]["periods"][0])]), [clean])
        == set()
    )
    period = {
        "start": "2026-10-01",
        "end": "2026-10-31",
        "citations": [{"quote": "Period 10/01/26 - 10/31/26"}],
    }
    assert not date_source_trap(period, {"modifiedTime": "2026-10-13T00:00:00Z"})


def test_same_pdf_twice_is_s2():
    a, b = fx.statement("doc-a", sha=fx.SHA_A), fx.statement("doc-b", sha=fx.SHA_A)
    packet = fx.proposal(["doc-a", "doc-b"], periods=fx.september(a))
    assert "duplicate_member_content" in codes(packet, [a, b])
    b["content_sha256"] = fx.SHA_B
    assert "duplicate_member_content" not in codes(packet, [a, b])


def test_wrong_account_member_is_s1():
    sep = fx.statement("doc-sep")
    other = fx.statement("doc-oct", month="10", last=31, account="9876", sha=fx.SHA_B)
    periods = fx.september(sep) + [dict(other["facts"]["periods"][0])]
    packet = fx.proposal(
        ["doc-sep", "doc-oct"], periods=periods, pricing=fx.pricing(scope="multi_period")
    )
    assert "mixed_account_members" in codes(packet, [sep, other])
    same = fx.statement("doc-oct", month="10", last=31, account="1122", sha=fx.SHA_B)
    assert "mixed_account_members" not in codes(packet, [sep, same])


def test_injected_500_dollar_price_is_flagged_and_bounds_hold():
    packet, documents = clean_statement_packet()
    injected = copy.deepcopy(packet)
    injected["pricing"]["suggested_price_cents"] = 50000
    assert "price_outside_rubric_cell" in codes(injected, documents)
    injected["pricing"]["suggested_price_cents"] = 60000
    assert "price_out_of_bounds" in codes(injected, documents)


def test_ocr_gap_marked_ready_is_s2():
    packet, documents = clean_statement_packet()
    documents[0]["complete"] = False
    assert "ready_with_extraction_gap" in codes(packet, documents)


def test_fabricated_member_citation_is_caught():
    packet, documents = clean_statement_packet()
    documents[0]["facts"]["issuer"]["citations"][0]["quote"] = "Not on the page"
    assert "citation_not_exact" in codes(packet, documents)


def test_unauthorized_or_duplicate_delivery_and_double_charge_are_s1():
    clean = {
        "observed": True,
        "approved_ids": ["a", "b"],
        "paid_ids": ["a", "b"],
        "delivered_ids": ["a", "b"],
    }
    assert check_delivery(clean) == []
    leaked = {**clean, "delivered_ids": ["a", "b", "c"]}
    assert {item.code for item in check_delivery(leaked)} == {"unauthorized_delivery"}
    twice = {**clean, "delivered_ids": ["a", "a", "b"]}
    assert {item.code for item in check_delivery(twice)} == {"duplicate_delivery"}
    assert check_delivery({"observed": False})[0].code == "delivery_not_observed"
    charges = [
        {
            "buyer_ref": "b1",
            "packet_key": "p",
            "version": 1,
            "status": "succeeded",
            "amount_cents": 100,
        },
        {
            "buyer_ref": "b1",
            "packet_key": "p",
            "version": 1,
            "status": "succeeded",
            "amount_cents": 100,
        },
    ]
    assert check_charges(charges)[0].code == "duplicate_charge"
    assert check_charges(charges[:1]) == []
    selections = [
        {"selection_id": "s1", "content_sha256s": ["h1"]},
        {"selection_id": "s2", "content_sha256s": ["h1"]},
    ]
    assert check_cross_selection(selections)[0].code == "same_content_in_two_selections"


@pytest.mark.parametrize("state", ["incomplete", "unable_to_verify"])
def test_non_ready_packets_are_not_held_to_ready_invariants(state):
    packet, documents = clean_statement_packet()
    packet = {**packet, "state": state, "gaps": ["October missing"]}
    packet["pricing"] = {**packet["pricing"], "coverage": "partial", "quality": "limited"}
    assert not {code for code in codes(packet, documents) if code.startswith("ready_")}
