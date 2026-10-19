"""Evidence integrity cannot be supplied by the model's confidence score."""

import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic_core import PydanticCustomError

from hushh_mcp.services import drive_packet_intelligence
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


def test_facts_policy_changes_with_extraction_profile(monkeypatch):
    current = drive_packet_intelligence.facts_policy_version()
    monkeypatch.setattr(
        drive_packet_intelligence, "EXTRACTION_PROFILE", "future-extraction-profile"
    )
    assert drive_packet_intelligence.facts_policy_version() != current


def test_request_validation_feedback_never_exposes_values_prose_or_extra_field_names():
    from hushh_mcp.services.drive_request_model_feedback import validation_feedback

    class Row(BaseModel):
        model_config = ConfigDict(extra="forbid")
        amount: int

    class Response(BaseModel):
        records: list[Row]

    private = "PRIVATE_SOURCE_AND_PROVIDER_PROSE"
    with pytest.raises(ValidationError) as caught:
        Response.model_validate({"records": [{"amount": private, private: private}] * 12})
    result = validation_feedback(caught.value, schema=Response)
    assert len(result["issues"]) == 8
    assert result["issues"][0] == {
        "location": ["records", 0, "amount"],
        "type": "int_parsing",
    }
    assert result["issues"][1] == {"location": ["records", 0], "type": "extra_forbidden"}
    assert private not in json.dumps(result)
    hostile = ValidationError.from_exception_data(
        "Synthetic",
        [
            {
                "type": PydanticCustomError(private, private, {"private": private}),
                "loc": ("records", 1000000, private),
                "input": private,
            }
        ],
    )
    assert validation_feedback(hostile, schema=Response)["issues"] == [
        {"location": ["records"], "type": "validation_error"}
    ]
    assert validation_feedback(ValueError(private), schema=Response) == {
        "code": "invalid_model_output",
        "issues": [],
    }


def _request_planner_response():
    return {
        "subject_scope": "specific_records",
        "subject_complete": True,
        "semantic_intent": "other",
        "discovery_clues": ["Alpine Subject"],
        "required_entities": ["Alpine Subject"],
        "expected_document_anatomy": "Substantive source discussion of the requested subject.",
        "semantic_query": {
            "version": 1,
            "status": "ready",
            "metadata_listing": False,
            "date_basis": "title_created_modified",
            "clarification": None,
            "clauses": [
                {
                    "predicates": [
                        {
                            "id": "subject",
                            "kind": "entity",
                            "value": "Alpine Subject",
                            "match": "phrase",
                            "negated": False,
                            "discovery_terms": [],
                        }
                    ]
                }
            ],
        },
    }


def test_semantic_planner_feedback_identifies_safe_cross_field_rule_without_values():
    from hushh_mcp.services.drive_request_model_feedback import validation_feedback
    from hushh_mcp.services.drive_suggestion_service import SemanticLiveSearchModelPlan

    private = "PRIVATE_UNSEEN_PERSON"
    invalid = _request_planner_response()
    invalid["terms"] = [private]
    invalid["term_groups"] = [["Different Subject"]]
    with pytest.raises(ValidationError) as caught:
        SemanticLiveSearchModelPlan.model_validate(invalid)
    feedback = validation_feedback(caught.value, schema=SemanticLiveSearchModelPlan)
    assert feedback["issues"] == [{"location": [], "type": "drive_term_group_canonical_mismatch"}]
    assert private not in json.dumps(feedback)

    invalid = _request_planner_response()
    invalid["subject_scope"] = "metadata_listing"
    with pytest.raises(ValidationError) as caught:
        SemanticLiveSearchModelPlan.model_validate(invalid)
    assert validation_feedback(caught.value, schema=SemanticLiveSearchModelPlan)["issues"] == [
        {"location": [], "type": "drive_semantic_scope_mismatch"}
    ]


async def test_request_planner_asks_valid_output_once_and_corrects_only_schema_failures():
    from hushh_mcp.services.drive_suggestion_service import plan_semantic_live_search

    original = '{"document_request":{"purpose":"Alpine Subject agreements excluding drafts"}}'
    response = _request_planner_response()
    valid = AsyncMock(return_value=response)
    result = await plan_semantic_live_search(valid, prompt=original, user_id="synthetic")
    assert result.semantic_query.clauses[0].predicates[0].value == "Alpine Subject"
    valid.assert_awaited_once_with(prompt=original, user_id="synthetic")
    invalid = json.loads(json.dumps(response))
    private = "PRIVATE_MODEL_VALUE_AND_EXTRA_FIELD"
    invalid["semantic_query"]["clauses"][0]["predicates"][0]["negated"] = private
    invalid[private] = private
    planner = AsyncMock(side_effect=[invalid, response])
    await plan_semantic_live_search(planner, prompt=original, user_id="synthetic")
    first, second = planner.await_args_list
    assert first.kwargs["prompt"] == original
    request, feedback = second.kwargs["prompt"].split("\n\nplanner_validation_feedback: ")
    assert request == original
    parsed = json.loads(feedback)
    assert parsed["issues"][0] == {
        "location": ["semantic_query", "clauses", 0, "predicates", 0, "negated"],
        "type": "bool_type",
    }
    assert private not in feedback


@pytest.mark.parametrize(
    "status", [429, 500, 503, 401, 403, 400, "timeout", "config", "value_error"]
)
async def test_request_planner_transport_retry_keeps_original_prompt_and_auth_fails_closed(
    monkeypatch, status
):
    from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
    from hushh_mcp.services import drive_suggestion_service as suggestions

    fault = TimeoutError() if status == "timeout" else RuntimeError("PRIVATE_PROVIDER_PROSE")
    if isinstance(status, int):
        fault.code = status
    transport = SpecialistAdkTurnError(None)
    transport.__cause__ = fault
    if status == "value_error":
        transport = ValueError("PRIVATE_CONFIG_PROSE")
    original = '{"document_request":{"purpose":"Alpine Subject agreements excluding drafts"}}'
    planner = AsyncMock(side_effect=[transport, _request_planner_response()])
    sleep = AsyncMock()
    monkeypatch.setattr(suggestions.asyncio, "sleep", sleep)
    if status in {429, 500, 503, "timeout"}:
        await suggestions.plan_semantic_live_search(planner, prompt=original, user_id="synthetic")
        assert planner.await_count == 2
        assert [call.kwargs["prompt"] for call in planner.await_args_list] == [original, original]
    else:
        with pytest.raises(ValueError if status == "value_error" else SpecialistAdkTurnError):
            await suggestions.plan_semantic_live_search(
                planner, prompt=original, user_id="synthetic"
            )
        planner.assert_awaited_once_with(prompt=original, user_id="synthetic")
    if status in {429, 500, 503}:
        sleep.assert_awaited_once_with(1.0)
    else:
        sleep.assert_not_awaited()


# Every input below feeds facts_policy_version(). Any edit, even a comment,
# re-queues facts for every extracted Drive file and makes every packet version
# policy-stale until facts run again. Update a pin only on purpose, ship all
# bumps in one release, and name the bump and its re-queued count in the PR.
FACTS_POLICY_INPUTS = {
    "hushh_mcp/agents/documents/agent.yaml": (
        "c8fae4e1a958af32cfa416de1cd6a04bd00b12ebcc73a0d7952860416e4e0f61"
    ),
    "hushh_mcp/services/drive_packet_contract.py": (
        "ef981abc2f54055e79ba52b8560b404b6624295183c164085ca4cdcbb84491b8"
    ),
    "hushh_mcp/services/drive_citation_references.py": (
        "495762e617c36bd62f0dec8ddc998e49a4994707e2d2eb344f281117c44f6309"
    ),
}


def test_facts_policy_inputs_are_pinned():
    root = Path(drive_packet_intelligence.__file__).resolve().parents[2]
    assert {
        path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in FACTS_POLICY_INPUTS
    } == FACTS_POLICY_INPUTS, "facts policy bump: every extracted file re-queues for facts"
    assert drive_packet_intelligence.FACTS_SCHEMA_VERSION == "document-facts-v6-record-status"
    assert drive_packet_intelligence.EXTRACTION_PROFILE == (
        "drive-pages-v2:pdfplumber-0.11.10:pdfium:tesseract-5-eng:ocr-signal"
    )


