"""V1 content gates reject unsupported statements without trusting file activity."""

import pytest

from hushh_mcp.services.drive_request_package_assessment import (
    BoundDocumentBatchAssessment,
    EvidenceQuote,
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


def test_punctuated_issuer_and_estmt_in_generic_file_are_valid_content_evidence():
    body = "Charles-Schwab Brokerage Account eStmt. Period: September 1 to October 9, 2026."
    checked = verify_v1_document_batch(
        _batch(body),
        request={**REQUEST, "requiredEntities": ["Schwab"]},
        retrieved=_retrieved(body, name="IMG_0926.pdf"),
    )
    assert checked.documents[0].decision == "include"


def test_multiword_issuer_requires_full_name_in_one_citation():
    body = "Charles River Brokerage Account Statement. Period: September 1 to October 9, 2026."
    checked = verify_v1_document_batch(_batch(body), request=REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "uncertain"
    assert checked.documents[0].confidence == 0

    split = "Charles\nSchwab Brokerage Account Statement. Period: September 1 to October 9, 2026."
    split_payload = _batch(split).model_dump()
    split_payload["documents"][0]["citations"] = [
        {"source_ref": "s1", "quote": "Charles"},
        {
            "source_ref": "s1",
            "quote": "Schwab Brokerage Account Statement. Period: September 1 to October 9, 2026.",
        },
    ]
    batch = BoundDocumentBatchAssessment.model_validate(split_payload)
    checked = verify_v1_document_batch(batch, request=REQUEST, retrieved=_retrieved(split))
    assert checked.documents[0].decision == "uncertain"


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


MEETING_REQUEST = {
    "purpose": "3 months of meeting notes",
    "periodStart": "2026-09-02",
    "periodEnd": "2026-10-02",
    "semanticIntent": "other",
}


def _meeting_batch(body, *, event="2026-09-29", role="event_date"):
    batch = _batch(body, start=event, end=event)
    batch.documents[0].record_type_claim = "meeting notes"
    batch.documents[0].entity_claim = None
    batch.documents[0].period_role = role
    return batch


def test_meeting_notes_accept_sync_standup_with_cited_event_date():
    body = (
        "Example Team Sync and Standup — 2026/09/29. "
        "Decisions: follow up on onboarding. Action items: send draft."
    )
    checked = verify_v1_document_batch(
        _meeting_batch(body), request=MEETING_REQUEST, retrieved=_retrieved(body, name="Untitled")
    )
    assert checked.documents[0].decision == "include"


def test_meeting_notes_accept_past_standup_decisions_as_bullets():
    body = (
        "Team Standup 2026/09/29. Attendees: engineering and product.\n"
        "Decisions\n- Ship the revised onboarding checklist.\n"
        "Action items\n1. Review the rollout tomorrow."
    )
    checked = verify_v1_document_batch(
        _meeting_batch(body), request=MEETING_REQUEST, retrieved=_retrieved(body, name="doc_001")
    )
    assert checked.documents[0].decision == "include"


def test_meeting_notes_recover_omitted_type_and_subject_quotes_from_same_source():
    body = "Example Team Meeting Notes — 2026-09-29. Decisions: approved the revised checklist."
    batch = _meeting_batch(body)
    batch.documents[0].entity_claim = "Example Team"
    batch.documents[0].citations = [EvidenceQuote(source_ref="s1", quote="2026-09-29")]
    checked = verify_v1_document_batch(
        batch, request=MEETING_REQUEST, retrieved=_retrieved(body, name="Untitled")
    )
    result = checked.documents[0]
    assert result.decision == "include"
    assert len(result.citations) > 1
    assert all(cite.source_ref == "s1" and cite.quote in body for cite in result.citations)


def test_meeting_retrospective_sentence_can_establish_notes_without_literal_label():
    body = "Example Team Sync — 2026-09-29. We discussed onboarding and agreed on next steps."
    checked = verify_v1_document_batch(
        _meeting_batch(body), request=MEETING_REQUEST, retrieved=_retrieved(body)
    )
    assert checked.documents[0].decision == "include"


def test_meeting_agenda_with_past_reference_is_still_uncertain():
    body = (
        "Example Team Sync Agenda — 2026-09-29. "
        "We discussed onboarding last week. Planned topics for this meeting."
    )
    checked = verify_v1_document_batch(
        _meeting_batch(body), request=MEETING_REQUEST, retrieved=_retrieved(body)
    )
    assert checked.documents[0].decision == "uncertain"


def test_meeting_recovery_does_not_promote_unavailable_notes():
    body = "Example Team Meeting Notes are not available — 2026-09-29. Agenda for the next sync."
    batch = _meeting_batch(body)
    batch.documents[0].citations = [EvidenceQuote(source_ref="s1", quote="2026-09-29")]
    checked = verify_v1_document_batch(batch, request=MEETING_REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "uncertain"
    direct = verify_v1_document_batch(
        _meeting_batch(body), request=MEETING_REQUEST, retrieved=_retrieved(body)
    )
    assert direct.documents[0].decision == "uncertain"


def test_meeting_recovery_never_uses_filename_or_another_document():
    body = "Example Team Sync — 2026-09-29. Planned discussion topics."
    batch = _meeting_batch(body)
    batch.documents[0].entity_claim = "Example Team"
    batch.documents[0].citations = [EvidenceQuote(source_ref="s1", quote="2026-09-29")]
    retrieved = _retrieved(body, name="Example Team Meeting Notes — 2026-09-29")
    retrieved["untrusted_external_content"].append(
        {
            "document_ref": "p2",
            "source_ref": "s2",
            "text": "Example Team Meeting Notes. Decisions: completed the checklist.",
            "name": "Untitled",
        }
    )
    checked = verify_v1_document_batch(batch, request=MEETING_REQUEST, retrieved=retrieved)
    assert checked.documents[0].decision == "uncertain"


def test_meeting_recovery_does_not_relabel_a_scheduled_date_as_event_date():
    body = "Example Team Meeting Notes. Next meeting scheduled 2026-09-29."
    batch = _meeting_batch(body)
    batch.documents[0].entity_claim = "Example Team"
    batch.documents[0].citations = [
        EvidenceQuote(source_ref="s1", quote="Next meeting scheduled 2026-09-29")
    ]
    checked = verify_v1_document_batch(batch, request=MEETING_REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "uncertain"


def test_meeting_recovery_does_not_create_a_missing_date_citation():
    body = "Example Team Meeting Notes — 2026-09-29. Decisions: approved the revised checklist."
    batch = _meeting_batch(body)
    batch.documents[0].entity_claim = "Example Team"
    batch.documents[0].citations = [
        EvidenceQuote(source_ref="s1", quote="Decisions: approved the revised checklist.")
    ]
    checked = verify_v1_document_batch(batch, request=MEETING_REQUEST, retrieved=_retrieved(body))
    assert checked.documents[0].decision == "uncertain"


@pytest.mark.parametrize(
    ("body", "event", "role"),
    [
        ("Team Sync Agenda — 2026/09/29. Planned discussion topics.", "2026-09-29", "event_date"),
        ("Q3 budget report — 2026/09/29. Decisions: cut costs.", "2026-09-29", "event_date"),
        (
            "Team Sync Notes — 2026/08/01. Decisions: follow up.",
            "2026-08-01",
            "event_date",
        ),
        (
            "Team Sync Notes — 2026/09/29. Decisions: follow up.",
            "2026-09-29",
            "reporting_period",
        ),
        (
            "Team Sync Notes. Next meeting scheduled 2026/09/29. Decisions: follow up.",
            "2026-09-29",
            "event_date",
        ),
    ],
)
def test_meeting_notes_abstain_on_unrelated_old_or_wrong_date_evidence(body, event, role):
    checked = verify_v1_document_batch(
        _meeting_batch(body, event=event, role=role),
        request=MEETING_REQUEST,
        retrieved=_retrieved(body),
    )
    assert checked.documents[0].decision == "uncertain"
    assert checked.documents[0].confidence == 0


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
    batch = _batch(body, start="2026-09-01", end="2026-09-30")
    batch.documents[0].entity_claim = "Schwab"
    checked = verify_v1_document_batch(
        batch,
        request=REQUEST,
        retrieved=_retrieved(body),
    )
    assert checked.documents[0].decision == "include"
    batch = _batch(body, start="2026-09-03", end="2026-09-29")
    batch.documents[0].entity_claim = "Schwab"
    invalid = verify_v1_document_batch(
        batch,
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
