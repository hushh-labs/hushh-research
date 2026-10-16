"""V1 content gates reject unsupported statements without trusting file activity."""

import pytest

from hushh_mcp.services.drive_request_package_assessment import (
    BoundDocumentBatchAssessment,
    PackageAssessment,
    verify_v1_document_batch,
    verify_v1_package,
)
from hushh_mcp.services.drive_request_package_store import _public_package

REQUEST = {
    "purpose": "All Schwab brokerage statements in the selected window",
    "periodStart": "2026-09-01",
    "periodEnd": "2026-10-09",
    "semanticIntent": "institutional_statement",
}


def _batch(body, *, start="2026-09-01", end="2026-10-09"):
    return BoundDocumentBatchAssessment.model_validate(
        {
            "documents": [
                {
                    "document_ref": "p1",
                    "decision": "include",
                    "confidence": 99,
                    "weightage_out_of_10": 8.5,
                    "record_type_claim": "brokerage statement",
                    "entity_claim": "Charles Schwab",
                    "period_role": "statement_coverage",
                    "reason": "The document appears to match.",
                    "citations": [{"source_ref": "s1", "quote": body}],
                    "covered_periods": [
                        {"period_start": start, "period_end": end, "source_refs": ["s1"]}
                    ],
                    "source_version": "provider-v7",
                }
            ]
        }
    )


def _retrieved(body, *, name="eStmt_0930.pdf"):
    return {
        "untrusted_external_content": [
            {"document_ref": "p1", "source_ref": "s1", "text": body, "name": name}
        ]
    }