def page_facts():
    return {
        "pages": [1, 2],
        "document_type": None,
        "issuer": {"value": "Schwab", "citations": [{"page": 2, "quote": "Schwab"}]},
        "subject": None,
        "account": None,
        "periods": [],
        "date_evidence": [],
        "record_status": {
            "status": "unknown",
            "evidence_basis": "unknown",
            "explanation": "No execution status is established.",
            "citations": [],
        },
        "topics": [],
        "facts": [],
        "missing_information": [],
        "ambiguous": False,
    }


def wire_page_facts(ref="p2s0"):
    result = page_facts()
    result["issuer"] = {"value": "Schwab", "citation_refs": [ref]}
    result["record_status"].pop("citations")
    result["record_status"]["citation_refs"] = []
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
        "correct_record_status": True,
        "correct_standalone_value": True,
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
        "correct_record_status": True,
        "correct_standalone_value": True,
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
        "temporal_scope": "document_period" if periods else "no_period_claim",
        "gaps": [],
        "assessment_score": 90,
        "importance": 25,
        "standalone_value": "supported",
        "utility_rationale": "A verified statement with a clear recipient use",
        "pricing": {
            "rubric_version": "drive-packet-price-v1",
            "useful_scope": "single",
            "coverage": "complete",
            "quality": "verified",
            "rationale": "One supported period",
            "suggested_price_cents": 50,
        },
    }


def test_standalone_value_gate_keeps_substantive_records_and_qualified_drafts():
    from hushh_mcp.services.drive_packet_contract import PacketProposal

    financial = packet([period()])
    financial["title"] = "Internal financial report · January 2026"
    assert PacketProposal.model_validate(financial).state == "ready"

    draft = packet([])
    draft["title"] = "Draft business brief"
    draft["description"] = "A clearly labeled draft with substantive analysis"
    assert PacketProposal.model_validate(draft).state == "ready"

    for source_title in ("Diagnostic projection", "Developer test script"):
        artifact = packet([])
        artifact.update(
            title=source_title,
            standalone_value="unsupported",
            utility_rationale="Only source-workflow diagnostics, without a standalone record",
        )
        with pytest.raises(ValueError, match="ready packet requires supported standalone value"):
            PacketProposal.model_validate(artifact)
        artifact["state"] = "incomplete"
        assert PacketProposal.model_validate(artifact).state == "incomplete"


def test_invite_metadata_cannot_verify_as_meeting_notes():
    from hushh_mcp.services.drive_packet_contract import PacketVerificationProposal

    verdict = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": False,
        "correct_record_status": True,
        "correct_standalone_value": False,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    with pytest.raises(ValueError, match="checker cannot declare unresolved packet ready"):
        PacketVerificationProposal.model_validate(verdict)
    verdict.update(state="unable_to_verify", issues=["Invite contains no meeting notes"])
    assert PacketVerificationProposal.model_validate(verdict).state == "unable_to_verify"


def period(quote="January 2026"):
    return {"start": "2026-01-01", "end": "2026-01-31", "citations": [{"page": 1, "quote": quote}]}


@pytest.mark.parametrize("quote", ["INJECTED invented coverage", "Unselected document period"])
async def test_packet_rejects_period_citations_outside_selected_source_periods(quote):
    result = packet([period(quote)])
    result["excluded_documents"] = [exclusion("unselected")]
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
    result = packet([period(), period("Current period Jan 2026")], ["previous", "current"])
    arguments = {
        "user_id": "owner",
        "key": "group",
        "complete": True,
        "previous": previous,
        "documents": [
            {"document_id": "current", "facts": {"periods": [period("Current period Jan 2026")]}}
        ],
    }
    assert (
        await construct_packet(**arguments, interpret=AsyncMock(return_value=result))
    ).state == "ready"
    result["selected_document_ids"] = ["current"]
    result["excluded_documents"] = [exclusion("previous")]
    with pytest.raises(EvidenceValidationError, match="model_citation_invalid"):
        await construct_packet(**arguments, interpret=AsyncMock(return_value=result))


