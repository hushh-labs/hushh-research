"""A claimed complete period requires cited, gap-free observed dates."""

import json

import pytest

from hushh_mcp.services.drive_request_package_assessment import (
    PackageAssessment,
    assess_document_batch,
    assess_package,
    validate_document_batch,
)
from hushh_mcp.services.drive_suggestion_service import CoveredPeriod, period_covered


def period(start, end, ref="source-1"):
    return CoveredPeriod(period_start=start, period_end=end, source_refs=[ref])


def test_full_six_completed_months_need_cited_contiguous_coverage():
    purpose = {"periodStart": "2026-03-01", "periodEnd": "2026-08-31"}
    known = {"source-1": {"document_ref": "document-1"}}
    assert period_covered(
        purpose,
        [period("2026-03-01", "2026-05-31"), period("2026-06-01", "2026-08-31")],
        known,
        ["document-1"],
    )
    assert not period_covered(
        purpose,
        [period("2026-03-01", "2026-05-31"), period("2026-07-01", "2026-08-31")],
        known,
        ["document-1"],
    )
    assert not period_covered(
        purpose,
        [period("2026-03-01", "2026-08-31", "invented")],
        known,
        ["document-1"],
    )


def _retrieved():
    return {
        "untrusted_external_content": [
            {
                "document_ref": "document-1",
                "source_ref": "source-1",
                "source_version": "provider-v7",
                "text": "Charles Schwab statement. Period: 2026-09-01 to 2026-10-09.",
            }
        ],
        "truncated": False,
        "unreadable": [],
    }


def _assessment():
    return {
        "documents": [
            {
                "document_ref": "document-1",
                "decision": "include",
                "confidence": 93,
                "reason": "The requested issuer and period are explicitly stated.",
                "citations": [
                    {
                        "source_ref": "source-1",
                        "quote": "Charles Schwab statement. Period: 2026-09-01 to 2026-10-09.",
                    }
                ],
                "covered_periods": [
                    {
                        "period_start": "2026-09-01",
                        "period_end": "2026-10-09",
                        "source_refs": ["source-1"],
                    }
                ],
            }
        ]
    }


def _package():
    return {
        "decision": "ready",
        "coverage_status": "complete",
        "selected_document_refs": ["document-1"],
        "confidence": 93,
        "importance": 120,
        "suggested_price_cents": 150,
        "rationale": "One ordinary statement with an explicit period.",
        "coverage_summary": "The requested dates are covered.",
        "gaps": [],
    }


@pytest.mark.asyncio
async def test_package_assessment_preserves_model_judgement_and_host_binds_version():
    async def interpreter(*, prompt, user_id):
        assert user_id == "owner"
        assert json.loads(prompt)["package_mode"] == "document_assessment"
        return _assessment()

    result = await assess_document_batch(
        request={"purpose": "Statements"},
        retrieved=_retrieved(),
        user_id="owner",
        interpreter=interpreter,
    )
    assert result.documents[0].source_version == "provider-v7"
    assert result.documents[0].confidence == 93
    assert result.confidence_kind == "model_assessment"
    assert result.calibrated_probability is None


@pytest.mark.parametrize(
    "failure",
    ["invented_quote", "cross_document", "missing_document", "no_evidence", "invented_period_ref"],
)
def test_package_document_citations_cannot_fabricate_or_borrow_evidence(failure):
    retrieved = _retrieved()
    result = _assessment()
    item = result["documents"][0]
    if failure == "invented_quote":
        item["citations"][0]["quote"] = "Statement period January 2027"
    elif failure == "cross_document":
        retrieved["untrusted_external_content"].append(
            {
                **retrieved["untrusted_external_content"][0],
                "document_ref": "document-2",
                "source_ref": "source-2",
            }
        )
        result["documents"].append({**item, "document_ref": "document-2"})
    elif failure == "missing_document":
        result["documents"] = []
    elif failure == "no_evidence":
        item["citations"] = []
    else:
        item["covered_periods"][0]["source_refs"] = ["invented"]
    with pytest.raises(ValueError):
        validate_document_batch(result, retrieved=retrieved)


@pytest.mark.parametrize(
    "field,value",
    [
        ("confidence", 101),
        ("importance", 0),
        ("importance", 501),
        ("suggested_price_cents", 49),
        ("suggested_price_cents", 50001),
        ("suggested_price_cents", 150.0),
        ("suggested_price_cents", True),
    ],
)
def test_model_estimate_is_integer_cents_and_bounded_without_clamping(field, value):
    output = _package()
    output[field] = value
    with pytest.raises(ValueError):
        PackageAssessment.model_validate(output)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["invented_ref", "uncertain", "truncated", "unreadable"])
async def test_package_cannot_call_unverified_or_incomplete_evidence_ready(failure):
    result = _assessment()
    output = _package()
    if failure == "invented_ref":
        output["selected_document_refs"] = ["invented"]
    elif failure == "uncertain":
        result["documents"][0]["decision"] = "uncertain"
    bound = validate_document_batch(result, retrieved=_retrieved())

    async def interpreter(**kwargs):
        return output

    with pytest.raises(ValueError):
        await assess_package(
            request={"purpose": "Statements"},
            assessments=bound.documents,
            user_id="owner",
            truncated=failure == "truncated",
            unreadable=[{"reason": "unsupported"}] if failure == "unreadable" else [],
            interpreter=interpreter,
        )


@pytest.mark.asyncio
async def test_partial_package_keeps_agent_estimate_and_only_verified_files():
    output = {
        **_package(),
        "decision": "partial",
        "coverage_status": "partial",
        "gaps": ["More candidates remain unread."],
    }
    bound = validate_document_batch(_assessment(), retrieved=_retrieved())

    async def interpreter(**kwargs):
        return output

    result = await assess_package(
        request={"purpose": "Statements"},
        assessments=bound.documents,
        user_id="owner",
        truncated=True,
        interpreter=interpreter,
    )
    assert result.model_dump() == output


def test_package_eval_grades_gold_evidence_instead_of_model_confidence():
    from scripts.eval_drive_package_assessment import grade

    bound = validate_document_batch(_assessment(), retrieved=_retrieved())
    document = bound.documents[0].model_copy(update={"document_ref": "doc-0"})
    output = PackageAssessment.model_validate(
        {**_package(), "confidence": 100, "selected_document_refs": ["doc-0"]}
    )
    correct = grade({"decisions": ["include"], "package": "ready"}, [document], output)
    assert correct["document_decisions_correct"]
    assert correct["content_periods_correct"]
    false_accept = grade({"decisions": ["exclude"], "package": "no_match"}, [document], output)
    assert false_accept["false_acceptances"] == 1
    assert not false_accept["document_decisions_correct"]
    assert not false_accept["package_decision_correct"]
    wrong_period = grade(
        {"decisions": ["include"], "package": "ready", "periods": [("2025-09-01", "2025-10-09")]},
        [document],
        output,
    )
    assert not wrong_period["content_periods_correct"]