def test_generic_filename_can_match_when_issuer_type_and_period_are_cited():
    body = "Charles Schwab Account Statement. Period: September 1 – October 9, 2026."
    checked = verify_v1_document_batch(_batch(body), request=REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "include"
    assert checked.documents[0].source_version == "provider-v7"
    assert checked.documents[0].weightage_out_of_10 == 8.5


def test_recent_drive_edit_cannot_make_old_transaction_history_a_2026_statement():
    body = "Charles Schwab Transaction History from January 1, 2014 to December 31, 2016."
    checked = verify_v1_document_batch(_batch(body), request=REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "uncertain"
    assert checked.documents[0].covered_periods == []
    assert checked.documents[0].confidence == 0


def test_host_requires_typed_semantic_claim_and_high_enough_assessment():
    body = "Charles Schwab Account Statement. Period: September 1 to October 9, 2026."
    for update in ({"record_type_claim": None}, {"period_role": "unknown"}, {"confidence": 79}):
        batch = _batch(body)
        for key, value in update.items():
            setattr(batch.documents[0], key, value)
        checked = verify_v1_document_batch(batch, request=REQUEST, retrieved=_retrieved(body))
        assert checked.documents[0].decision == "uncertain"
        assert checked.documents[0].confidence == 0


def test_broad_financial_request_uses_content_not_filename():
    body = "Salary income tracker. Period: 2026-09-01 through 2026-10-09."
    request = {
        **REQUEST,
        "purpose": "last one year finacial staements and weigtage",
        "semanticIntent": "broad_financial_records",
    }
    batch = _batch(body)
    batch.documents[0].record_type_claim = "salary tracker"
    batch.documents[0].entity_claim = None
    checked = verify_v1_document_batch(
        batch, request=request, retrieved=_retrieved(body, name="untitled.xlsx")
    )
    assert checked.documents[0].decision == "include"


def test_false_issuer_claim_cannot_use_a_different_issuers_citation():
    body = "Morgan Stanley brokerage account statement. Period: September 1 to October 9, 2026."
    checked = verify_v1_document_batch(
        _batch(body),
        request={**REQUEST, "requiredEntities": ["Schwab"]},
        retrieved=_retrieved(body, name="eStmt_2026.pdf"),
    )
    assert checked.documents[0].decision == "uncertain"
    assert checked.documents[0].confidence == 0


def test_security_bulletin_cannot_pose_as_statement_by_mentioning_statements():
    body = (
        "Charles Schwab Account Security Bulletin. Published October 9, 2026. "
        "This educational brochure explains how to read statements; it is not an account statement. "
        "September 1 to October 9, 2026."
    )
    checked = verify_v1_document_batch(_batch(body), request=REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "uncertain"
    assert checked.documents[0].confidence == 0


def test_month_name_supports_exact_calendar_month_not_arbitrary_days():
    body = "Schwab Account Statement: September 2026. Account holdings and balance."
    checked = verify_v1_document_batch(
        _batch(body, start="2026-09-01", end="2026-09-30"),
        request=REQUEST,
        retrieved=_retrieved(body),
    )
    assert checked.documents[0].decision == "include"
    invalid = verify_v1_document_batch(
        _batch(body, start="2026-09-03", end="2026-09-29"),
        request=REQUEST,
        retrieved=_retrieved(body),
    )
    assert invalid.documents[0].decision == "uncertain"


def test_v1_missing_weightage_abstains_without_changing_confidence_semantics():
    body = "Charles Schwab Account Statement. Period: 2026-09-01 to 2026-10-09."
    batch = _batch(body)
    batch.documents[0].weightage_out_of_10 = None
    checked = verify_v1_document_batch(batch, request=REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "uncertain"
    assert checked.documents[0].confidence == 0


@pytest.mark.parametrize("weightage", [0, 10.1, float("nan"), float("inf")])
def test_per_file_weightage_is_finite_and_bounded(weightage):
    body = "Charles Schwab Account Statement. Period: 2026-09-01 to 2026-10-09."
    candidate = _batch(body).documents[0].model_dump()
    candidate["weightage_out_of_10"] = weightage
    with pytest.raises(ValueError):
        BoundDocumentBatchAssessment.model_validate({"documents": [candidate]})


def _ready():
    return PackageAssessment.model_validate(
        {
            "decision": "ready",
            "coverage_status": "complete",
            "selected_document_refs": ["p1"],
            "confidence": 99,
            "importance": 125,
            "suggested_price_cents": 150,
            "rationale": "One statement.",
            "coverage_summary": "Selected dates are covered.",
            "gaps": [],
        }
    )


def test_ready_requires_gap_free_cited_periods():
    body = "Charles Schwab Account Statement. Period: September 1 – September 30, 2026."
    checked = verify_v1_document_batch(
        _batch(body, end="2026-09-30"), request=REQUEST, retrieved=_retrieved(body)
    )
    result = verify_v1_package(_ready(), request=REQUEST, documents=checked.documents)
    assert result.decision == "partial" and result.coverage_status == "partial"
    assert result.gaps


def test_all_request_cannot_be_ready_when_same_month_verified_statement_is_omitted():
    first = _batch(
        "Charles Schwab Account A Statement. Period: September 1 to October 9, 2026."
    ).documents[0]
    second = (
        _batch("Charles Schwab Account B Statement. Period: September 1 to October 9, 2026.")
        .documents[0]
        .model_copy(update={"document_ref": "p2"})
    )
    result = verify_v1_package(_ready(), request=REQUEST, documents=[first, second])
    assert result.decision == "partial"
    assert result.coverage_status == "partial"
    assert result.selected_document_refs == ["p1"]
    assert "Additional verified matching documents" in result.gaps[0]

    # An LLM-authored count cannot override an explicit "all" in the request.
    limited = verify_v1_package(
        _ready(), request={**REQUEST, "resultLimit": 1}, documents=[first, second]
    )
    assert limited.decision == "partial"


def test_explicit_single_result_can_select_one_of_two_verified_matches():
    first = _batch(
        "Charles Schwab Account A Statement. Period: September 1 to October 9, 2026."
    ).documents[0]
    second = first.model_copy(update={"document_ref": "p2"})
    request = {**REQUEST, "purpose": "One Schwab statement for this period", "resultLimit": 1}
    result = verify_v1_package(_ready(), request=request, documents=[first, second])
    assert result.decision == "ready"


def test_broad_financial_inventory_does_not_require_every_day_to_be_covered():
    body = "Salary income tracker. Period: 2026-09-01 through 2026-09-30."
    batch = _batch(body, end="2026-09-30")
    batch.documents[0].record_type_claim = "salary tracker"
    batch.documents[0].entity_claim = None
    checked = verify_v1_document_batch(
        batch,
        request={**REQUEST, "semanticIntent": "broad_financial_records"},
        retrieved=_retrieved(body),
    )
    result = verify_v1_package(
        _ready(),
        request={**REQUEST, "semanticIntent": "broad_financial_records"},
        documents=checked.documents,
    )
    assert result.decision == "ready"


def test_package_readiness_requires_confidence_80_separate_from_importance():
    result = verify_v1_package(
        _ready().model_copy(update={"confidence": 79, "importance": 500}),
        request=REQUEST,
        documents=_batch("Schwab Account Statement. Period: 2026-09-01 to 2026-10-09.").documents,
    )
    assert result.decision == "partial"


def test_partial_v1_cannot_be_allowed_but_legacy_partial_terms_remain_available():
    incomplete = {
        "assessment": {
            "decision": "partial",
            "coverage_status": "partial",
            "confidence": 80,
        },
        "selected_positions": [1],
    }
    assert (
        _public_package({**incomplete, "v1_statement_search": True}, status="ready")["canAllow"]
        is False
    )
    assert _public_package(incomplete, status="ready")["canAllow"] is True