async def test_packet_can_replace_prior_copy_with_current_supported_complete_copy():
    previous = packet([period("Earlier copy period")], ["earlier_copy"])
    result = packet([period("Complete copy period Jan 2026")], ["complete_copy"])
    result["excluded_documents"] = [exclusion("earlier_copy", duplicate_of="complete_copy")]
    interpreter = AsyncMock(return_value=result)
    answer = await construct_packet(
        user_id="owner",
        key="group",
        complete=True,
        previous=previous,
        documents=[
            {
                "document_id": "complete_copy",
                "facts": {"periods": [period("Complete copy period Jan 2026")]},
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
    result["excluded_documents"] = [exclusion("prior_removed")]
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


def exclusion(document_id, *, duplicate_of=None):
    return {
        "document_id": document_id,
        "reason": "duplicate" if duplicate_of else "outside_group",
        "explanation": "Synthetic exclusion evidence for validation test",
        "duplicate_of_document_id": duplicate_of,
    }


@pytest.mark.parametrize("omission", ["silent", "invented", "conflicting", "prior_exclusion"])
async def test_packet_requires_every_candidate_selected_or_explained(omission):
    previous = None
    result = packet([], ["june"])
    documents = [{"document_id": ref, "facts": {"periods": []}} for ref in ["june", "july"]]
    if omission == "invented":
        result["excluded_documents"] = [exclusion("july"), exclusion("invented")]
    elif omission == "conflicting":
        result["excluded_documents"] = [exclusion("june"), exclusion("july")]
    elif omission == "prior_exclusion":
        previous = packet([], ["june"])
        previous["excluded_documents"] = [exclusion("old_copy", duplicate_of="june")]
        result["selected_document_ids"] = ["june", "july"]
    with pytest.raises(EvidenceValidationError):
        await construct_packet(
            user_id="owner",
            key="same-account-2016",
            documents=documents,
            complete=True,
            previous=previous,
            interpret=AsyncMock(return_value=result),
        )


async def test_checker_cannot_mark_unaccounted_month_ready():
    result = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_record_status": True,
        "correct_standalone_value": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    with pytest.raises(EvidenceValidationError, match="model_membership_invalid"):
        await verify_packet(
            user_id="owner",
            packet=packet([], ["june"]),
            documents=[{"document_id": "june"}, {"document_id": "july"}],
            complete=True,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=result),
        )


def test_ready_packet_cannot_hide_unverifiable_member():
    from hushh_mcp.services.drive_packet_contract import PacketAssessment

    result = packet([], ["june"])
    result["excluded_documents"] = [{**exclusion("july"), "reason": "unverifiable"}]
    with pytest.raises(ValueError, match="ready packet requires complete evidence"):
        PacketAssessment.model_validate(result)


def dated_evidence(role="event"):
    return {
        "role": role,
        "start": "2027-06-03",
        "end": "2027-06-05" if role != "as_of" else "2027-06-03",
        "meaning": "Conference dates; draft posting days have no absolute calendar anchors",
        "citations": [{"page": 1, "quote": "Conference June 3–5, 2027. Drafts: Day 1, Day 2."}],
    }


async def test_date_roles_resolve_exact_source_without_turning_event_into_coverage():
    source = dated_evidence()
    answer = wire_page_facts()
    answer.update(pages=[1], issuer=None)
    answer["date_evidence"] = [
        {
            **{key: value for key, value in source.items() if key != "citations"},
            "citation_refs": ["p1s0"],
        }
    ]
    result = await extract_page_facts(
        user_id="owner",
        pages=[{"page": 1, "text": source["citations"][0]["quote"]}],
        interpret=AsyncMock(return_value=answer),
    )
    assert result.periods == []
    assert result.date_evidence[0].model_dump(exclude_defaults=True) == source


async def test_consolidation_cannot_promote_exact_event_quote_to_coverage():
    observed = page_facts()
    observed["date_evidence"] = [dated_evidence()]
    answer = {key: value for key, value in wire_page_facts("c0").items() if key != "pages"}
    answer["canonical_packets"] = []
    answer["periods"] = [{"start": "2027-06-03", "end": "2027-06-05", "citation_refs": ["c1"]}]
    # c0 is the issuer, c1 is the exact event quote: citation validity alone
    # previously allowed this semantic promotion.
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[observed],
            complete=True,
            interpret=AsyncMock(return_value=answer),
        )


async def test_packet_cannot_change_coverage_endpoints_using_a_valid_quote():
    result = packet([{**period(), "end": "2026-12-31"}])
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await construct_packet(
            user_id="owner",
            key="statements",
            complete=True,
            documents=[{"document_id": "selected", "facts": {"periods": [period()]}}],
            interpret=AsyncMock(return_value=result),
        )


async def test_undated_drafts_remain_useful_ready_packet_without_period_pricing():
    result = packet([])
    result.update(title="Conference post drafts", coverage_summary="Two draft posts")
    result["pricing"]["rationale"] = "Two reusable drafts, with no publication schedule claimed"
    arguments = dict(
        user_id="owner",
        key="conference-drafts",
        complete=True,
        documents=[
            {
                "document_id": "selected",
                "facts": {"periods": [], "date_evidence": [dated_evidence()]},
            }
        ],
    )
    ready = await construct_packet(**arguments, interpret=AsyncMock(return_value=result))
    assert ready.state == "ready" and ready.periods == []
    result["pricing"]["useful_scope"] = "period"
    with pytest.raises(EvidenceValidationError, match="model_schema_invalid"):
        await construct_packet(**arguments, interpret=AsyncMock(return_value=result))


@pytest.mark.parametrize("role,accepted", [("as_of", True), ("event", False)])
async def test_snapshot_requires_evidenced_snapshot_date(role, accepted):
    result = packet([])
    result["temporal_scope"] = "as_of_snapshot"
    arguments = dict(
        user_id="owner",
        key="snapshot",
        complete=True,
        documents=[
            {
                "document_id": "selected",
                "facts": {"periods": [], "date_evidence": [dated_evidence(role)]},
            }
        ],
        interpret=AsyncMock(return_value=result),
    )
    if accepted:
        assert (await construct_packet(**arguments)).state == "ready"
    else:
        with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
            await construct_packet(**arguments)


async def test_requested_wire_date_cannot_become_a_ready_snapshot_or_completed_transfer():
    source = {
        "document_id": "selected",
        "facts": {
            "periods": [],
            # The earlier model incorrectly called a requested transfer date as_of.
            # Even that incorrect role cannot establish a packet snapshot.
            "date_evidence": [dated_evidence("as_of")],
            "record_status": {
                "status": "requested",
                "evidence_basis": "documentary_form",
                "explanation": "The source is a transfer request, with no completion evidence.",
                "citations": [{"page": 1, "quote": "Wire request"}],
            },
            "facts": [{"value": "A transfer was requested"}],
        },
    }
    proposal = packet([])
    proposal.update(
        title="Requested wire transfer",
        description="Requested transfer instruction; completion unverified",
        coverage_summary="Request date only; completion unverified",
    )
    proposal["pricing"]["rationale"] = "Verified request document only"
    verdict = dict(
        state="ready",
        correct_subject_and_account=True,
        correct_issuer_and_type=True,
        correct_record_status=True,
        correct_standalone_value=True,
        correct_coverage=True,
        no_unrelated_inclusions=True,
        no_unexplained_omissions=True,
        issues=[],
    )
    proposal["temporal_scope"] = "as_of_snapshot"
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await construct_packet(
            user_id="owner",
            key="wire-request",
            complete=True,
            documents=[source],
            interpret=AsyncMock(return_value=proposal),
        )
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            documents=[source],
            complete=True,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )

    proposal["temporal_scope"] = "no_period_claim"
    proposal["title"] = "Executed wire transfer"
    proposal["description"] = "Requested transfer was executed"
    proposal["coverage_summary"] = "Bank debited the account"
    proposal["pricing"]["rationale"] = "Payment went through"
    proposal["utility_rationale"] = "Settlement confirmed"
    normalized = await construct_packet(
        user_id="owner",
        key="wire-request",
        complete=True,
        documents=[source],
        interpret=AsyncMock(return_value=proposal),
    )
    assert normalized.state == "ready"
    assert normalized.title == "Request documents"
    assert normalized.description == "Documents recording requests; completion is unverified."
    assert normalized.coverage_summary == (
        "Request records only; no completed action or reporting period verified."
    )
    assert normalized.pricing.rationale == (
        "Estimate for request documents only; completion is unverified."
    )
    assert "executed" not in normalized.model_dump_json()
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            documents=[source],
            complete=True,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )
    assert (
        await verify_packet(
            user_id="owner",
            packet=normalized.model_dump(),
            documents=[source],
            complete=True,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )
    ).state == "ready"
    for claim in (
        "not executed, funds moved",
        "not completed, settlement confirmed",
        "settlement confirmed by bank",
        "payment went through",
        "unverified request, funds moved",
        "no evidence of execution, funds moved",
        "bank debited account",
        "remittance confirmed",
        "funds subsequently arrived",
    ):
        proposal["description"] = f"Requested transfer: {claim}"
        cleaned = await construct_packet(
            user_id="owner",
            key="wire-request",
            complete=True,
            documents=[source],
            interpret=AsyncMock(return_value=proposal),
        )
        assert cleaned.model_dump() == normalized.model_dump()
        with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
            await verify_packet(
                user_id="owner",
                packet=proposal,
                documents=[source],
                complete=True,
                batch_scope={"mode": "complete_compact_summary"},
                interpret=AsyncMock(return_value=verdict),
            )
    source["facts"]["document_type"] = {"value": "Wire transfer request form"}
    wire_copy = await construct_packet(
        user_id="owner",
        key="wire-request",
        complete=True,
        documents=[source],
        interpret=AsyncMock(return_value=proposal),
    )
    assert wire_copy.title == "Wire transfer requests"
    assert wire_copy.description == (
        "Documents requesting a wire transfer; execution is unverified."
    )
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    full_source = {
        **source,
        "source_version": "v1",
        "complete": True,
        "facts": {
            **source["facts"],
            "issuer": None,
            "subject": None,
            "account": None,
            "topics": [],
            "ambiguous": False,
            "missing_information": [],
        },
    }
    assert (
        await verify_packet(
            user_id="owner",
            packet=wire_copy.model_dump(),
            documents=[compact_evidence(full_source)],
            complete=True,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )
    ).state == "ready"


