"""Evidence integrity cannot be supplied by the model's confidence score."""

import json
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_citation_references import page_references
from hushh_mcp.services.drive_packet_contract import (
    DocumentPageFacts,
    PageCitation,
    PricingAssessment,
)
from hushh_mcp.services.drive_packet_intelligence import (
    EvidenceValidationError,
    consolidate_facts,
    construct_packet,
    extract_page_facts,
    verify_packet,
)


def page_facts():
    return {
        "pages": [1, 2],
        "document_type": None,
        "issuer": {"value": "Schwab", "citations": [{"page": 2, "quote": "Schwab"}]},
        "subject": None,
        "account": None,
        "periods": [],
        "topics": [],
        "facts": [],
        "missing_information": [],
        "ambiguous": False,
    }


def wire_page_facts(ref="p2s0"):
    result = page_facts()
    result["issuer"] = {"value": "Schwab", "citation_refs": [ref]}
    return result


async def test_span_references_preserve_all_text_exact_bytes_and_model_values():
    original = "**Table**\r\n₹12,345\tΩ🙂\n" * 600
    pages = [{"page": 7, "text": original, "unit_kind": "text_segment"}]
    encoded, references = page_references(pages)
    assert "text" not in encoded[0]
    assert "".join(span["text"] for span in encoded[0]["text_spans"]) == original
    last_ref = encoded[0]["text_spans"][-1]["ref"]
    answer = wire_page_facts(last_ref)
    answer["pages"] = [7]
    answer["issuer"]["value"] = "Model's unchanged assessment"
    result = await extract_page_facts(
        user_id="owner", pages=pages, interpret=AsyncMock(return_value=answer)
    )
    assert result.issuer.value == answer["issuer"]["value"]
    assert result.issuer.citations[0].model_dump() == references[last_ref]
    assert result.issuer.citations[0].unit_kind == "text_segment"


async def test_consolidation_resolves_only_observed_ids_without_retyping_source_text():
    source = page_facts()
    source["issuer"]["citations"] = [{"page": 2, "quote": "**Schwab**\nAccount\t— 2026"}]
    output = {key: value for key, value in wire_page_facts("c0").items() if key != "pages"}
    output["canonical_packets"] = []
    result = await consolidate_facts(
        user_id="owner",
        previous=None,
        page_facts=[source],
        complete=True,
        interpret=AsyncMock(return_value=output),
    )
    assert result.issuer.citations[0].quote == source["issuer"]["citations"][0]["quote"]


def test_provider_schema_projection_preserves_host_bounds():
    assert "maxLength" not in PageCitation.model_json_schema()["properties"]["quote"]
    with pytest.raises(ValueError):
        PageCitation(page=1, quote="x" * 1001)
    with pytest.raises(ValueError):
        PricingAssessment(
            rubric_version="drive-packet-price-v1",
            useful_scope="single",
            coverage="complete",
            quality="verified",
            rationale="One verified period",
            suggested_price_cents=50001,
        )


@pytest.mark.parametrize("failure", ["invented_reference", "missing_page", "forged_location"])
async def test_extraction_rejects_missing_or_fabricated_evidence(failure):
    result = wire_page_facts()
    if failure == "invented_reference":
        result["issuer"]["citation_refs"] = ["p99s0"]
    elif failure == "missing_page":
        result["pages"] = [2]
    else:
        result["issuer"]["page"] = 99
    with pytest.raises(ValueError):
        await extract_page_facts(
            user_id="owner",
            pages=[
                {"page": 1, "text": "Cover page"},
                {"page": 2, "text": "Schwab statement"},
            ],
            interpret=AsyncMock(return_value=result),
        )


async def test_consolidation_cannot_create_citations_or_packets_before_all_pages():
    pages = page_facts()
    folded = {key: value for key, value in wire_page_facts("c0").items() if key != "pages"}
    folded["canonical_packets"] = []
    assert (
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[pages],
            complete=False,
            interpret=AsyncMock(return_value=folded),
        )
    ).issuer.value == "Schwab"
    folded["canonical_packets"] = [
        {"key": "schwab-2026", "title": "Statements", "description": "Statements"}
    ]
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[pages],
            complete=False,
            interpret=AsyncMock(return_value=folded),
        )
    folded["canonical_packets"] = []
    folded["issuer"] = {"value": "Schwab", "citation_refs": ["c999"]}
    with pytest.raises(EvidenceValidationError, match="model_citation_invalid"):
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[pages],
            complete=True,
            interpret=AsyncMock(return_value=folded),
        )