async def test_request_only_packet_keeps_bounded_copy_and_no_period_claim_at_every_state():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    facts = page_facts()
    facts.pop("pages")
    facts["document_type"] = {
        "value": "Wire transfer request form",
        "citations": [{"page": 1, "quote": "Wire transfer request form"}],
    }
    # The earlier model mislabeled the requested date as_of; the fence cannot rely on it.
    facts["date_evidence"] = [dated_evidence("as_of")]
    facts["record_status"] = {
        "status": "requested",
        "evidence_basis": "documentary_form",
        "explanation": "The source is a transfer request, with no completion evidence.",
        "citations": [{"page": 1, "quote": "Wire transfer request form"}],
    }
    facts["facts"] = [
        {"value": "A transfer was requested", "citations": [{"page": 1, "quote": "Amount"}]}
    ]
    source = {"document_id": "selected", "source_version": "v1", "complete": True, "facts": facts}
    bounded = {
        "title": "Wire transfer requests",
        "description": "Documents requesting a wire transfer; execution is unverified.",
        "coverage_summary": "Request records only; no completed action or reporting period verified.",
        "utility_rationale": "Request documents are useful as records; completion is unverified.",
    }
    proposal = packet([])
    proposal.update(
        state="incomplete",
        gaps=["The bank confirmation page is missing."],
        title="Executed wire transfer",
        description="Requested transfer was executed",
        coverage_summary="Bank debited the account",
        utility_rationale="Settlement confirmed",
    )
    proposal["pricing"].update(
        coverage="partial", quality="limited", rationale="Payment went through"
    )
    verdict = dict(
        state="incomplete",
        correct_subject_and_account=True,
        correct_issuer_and_type=True,
        correct_record_status=False,
        correct_standalone_value=True,
        correct_coverage=False,
        no_unrelated_inclusions=True,
        no_unexplained_omissions=True,
        issues=["Completion is not evidenced."],
    )

    # An unfinished assembly is never Ready, but the owner still sees its copy.
    for complete in (False, True):
        normalized = await construct_packet(
            user_id="owner",
            key="wire-request",
            complete=complete,
            documents=[source],
            interpret=AsyncMock(return_value=proposal),
        )
        assert normalized.state == "incomplete"
        assert normalized.gaps == proposal["gaps"]
        assert {key: getattr(normalized, key) for key in bounded} == bounded
        assert normalized.pricing.rationale == (
            "Estimate for request documents only; completion is unverified."
        )
        assert "executed" not in normalized.model_dump_json()

    # The final checker refuses the model's wording whatever its own verdict.
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            documents=[compact_evidence(source)],
            complete=False,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )
    checked = await verify_packet(
        user_id="owner",
        packet=normalized.model_dump(),
        documents=[compact_evidence(source)],
        complete=False,
        batch_scope={"mode": "complete_compact_summary"},
        interpret=AsyncMock(return_value=verdict),
    )
    assert checked.state == "incomplete"

    # A request date is no snapshot or period for an Incomplete version either.
    proposal["temporal_scope"] = "as_of_snapshot"
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await construct_packet(
            user_id="owner",
            key="wire-request",
            complete=False,
            documents=[source],
            interpret=AsyncMock(return_value=proposal),
        )
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await verify_packet(
            user_id="owner",
            packet={**normalized.model_dump(), "temporal_scope": "as_of_snapshot"},
            documents=[compact_evidence(source)],
            complete=False,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )

    # An undecided scope claims nothing; the bounded copy still applies.
    proposal["temporal_scope"] = "unknown"
    undecided = await construct_packet(
        user_id="owner",
        key="wire-request",
        complete=False,
        documents=[source],
        interpret=AsyncMock(return_value=proposal),
    )
    assert undecided.temporal_scope == "unknown"
    assert undecided.title == bounded["title"]

    # A completed record beside the request may evidence execution: the mix is
    # not request-only, so an Incomplete version keeps the model's own copy.
    posted = {
        **source,
        "document_id": "posted",
        "facts": {**facts, "record_status": {**facts["record_status"], "status": "completed"}},
    }
    proposal.update(temporal_scope="no_period_claim", selected_document_ids=["selected", "posted"])
    mixed = await construct_packet(
        user_id="owner",
        key="wire-request",
        complete=True,
        documents=[source, posted],
        interpret=AsyncMock(return_value=proposal),
    )
    assert mixed.state == "incomplete"
    assert mixed.title == "Executed wire transfer"


async def test_final_checker_cannot_certify_event_as_document_period():
    event = dated_evidence()
    proposal = packet(
        [{key: value for key, value in event.items() if key in {"start", "end", "citations"}}]
    )
    verdict = dict(
        state="ready",
        correct_subject_and_account=True,
        correct_issuer_and_type=True,
        correct_record_status=True,
        correct_standalone_value=True,
        correct_coverage=True,
        no_unrelated_inclusions=True,
        no_unexplained_omissions=True,
        issues=[],
    )
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            complete=True,
            documents=[{"document_id": "selected", "periods": [], "date_evidence": [event]}],
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )


async def test_auto_packet_requires_substantive_source_evidence_not_invite_metadata():
    verdict = dict(
        state="ready",
        correct_subject_and_account=True,
        correct_issuer_and_type=True,
        correct_record_status=True,
        correct_standalone_value=True,
        correct_coverage=True,
        no_unrelated_inclusions=True,
        no_unexplained_omissions=True,
        issues=[],
    )
    invitation = packet([])
    invitation["title"] = "Meeting notes"
    documents = [
        {
            "document_id": "selected",
            "document_type": "event invitation",
            "periods": [],
            "date_evidence": [dated_evidence("event")],
            "facts": [],
        }
    ]
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet=invitation,
            complete=True,
            documents=documents,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )

    draft = packet([])
    draft.update(title="Draft business brief", description="Substantive draft analysis")
    documents[0].update(document_type="business brief", facts=["Cited draft analysis"])
    assert (
        await verify_packet(
            user_id="owner",
            packet=draft,
            complete=True,
            documents=documents,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )
    ).state == "ready"

    financial = packet([period()])
    documents[0].update(document_type="financial report", facts=[], periods=[period()])
    assert (
        await verify_packet(
            user_id="owner",
            packet=financial,
            complete=True,
            documents=documents,
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )
    ).state == "ready"

    # An explicit buyer request is judged against that request, not against
    # the automatic catalog's standalone-value requirement.
    requested_script = {
        "decision": "ready",
        "selected_document_refs": ["selected"],
        "request": {"purpose": "the source script"},
    }
    documents[0].update(document_type="source script", facts=[], periods=[])
    assert (
        await verify_packet(
            user_id="owner",
            packet=requested_script,
            complete=True,
            documents=documents,
            batch_scope={"kind": "final_summary"},
            interpret=AsyncMock(return_value=verdict),
        )
    ).state == "ready"


async def test_global_checker_preserves_snapshot_role_and_event_qualification():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    evidence = page_facts()
    evidence.pop("pages")
    evidence["date_evidence"] = [dated_evidence("as_of"), dated_evidence("event")]
    evidence["facts"] = [
        {"value": "A substantive draft position", "citations": [{"page": 1, "quote": "Cover"}]}
    ]
    evidence["record_status"] = {
        "status": "draft",
        "evidence_basis": "documentary_form",
        "explanation": "A draft with typed signature placeholders; execution is not established.",
        "citations": [{"page": 1, "quote": "Draft — Witness: [name]"}],
    }
    summary = compact_evidence(
        {
            "document_id": "selected",
            "source_version": "v1",
            "complete": True,
            "facts": evidence,
        }
    )
    assert summary["periods"] == []
    assert summary["record_status"] == evidence["record_status"]
    assert summary["date_evidence"] == [
        {key: item[key] for key in ("role", "start", "end", "meaning")}
        for item in evidence["date_evidence"]
    ]
    proposal = packet([])
    proposal["temporal_scope"] = "as_of_snapshot"
    verdict = dict(
        state="ready",
        correct_subject_and_account=True,
        correct_issuer_and_type=True,
        correct_record_status=True,
        correct_standalone_value=True,
        correct_coverage=True,
        no_unrelated_inclusions=True,
        no_unexplained_omissions=True,
        issues=[],
    )
    checker = AsyncMock(return_value=verdict)
    result = await verify_packet(
        user_id="owner",
        packet=proposal,
        complete=True,
        documents=[summary],
        batch_scope={"mode": "complete_compact_summary"},
        interpret=checker,
    )
    assert result.state == "ready"
    payload = json.loads(checker.await_args.kwargs["prompt"])
    assert payload["document_facts"][0]["date_evidence"] == summary["date_evidence"]
    assert payload["document_facts"][0]["record_status"] == evidence["record_status"]

    # A positive score on every other axis cannot override the current
    # checker's explicit rejection of the packet's execution/status claim.
    verdict["correct_record_status"] = False
    with pytest.raises(EvidenceValidationError):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            complete=True,
            documents=[summary],
            batch_scope={"mode": "complete_compact_summary"},
            interpret=AsyncMock(return_value=verdict),
        )


async def test_request_checker_accepts_bounded_financial_coverage_with_request_context():
    proposal = packet([period()])
    request = {
        "purpose": "January statements",
        "periodStart": "2026-01-05",
        "periodEnd": "2026-01-20",
    }
    proposal["document_request"] = request
    verdict = dict(
        state="ready",
        correct_subject_and_account=True,
        correct_issuer_and_type=True,
        correct_record_status=True,
        correct_standalone_value=True,
        correct_coverage=True,
        no_unrelated_inclusions=True,
        no_unexplained_omissions=True,
        issues=[],
    )
    checker = AsyncMock(return_value=verdict)
    documents = [
        {
            "document_id": "selected",
            "content_periods": [{"start": "2026-01-01", "end": "2026-01-31"}],
        }
    ]
    result = await verify_packet(
        user_id="owner",
        packet=proposal,
        complete=True,
        documents=documents,
        batch_scope="complete_current_request_packet",
        interpret=checker,
    )
    assert result.state == "ready"
    assert (
        json.loads(checker.await_args.kwargs["prompt"])["proposed_packet"]["document_request"]
        == request
    )
    documents[0]["content_periods"] = []
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            complete=True,
            documents=documents,
            batch_scope="complete_current_request_packet",
            interpret=checker,
        )


def test_legacy_manifest_remains_readable_but_new_ready_proposal_requires_typed_scope():
    from hushh_mcp.services.drive_packet_contract import PacketAssessment, PacketProposal

    legacy = packet([])
    legacy.pop("temporal_scope")
    assert PacketAssessment.model_validate(legacy).temporal_scope == "unknown"
    with pytest.raises(ValueError):
        PacketProposal.model_validate(legacy)
    with pytest.raises(ValueError):
        PacketProposal.model_validate({**legacy, "temporal_scope": "unknown"})


# Runtime Ready guards for two incident classes seen in the read-only Drive
# eval (the eval package's adversarial cases same-pdf-twice and
# period-from-modified-date, tracked there as strict expected failures by a
# known_gap field; drop those two fields once that package lands). The same
# checks run at both deterministic gates a packet passes before
# DrivePacketStore.finalize_packet can mark it Ready.


def statement_facts(period_quote="Statement period September 1, 2026 to September 30, 2026"):
    facts = page_facts()
    facts.pop("pages")
    facts.update(
        document_type={
            "value": "Monthly statement",
            "citations": [{"page": 1, "quote": "Monthly statement"}],
        },
        issuer={"value": "Example Bank", "citations": [{"page": 1, "quote": "Example Bank"}]},
        account={
            "value": "Account ending 1122",
            "citations": [{"page": 1, "quote": "Account ending 1122"}],
        },
        periods=[
            {
                "start": "2026-09-01",
                "end": "2026-09-30",
                "citations": [{"page": 1, "quote": period_quote}],
            }
        ],
        facts=[
            {
                "value": "Ending balance $1,000.00",
                "citations": [{"page": 1, "quote": "Ending balance $1,000.00"}],
            }
        ],
    )
    return facts


def statement_member(document_id, facts=None, **extra):
    return {
        "document_id": document_id,
        "source_version": "7",
        "complete": True,
        "facts": facts or statement_facts(),
        **extra,
    }


def statement_packet(selected, periods):
    result = packet(periods, selected)
    result.update(title="Example Bank statements", description="Monthly statements for one account")
    return result


def ready_verdict():
    return dict(
        state="ready",
        correct_subject_and_account=True,
        correct_issuer_and_type=True,
        correct_record_status=True,
        correct_standalone_value=True,
        correct_coverage=True,
        no_unrelated_inclusions=True,
        no_unexplained_omissions=True,
        issues=[],
    )


@pytest.mark.parametrize("signal", ["content_digest", "identical_evidence"])
async def test_ready_packet_cannot_select_the_same_content_twice(signal):
    # One original stored twice is one source. The host decides this from the
    # evidence; the model's confidence cannot make both copies Ready members.
    copies = [statement_member("copy_a"), statement_member("copy_b")]
    if signal == "content_digest":
        for copy in copies:
            copy["content_digest"] = "a" * 32
        # A noisier second extraction of the same bytes is still the same original.
        copies[1]["facts"]["facts"] = []
    arguments = dict(user_id="owner", key="statements", complete=True, documents=copies)
    both = statement_packet(["copy_a", "copy_b"], [statement_facts()["periods"][0]])
    interpreter = AsyncMock(return_value=both)
    with pytest.raises(EvidenceValidationError, match="model_membership_invalid") as info:
        await construct_packet(**arguments, interpret=interpreter)
    assert interpreter.await_count == 2
    # The retry names the members that share content, so the model can keep one.
    assert info.value.issues == [
        {"field": "selected_document_ids", "duplicate_content": ["copy_a", "copy_b"]}
    ]
    feedback = json.loads(interpreter.await_args.kwargs["prompt"])["validation_feedback"]
    assert feedback["issues"] == info.value.issues

    # The contract's own answer: keep one copy and exclude the other as its duplicate.
    deduped = statement_packet(["copy_a"], [statement_facts()["periods"][0]])
    deduped["excluded_documents"] = [exclusion("copy_b", duplicate_of="copy_a")]
    answer = await construct_packet(**arguments, interpret=AsyncMock(return_value=deduped))
    assert answer.state == "ready" and answer.selected_document_ids == ["copy_a"]


async def test_distinct_statements_remain_ready_together():
    october = statement_facts("Statement period October 1, 2026 to October 31, 2026")
    october["periods"][0].update(start="2026-10-01", end="2026-10-31")
    october["facts"][0] = {
        "value": "Ending balance $1,250.00",
        "citations": [{"page": 1, "quote": "Ending balance $1,250.00"}],
    }
    documents = [
        statement_member("september", content_digest="a" * 32),
        statement_member("october", october, content_digest="b" * 32),
    ]
    result = statement_packet(
        ["september", "october"], [statement_facts()["periods"][0], october["periods"][0]]
    )
    answer = await construct_packet(
        user_id="owner",
        key="statements",
        complete=True,
        documents=documents,
        interpret=AsyncMock(return_value=result),
    )
    assert answer.state == "ready" and answer.selected_document_ids == ["september", "october"]


async def test_final_checker_cannot_verify_the_same_content_twice_as_ready():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    copies = [
        statement_member("copy_a", content_digest="a" * 32),
        statement_member("copy_b", content_digest="a" * 32),
    ]
    documents = [compact_evidence(copy) for copy in copies]
    assert [item["content_digest"] for item in documents] == ["a" * 32, "a" * 32]
    arguments = dict(
        user_id="owner",
        documents=documents,
        complete=True,
        batch_scope={"mode": "complete_compact_summary"},
    )
    both = statement_packet(["copy_a", "copy_b"], [statement_facts()["periods"][0]])
    with pytest.raises(EvidenceValidationError, match="model_membership_invalid"):
        await verify_packet(
            **arguments, packet=both, interpret=AsyncMock(return_value=ready_verdict())
        )

    deduped = statement_packet(["copy_a"], [statement_facts()["periods"][0]])
    deduped["excluded_documents"] = [exclusion("copy_b", duplicate_of="copy_a")]
    checked = await verify_packet(
        **arguments, packet=deduped, interpret=AsyncMock(return_value=ready_verdict())
    )
    assert checked.state == "ready"

    # Without a provider digest, identical extracted facts are still one source.
    for item in documents:
        item.pop("content_digest")
    with pytest.raises(EvidenceValidationError, match="model_membership_invalid"):
        await verify_packet(
            **arguments, packet=both, interpret=AsyncMock(return_value=ready_verdict())
        )


async def test_members_sharing_only_boilerplate_facts_remain_ready_together():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    # Two originals whose extraction captured the same header only (a type and
    # one fact; no account, period or dated evidence) cannot be told apart by
    # their facts. Both stay members; duplicate review stays with the checker.
    facts = page_facts()
    facts.pop("pages")
    facts.update(
        document_type={
            "value": "Meeting notes",
            "citations": [{"page": 1, "quote": "Meeting notes"}],
        },
        facts=[
            {"value": "Agenda circulated", "citations": [{"page": 1, "quote": "Agenda circulated"}]}
        ],
    )
    members = [
        statement_member("first", facts),
        statement_member("second", json.loads(json.dumps(facts))),
    ]
    result = packet([], ["first", "second"])
    answer = await construct_packet(
        user_id="owner",
        key="notes",
        complete=True,
        documents=members,
        interpret=AsyncMock(return_value=result),
    )
    assert answer.state == "ready" and answer.selected_document_ids == ["first", "second"]
    checked = await verify_packet(
        user_id="owner",
        complete=True,
        batch_scope={"mode": "complete_compact_summary"},
        packet=result,
        documents=[compact_evidence(item) for item in members],
        interpret=AsyncMock(return_value=ready_verdict()),
    )
    assert checked.state == "ready"


async def test_final_checker_reads_two_sparse_extractions_that_compact_alike_as_two_files():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    # Two originals whose facts compact to the same summary (the same header
    # facts, quoted from different pages) are two files, not one copy: the
    # final checker compares the digest of the full facts the worker carries
    # and asks for no regeneration. Naming one bank, account and period, they
    # are one statement twice, so the packet closes with that reason instead.
    first, second = statement_member("first"), statement_member("second")
    second["facts"]["facts"][0]["citations"] = [{"page": 2, "quote": "Ending balance $1,000.00"}]
    documents = [compact_evidence(first), compact_evidence(second)]
    summaries = [
        {key: value for key, value in item.items() if key not in {"document_id", "facts_digest"}}
        for item in documents
    ]
    assert summaries[0] == summaries[1]
    checker = AsyncMock(return_value=ready_verdict())
    checked = await verify_packet(
        user_id="owner",
        complete=True,
        batch_scope={"mode": "complete_compact_summary"},
        packet=statement_packet(["first", "second"], [statement_facts()["periods"][0]]),
        documents=documents,
        interpret=checker,
    )
    assert checker.await_count == 1
    assert checked.state == "incomplete"
    assert checked.issues == ["Two documents look like the same statement"]