async def test_checker_cannot_make_incomplete_evidence_ready():
    result = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet={},
            documents=[],
            complete=False,
            interpret=AsyncMock(return_value=result),
        )


@pytest.mark.parametrize(
    "proposal",
    [
        {"decision": "no_match", "selected_document_refs": []},
        {"state": "incomplete", "selected_document_ids": ["source"]},
        {"state": "ready", "selected_document_ids": []},
    ],
)
async def test_correct_abstention_is_not_a_deliverable_ready_packet(proposal):
    result = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            documents=[],
            complete=True,
            interpret=AsyncMock(return_value=result),
        )


@pytest.mark.parametrize("failure", ["schema", "citation"])
async def test_model_regenerates_once_from_same_evidence_and_keeps_validation(failure, caplog):
    bad = wire_page_facts()
    if failure == "schema":
        bad["ambiguous"] = "definitely"
    else:
        bad["issuer"]["citation_refs"] = ["PRIVATE INVENTED REFERENCE"]
    interpreter = AsyncMock(side_effect=[bad, wire_page_facts()])
    pages = [{"page": 1, "text": "Cover"}, {"page": 2, "text": "Schwab statement"}]
    result = await extract_page_facts(user_id="owner", pages=pages, interpret=interpreter)
    assert result.issuer.value == "Schwab"
    prompts = [json.loads(call.kwargs["prompt"]) for call in interpreter.await_args_list]
    assert len(prompts) == 2
    assert prompts[0]["untrusted_pages"] == prompts[1]["untrusted_pages"]
    assert [
        "".join(span["text"] for span in page["text_spans"])
        for page in prompts[0]["untrusted_pages"]
    ] == [page["text"] for page in pages]
    feedback = prompts[1]["validation_feedback"]
    assert feedback["code"] == (
        "model_schema_invalid" if failure == "schema" else "model_citation_invalid"
    )
    assert feedback["attempt"] == 2
    assert prompts[1]["untrusted_rejected_answer"] == bad
    assert "PRIVATE INVENTED REFERENCE" not in caplog.text
    assert "Schwab statement" not in caplog.text


async def test_packet_key_context_cannot_supply_new_document_citations():
    folded = {key: value for key, value in wire_page_facts("c0").items() if key != "pages"}
    folded["canonical_packets"] = []
    folded["issuer"]["citation_refs"] = ["catalog-only"]
    context = {
        "packets": [
            {
                "key": "existing",
                "title": "Prior group",
                "description": "Prior",
                "representative_document": {"issuer": "Catalog only"},
            }
        ],
        "truncated": False,
        "representative_only": True,
        "collection_complete": False,
    }
    interpreter = AsyncMock(return_value=folded)
    with pytest.raises(EvidenceValidationError, match="model_citation_invalid"):
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[page_facts()],
            complete=True,
            canonical_context=context,
            interpret=interpreter,
        )
    payload = json.loads(interpreter.await_args_list[0].kwargs["prompt"])
    assert payload["existing_canonical_packets"] == context


async def test_provider_schema_failure_before_return_has_no_rejected_answer():
    with pytest.raises(ValueError) as failure:
        DocumentPageFacts.model_validate({"ambiguous": "invalid"})
    interpreter = AsyncMock(side_effect=[failure.value, wire_page_facts()])
    result = await extract_page_facts(
        user_id="owner",
        pages=[{"page": 1, "text": "Cover"}, {"page": 2, "text": "Schwab"}],
        interpret=interpreter,
    )
    assert result.issuer.value == "Schwab"
    payload = json.loads(interpreter.await_args_list[1].kwargs["prompt"])
    assert payload["untrusted_rejected_answer"] is None


async def test_repeated_invented_citations_stop_after_two_answers():
    bad = wire_page_facts()
    bad["issuer"]["citation_refs"] = ["invented-reference"]
    interpreter = AsyncMock(return_value=bad)
    with pytest.raises(EvidenceValidationError, match="model_citation_invalid"):
        await extract_page_facts(
            user_id="owner",
            pages=[{"page": 1, "text": "Cover"}, {"page": 2, "text": "Schwab"}],
            interpret=interpreter,
        )
    assert interpreter.await_count == 2