@pytest.mark.parametrize(
    "quote", ["Monthly statement", "Account ending 1122", "Ending balance $2,026.00"]
)
async def test_ready_packet_period_needs_a_quote_that_states_its_date(quote):
    # A period equal to the file's edit month with no dated quote reads a
    # recent edit as a recent statement. Without a document-derived date the
    # packet is not Ready, and the retry feedback names what is missing.
    source = statement_member("trap", statement_facts(quote))
    arguments = dict(user_id="owner", key="statements", complete=True, documents=[source])
    result = statement_packet(["trap"], [source["facts"]["periods"][0]])
    interpreter = AsyncMock(return_value=result)
    with pytest.raises(EvidenceValidationError) as info:
        await construct_packet(**arguments, interpret=interpreter)
    assert info.value.code == "model_period_invalid"
    assert info.value.issues == [{"field": "periods", "item": 0, "missing": "dated_citation"}]
    feedback = json.loads(interpreter.await_args.kwargs["prompt"])["validation_feedback"]
    assert feedback["code"] == "model_period_invalid"
    assert feedback["issues"] == info.value.issues

    # The honest answer for undated evidence is not Ready, with the gap stated.
    result.update(state="incomplete", gaps=["Statement period is not stated in the document"])
    answer = await construct_packet(**arguments, interpret=AsyncMock(return_value=result))
    assert answer.state == "incomplete" and answer.gaps == result["gaps"]


@pytest.mark.parametrize(
    "quote",
    [
        "Statement period September 1, 2026 to September 30, 2026",
        "September 2026",
        "Sept. 2026 statement",
        "1 September 2026",
        "Closing date 09/30/2026",
        "2026-09-30",
        "Period ending 30.09.26",
        "Statement for 9/2026",
        "For the month of September",
    ],
)
async def test_ready_packet_period_accepts_a_quote_stating_its_month(quote):
    source = statement_member("statement", statement_facts(quote))
    result = statement_packet(["statement"], [source["facts"]["periods"][0]])
    answer = await construct_packet(
        user_id="owner",
        key="statements",
        complete=True,
        documents=[source],
        interpret=AsyncMock(return_value=result),
    )
    assert answer.state == "ready" and answer.periods[0].citations[0].quote == quote


@pytest.mark.parametrize(
    ("quote", "window"),
    [
        ("Tax year 2026", ("2026-01-01", "2026-12-31")),
        ("Q3 2026", ("2026-07-01", "2026-09-30")),
        ("Fiscal year ended June 30, 2026", ("2025-07-01", "2026-06-30")),
    ],
)
async def test_ready_packet_longer_period_accepts_a_quote_stating_its_year(quote, window):
    facts = statement_facts(quote)
    facts["periods"][0].update(start=window[0], end=window[1])
    source = statement_member("statement", facts)
    result = statement_packet(["statement"], [facts["periods"][0]])
    answer = await construct_packet(
        user_id="owner",
        key="statements",
        complete=True,
        documents=[source],
        interpret=AsyncMock(return_value=result),
    )
    assert answer.state == "ready"


@pytest.mark.parametrize(
    ("quote", "window"),
    [
        # A September statement edited in October: the quote is dated, but not
        # inside the claimed month, so the period came from somewhere else.
        (
            "Statement period September 1, 2026 to September 30, 2026",
            ("2026-10-01", "2026-10-31"),
        ),
        ("Closing date 09/30/2026", ("2026-10-01", "2026-10-31")),
        ("Tax year 2026", ("2026-10-01", "2026-10-31")),
        ("Account ending 2026", ("2026-10-01", "2026-10-31")),
        # Last year's statement re-uploaded this month.
        ("September 2025", ("2026-09-01", "2026-09-30")),
    ],
)
async def test_ready_packet_month_needs_a_quote_dated_inside_it(quote, window):
    facts = statement_facts(quote)
    facts["periods"][0].update(start=window[0], end=window[1])
    source = statement_member("trap", facts)
    result = statement_packet(["trap"], [facts["periods"][0]])
    with pytest.raises(EvidenceValidationError) as info:
        await construct_packet(
            user_id="owner",
            key="statements",
            complete=True,
            documents=[source],
            interpret=AsyncMock(return_value=result),
        )
    assert info.value.code == "model_period_invalid"
    assert info.value.issues == [{"field": "periods", "item": 0, "missing": "dated_citation"}]


async def test_final_checker_cannot_verify_an_undated_period_as_ready():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    arguments = dict(
        user_id="owner", complete=True, batch_scope={"mode": "complete_compact_summary"}
    )
    undated = statement_member("trap", statement_facts("Monthly statement"))
    proposal = statement_packet(["trap"], [undated["facts"]["periods"][0]])
    with pytest.raises(EvidenceValidationError, match="model_period_invalid"):
        await verify_packet(
            **arguments,
            packet=proposal,
            documents=[compact_evidence(undated)],
            interpret=AsyncMock(return_value=ready_verdict()),
        )

    dated = statement_member("statement")
    proposal = statement_packet(["statement"], [dated["facts"]["periods"][0]])
    checked = await verify_packet(
        **arguments,
        packet=proposal,
        documents=[compact_evidence(dated)],
        interpret=AsyncMock(return_value=ready_verdict()),
    )
    assert checked.state == "ready"


# Ready guards v2, from the real-Drive eval re-run. Two Ready packets passed
# every #8054 gate: one whose headline month was dated only by the snapshot
# date its own facts recorded for the same line, and copy claiming complete
# coverage. The shapes below are synthetic replicas; no private text is copied.

PERIOD_ROLE = "Period is dated only by a due, print, transaction, event or snapshot date"
UNSUPPORTED_COMPLETE = "Copy claims complete coverage the periods do not show"


def dated(role, day, quote, *, end=None):
    return {
        "role": role,
        "start": day,
        "end": end or day,
        "meaning": f"Synthetic {role} date",
        "citations": [{"page": 1, "quote": quote}],
    }


def window(start, end, *quotes):
    return {
        "start": start,
        "end": end,
        "citations": [{"page": 1, "quote": quote} for quote in quotes],
    }


BENCHMARK = "Fund highlights (September 2026 benchmark)\nSeptember 2026 highlights"
YEAR_TO_DATE = "Year-to-date 2026 results (Jan 1 - Sep 30)"


def benchmark_summary():
    # The eval's shape: a summary whose headline month is its benchmark
    # snapshot. The facts date that line as_of the month end and also claim
    # it as a coverage month beside a year-to-date window stating its endpoints.
    facts = statement_facts()
    snapshot = dated("as_of", "2026-09-30", BENCHMARK)
    snapshot["citations"].append({"page": 1, "quote": YEAR_TO_DATE})
    facts.update(
        document_type={
            "value": "Performance summary",
            "citations": [{"page": 1, "quote": "Performance summary"}],
        },
        issuer={"value": "Example Fund", "citations": [{"page": 1, "quote": "Example Fund"}]},
        account=None,
        periods=[
            window("2026-09-01", "2026-09-30", BENCHMARK),
            window("2026-01-01", "2026-09-30", YEAR_TO_DATE),
        ],
        date_evidence=[snapshot],
    )
    return statement_member("summary", facts)


async def test_ready_period_cannot_be_dated_only_by_its_snapshot_date():
    source = benchmark_summary()
    periods = source["facts"]["periods"]
    arguments = dict(user_id="owner", key="fund-summaries", complete=True, documents=[source])
    interpreter = AsyncMock(return_value=statement_packet(["summary"], periods))
    with pytest.raises(EvidenceValidationError) as info:
        await construct_packet(**arguments, interpret=interpreter)
    assert interpreter.await_count == 2
    assert info.value.code == "model_period_invalid"
    assert info.value.issues == [{"field": "periods", "item": 0, "date_role": "as_of"}]
    feedback = json.loads(interpreter.await_args.kwargs["prompt"])["validation_feedback"]
    assert feedback["issues"] == info.value.issues

    # The year-to-date window states its own endpoints, so it alone is Ready.
    answer = await construct_packet(
        **arguments, interpret=AsyncMock(return_value=statement_packet(["summary"], periods[1:]))
    )
    assert answer.state == "ready"


@pytest.mark.parametrize(
    ("role", "quote", "day"),
    [
        ("planned_action", "Payment due October 25, 2026", "2026-10-25"),
        ("publication", "Printed on October 3, 2026", "2026-10-03"),
        ("transaction", "Purchase posted 10/14/2026", "2026-10-14"),
    ],
    ids=["due_date", "print_date", "transaction_date"],
)
async def test_ready_statement_month_cannot_come_from_another_kind_of_date(role, quote, day):
    facts = statement_facts(quote)
    facts["periods"] = [window("2026-10-01", "2026-10-31", quote)]
    facts["date_evidence"] = [dated(role, day, quote)]
    source = statement_member("statement", facts)
    with pytest.raises(EvidenceValidationError) as info:
        await construct_packet(
            user_id="owner",
            key="statements",
            complete=True,
            documents=[source],
            interpret=AsyncMock(return_value=statement_packet(["statement"], facts["periods"])),
        )
    assert info.value.code == "model_period_invalid"
    assert info.value.issues == [{"field": "periods", "item": 0, "date_role": role}]


ACTIVITY = "Activity 09/01/2026 to 09/30/2026. Payment received 09/30/2026"
OPENING, CLOSING = "BalanceonAug 17,2026 $250.00", "BalanceonSep 16,2026 $1,480.75"
DUE_LINE = "September 2026 statement. Payment due September 25, 2026"
PAY_LINE = "Period start 11/15/2026 Period end 11/15/2026 Pay date 11/15/2026"


@pytest.mark.parametrize(
    ("period", "date_evidence"),
    [
        # The activity line states both endpoints; the closing-day payment
        # quotes the same line.
        (
            window("2026-09-01", "2026-09-30", ACTIVITY),
            [dated("transaction", "2026-09-30", ACTIVITY)],
        ),
        # Opening and closing balances dated on the window's two endpoints,
        # in text whose run-together words hide the month names.
        (
            window("2026-08-17", "2026-09-16", OPENING, CLOSING),
            [dated("as_of", "2026-08-17", OPENING), dated("as_of", "2026-09-16", CLOSING)],
        ),
        # The statement month is stated apart from the due date on its line.
        (
            window("2026-09-01", "2026-09-30", DUE_LINE),
            [dated("planned_action", "2026-09-25", DUE_LINE)],
        ),
        # The tax year is also recorded as a dated event of the same window.
        (
            window("2026-01-01", "2026-12-31", "Tax year 2026"),
            [dated("event", "2026-01-01", "Tax year 2026", end="2026-12-31")],
        ),
        # A snapshot dated by another line does not date the statement month.
        (
            window("2026-09-01", "2026-09-30", "Statement for September 2026"),
            [dated("as_of", "2026-09-30", "Ending balance as of September 30, 2026")],
        ),
        # A one-day pay period that its pay date restates.
        (
            window("2026-11-15", "2026-11-15", PAY_LINE),
            [dated("transaction", "2026-11-15", PAY_LINE)],
        ),
    ],
    ids=[
        "endpoints_beside_a_payment",
        "balances_on_both_endpoints",
        "month_beside_a_due_date",
        "tax_year_recorded_twice",
        "snapshot_on_another_line",
        "one_day_pay_period",
    ],
)
async def test_statement_periods_quoted_beside_other_dates_stay_ready(period, date_evidence):
    facts = statement_facts()
    facts.update(periods=[period], date_evidence=date_evidence)
    source = statement_member("statement", facts)
    answer = await construct_packet(
        user_id="owner",
        key="statements",
        complete=True,
        documents=[source],
        interpret=AsyncMock(return_value=statement_packet(["statement"], [period])),
    )
    assert answer.state == "ready"


async def test_member_checker_cannot_certify_a_period_dated_only_by_a_snapshot():
    source = benchmark_summary()
    checked = await verify_packet(
        user_id="owner",
        packet=statement_packet(["summary"], source["facts"]["periods"]),
        documents=[source],
        complete=True,
        batch_scope={"mode": "member_batch"},
        interpret=AsyncMock(return_value=ready_verdict()),
    )
    assert checked.state == "incomplete" and checked.correct_coverage is False
    assert PERIOD_ROLE in checked.issues


def month_member(document_id, month):
    facts = statement_facts(f"Statement period {month:02d}/2026")
    facts["periods"][0].update(start=f"2026-{month:02d}-01", end=f"2026-{month:02d}-28")
    facts["facts"][0] = {
        "value": f"Ending balance ${month},000.00",
        "citations": [{"page": 1, "quote": f"Ending balance ${month},000.00"}],
    }
    return statement_member(document_id, facts)


def months_packet(members, **copy):
    result = statement_packet(
        [item["document_id"] for item in members],
        [item["facts"]["periods"][0] for item in members],
    )
    for field, text in copy.items():
        if field == "pricing":
            result["pricing"]["rationale"] = text
        else:
            result[field] = text
    return result


async def build_months(members, **copy):
    return await construct_packet(
        user_id="owner",
        key="statements",
        complete=True,
        documents=members,
        interpret=AsyncMock(return_value=months_packet(members, **copy)),
    )


async def test_ready_copy_cannot_claim_complete_coverage_over_a_missing_month():
    members = [month_member("sep", 9), month_member("nov", 11)]
    arguments = dict(user_id="owner", key="statements", complete=True, documents=members)
    claimed = months_packet(members, coverage_summary="Complete September-November 2026 statements")
    interpreter = AsyncMock(return_value=claimed)
    with pytest.raises(EvidenceValidationError) as info:
        await construct_packet(**arguments, interpret=interpreter)
    assert interpreter.await_count == 2
    assert info.value.code == "model_readiness_invalid"
    assert info.value.issues == [{"field": "coverage_summary", "unsupported": "complete_coverage"}]
    feedback = json.loads(interpreter.await_args.kwargs["prompt"])["validation_feedback"]
    assert feedback["issues"] == info.value.issues

    # Copy that states exactly what is covered stays Ready.
    exact = months_packet(
        members, coverage_summary="September and November 2026 statements; October is not included"
    )
    answer = await construct_packet(**arguments, interpret=AsyncMock(return_value=exact))
    assert answer.state == "ready"


@pytest.mark.parametrize(
    ("field", "claim", "months"),
    [
        ("title", "Full year 2026 statements", [9]),
        ("description", "All months of 2026 for one account", [9, 10]),
        ("pricing", "Continuous monthly coverage for one account", [9, 11]),
        ("utility_rationale", "Every month in the span is present", [9, 11]),
    ],
    ids=["full_year", "all_months_of_a_year", "continuous_over_a_gap", "every_month_over_a_gap"],
)
async def test_ready_copy_cannot_claim_more_months_than_its_dated_periods(field, claim, months):
    members = [month_member(f"m{month}", month) for month in months]
    with pytest.raises(EvidenceValidationError) as info:
        await build_months(members, **{field: claim})
    assert info.value.code == "model_readiness_invalid"
    expected = "pricing.rationale" if field == "pricing" else field
    assert info.value.issues == [{"field": expected, "unsupported": "complete_coverage"}]


def tax_year_member():
    facts = statement_facts("Tax year 2026")
    facts["periods"][0].update(start="2026-01-01", end="2026-12-31")
    return statement_member("tax-year", facts)


@pytest.mark.parametrize(
    ("members", "copy"),
    [
        ([month_member("sep", 9)], {"title": "Complete September 2026 statement"}),
        ([tax_year_member()], {"coverage_summary": "Covers the full calendar year 2026"}),
        (
            [month_member("sep", 9), month_member("oct", 10), month_member("nov", 11)],
            {"utility_rationale": "Complete monthly statements for one account"},
        ),
        (
            [month_member("sep", 9), month_member("nov", 11)],
            {"coverage_summary": "Does not claim complete September-November 2026 coverage"},
        ),
    ],
    ids=["one_complete_month", "full_dated_year", "every_month_present", "negated_claim"],
)
async def test_ready_copy_claiming_only_its_dated_months_stays_ready(members, copy):
    answer = await build_months(members, **copy)
    assert answer.state == "ready"