async def test_schema_repair_identifies_citation_bound_without_rejected_values(caplog):
    bad = wire_page_facts()
    bad["issuer"]["citation_refs"] *= 9
    bad["PRIVATE UNKNOWN KEY"] = "PRIVATE REJECTED VALUE"
    interpreter = AsyncMock(side_effect=[bad, wire_page_facts()])
    await extract_page_facts(
        user_id="owner",
        pages=[{"page": 1, "text": "Cover"}, {"page": 2, "text": "Schwab"}],
        interpret=interpreter,
    )
    feedback = json.loads(interpreter.await_args_list[1].kwargs["prompt"])["validation_feedback"]
    assert feedback["issues"] == [
        {
            "path": ["issuer", "citation_refs"],
            "type": "too_long",
            "bounds": {"max_length": 8, "actual_length": 9},
        },
        {"path": ["unknown_field"], "type": "extra_forbidden"},
    ]
    assert "PRIVATE" not in json.dumps(feedback)
    assert "PRIVATE" not in caplog.text


def packet(periods, selected=None):
    return {
        "title": "One statement",
        "description": "Verified statement",
        "state": "ready",
        "selected_document_ids": selected or ["selected"],
        "coverage_summary": "One period",
        "periods": periods,
        "gaps": [],
        "assessment_score": 90,
        "importance": 25,
        "pricing": {
            "rubric_version": "drive-packet-price-v1",
            "useful_scope": "single",
            "coverage": "complete",
            "quality": "verified",
            "rationale": "One supported period",
            "suggested_price_cents": 50,
        },
    }


def period(quote="January 2026"):
    return {"start": "2026-01-01", "end": "2026-01-31", "citations": [{"page": 1, "quote": quote}]}


@pytest.mark.parametrize("quote", ["INJECTED invented coverage", "Unselected document period"])
async def test_packet_rejects_period_citations_outside_selected_source_periods(quote):
    result = packet([period(quote)])
    interpreter = AsyncMock(return_value=result)
    with pytest.raises(EvidenceValidationError, match="model_citation_invalid"):
        await construct_packet(
            user_id="owner",
            key="group",
            complete=True,
            documents=[
                {"document_id": "selected", "facts": {"periods": [period()]}},
                {
                    "document_id": "unselected",
                    "facts": {"periods": [period("Unselected document period")]},
                },
            ],
            interpret=interpreter,
        )
    assert interpreter.await_count == 2


async def test_packet_carries_prior_verified_provenance_only_with_exact_membership():
    previous = packet([period()], ["previous"])
    result = packet([period(), period("Current period")], ["previous", "current"])
    arguments = {
        "user_id": "owner",
        "key": "group",
        "complete": True,
        "previous": previous,
        "documents": [{"document_id": "current", "facts": {"periods": [period("Current period")]}}],
    }
    assert (
        await construct_packet(**arguments, interpret=AsyncMock(return_value=result))
    ).state == "ready"
    result["selected_document_ids"] = ["current"]
    with pytest.raises(EvidenceValidationError, match="model_citation_invalid"):
        await construct_packet(**arguments, interpret=AsyncMock(return_value=result))


async def test_packet_can_replace_prior_copy_with_current_supported_complete_copy():
    previous = packet([period("Earlier copy period")], ["earlier_copy"])
    result = packet([period("Complete copy period")], ["complete_copy"])
    interpreter = AsyncMock(return_value=result)
    answer = await construct_packet(
        user_id="owner",
        key="group",
        complete=True,
        previous=previous,
        documents=[
            {
                "document_id": "complete_copy",
                "facts": {"periods": [period("Complete copy period")]},
            }
        ],
        interpret=interpreter,
    )
    assert answer.selected_document_ids == ["complete_copy"]
    assert answer.state == "ready"
    assert interpreter.await_count == 1


async def test_packet_dropping_one_prior_member_cannot_reuse_unscoped_prior_citation():
    previous = packet([period("Unscoped prior period")], ["prior_kept", "prior_removed"])
    result = packet([period("Unscoped prior period")], ["prior_kept", "current"])
    interpreter = AsyncMock(return_value=result)
    with pytest.raises(EvidenceValidationError, match="model_citation_invalid"):
        await construct_packet(
            user_id="owner",
            key="group",
            complete=True,
            previous=previous,
            documents=[
                {"document_id": "current", "facts": {"periods": [period("Current period")]}}
            ],
            interpret=interpreter,
        )
    assert interpreter.await_count == 2