def undated_draft():
    facts = statement_facts()
    facts.update(
        document_type={"value": "Draft plan", "citations": [{"page": 1, "quote": "Draft plan"}]},
        account=None,
        periods=[],
    )
    return statement_member("draft", facts)


@pytest.mark.parametrize(
    ("summary", "ready"),
    [
        ("Complete 2026 coverage of the draft plan", False),
        ("Full monthly history of the plan", False),
        ("Contains the complete 9-page draft plan", True),
        ("No continuous reporting window is claimed", True),
    ],
    ids=["dated_claim", "monthly_claim", "complete_bounded_document", "negated_window"],
)
async def test_undated_packet_cannot_claim_complete_temporal_coverage(summary, ready):
    result = packet([], ["draft"])
    result["coverage_summary"] = summary
    arguments = dict(
        user_id="owner",
        key="plans",
        complete=True,
        documents=[undated_draft()],
        interpret=AsyncMock(return_value=result),
    )
    if ready:
        assert (await construct_packet(**arguments)).state == "ready"
        return
    with pytest.raises(EvidenceValidationError) as info:
        await construct_packet(**arguments)
    assert info.value.issues == [{"field": "coverage_summary", "unsupported": "complete_coverage"}]


async def test_final_checker_cannot_certify_complete_coverage_over_a_missing_month():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    members = [month_member("sep", 9), month_member("nov", 11)]
    arguments = dict(
        user_id="owner",
        documents=[compact_evidence(item) for item in members],
        complete=True,
        batch_scope={"mode": "complete_compact_summary"},
    )
    claimed = months_packet(members, title="Complete September-November 2026 statements")
    checked = await verify_packet(
        **arguments, packet=claimed, interpret=AsyncMock(return_value=ready_verdict())
    )
    assert checked.state == "incomplete" and checked.correct_coverage is False
    assert UNSUPPORTED_COMPLETE in checked.issues

    exact = months_packet(members, title="September and November 2026 statements")
    checked = await verify_packet(
        **arguments, packet=exact, interpret=AsyncMock(return_value=ready_verdict())
    )
    assert checked.state == "ready"


@pytest.mark.parametrize(
    ("start", "end", "quote", "ready"),
    [
        (
            "2026-07-01",
            "2026-09-30",
            "For the quarter ended September 30, 2026, account value as of September 30, 2026",
            True,
        ),
        (
            "2025-01-01",
            "2025-12-31",
            "Annual statement for the year ended 12/31/2025; balance as of 12/31/2025",
            True,
        ),
        # The stated unit must match the window: one month is not a quarter.
        (
            "2026-07-01",
            "2026-09-30",
            "For the month ended September 30, 2026, account value as of September 30, 2026",
            False,
        ),
    ],
    ids=["quarter_ended", "year_ended", "month_unit_for_a_quarter"],
)
async def test_window_stated_by_its_unit_and_end_date_stands_beside_a_snapshot(
    start, end, quote, ready
):
    facts = statement_facts()
    period = window(start, end, quote)
    facts.update(periods=[period], date_evidence=[dated("as_of", end, quote)])
    arguments = dict(
        user_id="owner",
        key="statements",
        complete=True,
        documents=[statement_member("statement", facts)],
        interpret=AsyncMock(return_value=statement_packet(["statement"], [period])),
    )
    if ready:
        assert (await construct_packet(**arguments)).state == "ready"
        return
    with pytest.raises(EvidenceValidationError) as info:
        await construct_packet(**arguments)
    assert info.value.issues == [{"field": "periods", "item": 0, "date_role": "as_of"}]


@pytest.mark.parametrize(
    ("months", "copy", "ready"),
    [
        # A quarter names its three months, not its whole year.
        ([7, 8, 9], {"title": "Complete Q3 2026 statements"}, True),
        ([7, 8, 9], {"title": "Complete third-quarter 2026 statements"}, True),
        ([7, 8, 9], {"title": "Complete Q2 and Q3 2026 statements"}, False),
        # Year-to-date runs from January through the packet's last month.
        ([1, 2, 3], {"coverage_summary": "Complete year-to-date 2026 statements"}, True),
        ([2, 3], {"coverage_summary": "Complete YTD 2026 statements"}, False),
        # The modal verb is not the month May.
        ([9, 11], {"utility_rationale": "All statements may help a lender"}, True),
        ([9], {"title": "Complete May 2026 statement"}, False),
    ],
    ids=[
        "one_quarter",
        "ordinal_quarter",
        "missing_quarter",
        "year_to_date",
        "year_to_date_gap",
        "modal_may",
        "month_may",
    ],
)
async def test_completeness_claims_name_quarters_year_to_date_and_may(months, copy, ready):
    members = [month_member(f"m{month}", month) for month in months]
    if ready:
        assert (await build_months(members, **copy)).state == "ready"
        return
    with pytest.raises(EvidenceValidationError) as info:
        await build_months(members, **copy)
    assert info.value.code == "model_readiness_invalid"


async def test_only_semantic_planner_reuses_explicit_model_across_correction(monkeypatch):
    from hushh_mcp.services import drive_suggestion_service as service

    bound = object()
    request_guard = AsyncMock()
    binder = AsyncMock(return_value=bound)
    monkeypatch.setattr(service, "private_semantic_request_model", binder)
    build = Mock(return_value=object())
    monkeypatch.setattr(service, "build_single_turn_agent", build)
    good = _request_planner_response()
    run = AsyncMock(side_effect=[{"semantic_query": {}}, good, {}])
    monkeypatch.setattr(service, "run_single_turn", run)
    result = await service.plan_semantic_live_search(
        service.interpret_semantic_live_search,
        prompt="synthetic request",
        user_id="owner",
        require_current=request_guard,
    )
    assert result.semantic_query.status == "ready"
    binder.assert_awaited_once_with(
        user_id="owner",
        require_current=request_guard,
        model_binding=service.validate_semantic_model_binding(None),
    )
    assert len(build.call_args_list) == 2
    assert all(call.kwargs["model"] is bound for call in build.call_args_list)
    assert all(call.args[0].id == "agent_documents_request_search" for call in build.call_args_list)
    await service.interpret_live_search(prompt="legacy request", user_id="owner")
    assert "model" not in build.call_args.kwargs
    assert build.call_args.args[0].id == "agent_documents_live_search"
    assert binder.await_count == 1


async def test_only_request_assessor_reuses_explicit_model_across_correction(monkeypatch):
    from hushh_mcp.services import drive_request_package_assessment as service

    bound = object()
    request_guard = AsyncMock()
    binder = AsyncMock(return_value=bound)
    monkeypatch.setattr(service, "private_semantic_request_model", binder)
    build = Mock(return_value=object())
    monkeypatch.setattr(service, "build_single_turn_agent", build)
    retrieved = {
        "untrusted_external_content": [
            {
                "document_ref": "p1",
                "source_ref": "p1:content",
                "source_version": "7",
                "text": "The observed original document text.",
            }
        ]
    }
    good = {
        "documents": [
            {
                "document_ref": "p1",
                "decision": "include",
                "confidence": 90,
                "reason": "Substantive actual evidence.",
                "covered_periods": [],
                "citations": [{"source_ref": "p1:content", "quote": "original document text"}],
            }
        ]
    }
    monkeypatch.setattr(
        service, "run_single_turn", AsyncMock(side_effect=[{"documents": []}, good, {}])
    )
    result = await service.assess_request_document_batch(
        request={"purpose": "synthetic request"},
        retrieved=retrieved,
        user_id="owner",
        require_current=request_guard,
    )
    assert result.documents[0].source_version == "7"
    binder.assert_awaited_once_with(
        user_id="owner",
        require_current=request_guard,
        model_binding=service.validate_semantic_model_binding(None),
    )
    assert len(build.call_args_list) == 2
    assert all(call.kwargs["model"] is bound for call in build.call_args_list)
    assert all(
        call.args[0].id == "agent_documents_request_assessment" for call in build.call_args_list
    )
    await service.interpret_document_batch(prompt="legacy request", user_id="owner")
    assert "model" not in build.call_args.kwargs
    assert build.call_args.args[0].id == "agent_documents_suggestions"
    assert binder.await_count == 1
