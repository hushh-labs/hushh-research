"""Azure PWM owner, budget and citation gates with synthetic provider results."""

import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from openai import APIError

from hushh_mcp.one_adk.world_model import MAX_SEARCHES
from hushh_mcp.one_adk.world_model_azure import AzurePwmGateway, run_world_model_azure
from hushh_mcp.one_adk.world_model_contracts import TOPICS, validated_facts_from_work
from hushh_mcp.one_adk.world_model_usage import UsageReceipt

IDENTITY = {"full_name": "Alex Example", "email": "alex@example.test", "phone_number": None}
URL = "https://example.test/alex"
MODEL_FIRST = MAX_SEARCHES + 1


def search_response(*, citations=True, billed=1, answer_has_contact=True):
    answer = (
        "The public bio publishes alex@example.test for Alex Example."
        if answer_has_contact
        else "A public bio names Alex Example and describes professional work."
    )
    return {
        "status": "completed",
        "tool_usage": {"web_search": {"num_requests": billed}},
        "output": [
            {"type": "web_search_call", "status": "completed", "action": {"type": "search"}},
            {
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": answer,
                        "annotations": [
                            {
                                "type": "url_citation",
                                "start_index": 0,
                                "end_index": 10,
                                "title": "Public bio",
                                "url": URL,
                            }
                        ]
                        if citations
                        else [],
                    }
                ],
            },
        ],
    }


def assessment(*, source_ref="s1"):
    return {
        "candidates": [
            {"id": "c1", "label": "Alex Example", "anchor_ids": ["a1"], "blocking_conflicts": []}
        ],
        "anchors": [
            {
                "id": "a1",
                "candidate_id": "c1",
                "kind": "verified_contact",
                "seed_field": "email",
                "assertion": "The source publishes the verified contact.",
                "source_refs": [source_ref],
                "temporal_context": "Current public bio",
            }
        ],
        "identity": {
            "state": "owner_linked",
            "reason": "The public bio publishes the exact verified contact.",
            "probability": None,
            "selected_candidate_id": "c1",
            "supporting_anchor_ids": ["a1"],
            "next_step": "search",
        },
    }


def report(identity):
    return {
        "match_status": "uncertain",
        "name": "Alex Example",
        "summary": "Public professional activity is present.",
        "sections": [
            {
                "kind": "career",
                "facts": [
                    {
                        "statement": "Alex Example publishes a public work bio.",
                        "confidence": "supported",
                        "sources": [{"title": "Public bio", "ref": "s1"}],
                    }
                ],
            }
        ],
        "identity": copy.deepcopy(identity),
        "coverage": [
            {
                "topic": topic,
                "status": "findings" if topic == "career" else "not_attempted",
                "attempt_ids": [1] if topic == "career" else [],
                "explanation": "Public bio" if topic == "career" else "Not searched in fixture",
            }
            for topic in TOPICS
        ],
        "gaps": ["Other topics have not been researched."],
    }


class FakeGateway:
    def __init__(
        self,
        *,
        charges,
        snapshots,
        citations=True,
        invalid_assessment=None,
        answer_has_contact=True,
        phi_non_json=False,
        phi_api_error=False,
        coverage_plan=False,
        coverage_with_contact=False,
        bad_coverage=False,
        unsearched_section=False,
        invalid_finding=None,
        report_timeout=False,
        assessment_results=None,
        report_results=None,
    ):
        self.charges = charges
        self.snapshots = snapshots
        self.citations = citations
        self.invalid_assessment = invalid_assessment
        self.answer_has_contact = answer_has_contact
        self.phi_non_json = phi_non_json
        self.phi_api_error = phi_api_error
        self.coverage_plan = coverage_plan
        self.coverage_with_contact = coverage_with_contact
        self.bad_coverage = bad_coverage
        self.unsearched_section = unsearched_section
        self.invalid_finding = invalid_finding
        self.report_timeout = report_timeout
        self.assessment_results = copy.deepcopy(assessment_results)
        self.report_results = copy.deepcopy(report_results)
        self.report_requests = []
        self.assessment_payloads = []
        self.calls = []

    async def search(self, request):
        self.calls.append("search")
        if self.calls.count("search") == 1:
            assert self.charges == [1, MODEL_FIRST]
            assert self.snapshots[-1]["attempts"]["1"]["state"] == "started"
            assert request["exact_owner_fields"] == {
                "email": IDENTITY["email"],
                "full_name": IDENTITY["full_name"],
            }
        else:
            planner_calls = self.calls.count("plan")
            assert self.charges == [
                1,
                *range(MODEL_FIRST, MODEL_FIRST + 3 + planner_calls),
                2,
                MODEL_FIRST + 3 + planner_calls,
            ]
            assert self.snapshots[-1]["attempts"]["2"]["state"] == "started"
            assert request["exact_owner_fields"] == {"full_name": IDENTITY["full_name"]}
            assert request["evidenced_anchors"][0]["kind"] == "public_profile"
            assert request["received_sources"] == [{"ref": "s1", "title": "Public bio", "url": URL}]
        return search_response(citations=self.citations, answer_has_contact=self.answer_has_contact)

    async def plan(self, payload):
        self.calls.append("plan")
        if payload["research_history"]["assessment"]["state"] == "candidate_for_review":
            assert payload["identity_phase"] is False
            assert payload["coverage_allowed"] is True
            assert payload["owner_linkage_unverified"] is True
        serialized = json.dumps(payload)
        assert "owner_decisions" not in serialized
        assert IDENTITY["email"] not in serialized
        if payload["research_history"]["assessment"]["anchors"]:
            assert payload["research_history"]["assessment"]["anchors"][0]["public_sources"] == [
                {"ref": "s1", "title": "Public bio", "url": URL}
            ]
        if self.phi_non_json:
            raise ValueError("Phi planner response is not JSON")
        if self.phi_api_error:
            raise APIError(
                "Synthetic provider error",
                request=httpx.Request("POST", "https://synthetic.services.ai.azure.com/openai/v1/"),
                body=None,
            )
        if self.coverage_plan:
            return {
                "action": "search",
                "plan": {
                    "purpose": "coverage",
                    "seed_fields": ["email" if self.coverage_with_contact else "full_name"],
                    "anchor_ids": ["a1"],
                    "candidate_id": "c1",
                    "topics": ["career"],
                    "question": "Find public work by this review candidate.",
                },
            }
        return {"action": "finish", "plan": None}

    async def structured(self, *, purpose, instruction, payload, schema, max_output_tokens):
        self.calls.append(purpose)
        assert schema and max_output_tokens > 0 and instruction
        if purpose in {"identity_assessment", "identity_assessment_repair"}:
            self.assessment_payloads.append(copy.deepcopy(payload))
            if self.assessment_results is not None:
                assert self.assessment_results
                return self.assessment_results.pop(0)
            value = assessment(
                source_ref="s99" if self.invalid_assessment == "missing_ref" else "s1"
            )
            if self.invalid_assessment == "missing_verified_contact":
                value["anchors"][0]["kind"] = "public_profile"
                value["anchors"][0]["seed_field"] = None
            if self.invalid_assessment == "cross_candidate":
                value["candidates"].append(
                    {"id": "c2", "label": "Namesake", "anchor_ids": [], "blocking_conflicts": []}
                )
                value["anchors"][0]["candidate_id"] = "c2"
            return value
        if purpose == "provisional_findings":
            selected = payload["selected_candidate"]
            assert selected["candidate"]["id"] == payload["candidate_id"]
            assert selected["anchors"]
            assert all(
                row["candidate_id"] == payload["candidate_id"] for row in selected["anchors"]
            )
            assert max_output_tokens <= 2048
            assert payload["eligible_sources"] == [{"ref": "s1", "title": "Public bio", "url": URL}]
            if payload["attempt_id"] != 1:
                return {"skip": True}
            statement = (
                "A public bio publishes alex@example.test."
                if self.invalid_finding == "contact"
                else "A public bio names Alex Example."
            )
            return {
                "candidate_id": "c2"
                if self.invalid_finding == "candidate"
                else payload["candidate_id"],
                "attempt_id": payload["attempt_id"],
                "topic": payload["topic"],
                "facts": [
                    {
                        "statement": statement,
                        "confidence": "supported",
                        "sources": [
                            {
                                "title": "Untrusted model title",
                                "ref": "s99" if self.invalid_finding == "source" else "s1",
                            }
                        ],
                    }
                ],
            }
        if purpose == "world_model_fact_review":
            return {
                "kept_fact_ids": [fact["id"] for fact in payload["proposed_facts"]],
                "summary": payload["current_summary"],
            }
        assert purpose in {"world_model_report", "world_model_report_repair"}
        self.report_requests.append(
            copy.deepcopy({"purpose": purpose, "payload": payload, "schema": schema})
        )
        if self.report_timeout:
            raise TimeoutError("Synthetic report interruption")
        assert payload["owner_decisions"]["rejected"] == ["An unrelated claim"]
        assert payload["topic_attempt_ids"]["career"]
        if self.report_results is not None:
            return self.report_results.pop(0)
        draft = report(payload["research_history"]["assessment"]["identity"])
        if self.bad_coverage:
            draft["coverage"][TOPICS.index("career")]["attempt_ids"] = [31]
        if self.unsearched_section:
            draft["sections"][0]["kind"] = "travel"
        return draft


@pytest.mark.asyncio
async def test_azure_runner_charges_before_dispatch_and_preserves_receipts():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["_provider_usage"]["input_tokens"] is None
    assert result["_provider_usage"]["recorded_calls"] == 0
    assert result["pkm_written"] is False
    assert result["research"]["source_use"] == "azure_web_grounded_display_only"
    assert result["research"]["provider"] == "azure_openai_web_search"
    assert result["report"]["match_status"] == "uncertain"
    assert result["research"]["identity"]["state"] == "candidate_for_review"
    assert result["report"]["sections"][0]["facts"][0]["sources"] == [
        {"title": "Public bio", "url": URL}
    ]
    assert snapshots[-1]["attempts"]["1"]["bing_requests"] == 1
    citation = {"start_index": 0, "end_index": 10, "title": "Public bio", "url": URL}
    assert snapshots[-1]["attempts"]["1"]["citations"] == [citation]
    assert result["grounded_answers"][0]["citations"] == [citation]
    assert (
        result["grounded_answers"][0]["answer"]
        == search_response()["output"][1]["content"][0]["text"]
    )
    provisional = validated_facts_from_work(snapshots[-1])
    assert len(provisional) == 1
    assert provisional[0]["identity_state"] == "candidate_for_review"
    assert provisional[0]["sources"] == [{"title": "Public bio", "url": URL}]
    assert snapshots[-1]["finding_attempts"]["1"]["state"] == "recorded"
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 6)]
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        "world_model_report",
        "world_model_fact_review",
    ]


@pytest.mark.asyncio
async def test_azure_runner_keeps_provisional_finding_when_final_report_pauses():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, report_timeout=True)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result == {"status": "paused", "pkm_written": False, "restart_required": True}
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        "world_model_report",
    ]
    provisional = validated_facts_from_work(snapshots[-1])
    assert len(provisional) == 1
    assert provisional[0]["statement"] == "A public bio names Alex Example."
    assert provisional[0]["sources"] == [{"title": "Public bio", "url": URL}]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 5)]


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", ["candidate", "source", "contact"])
async def test_azure_runner_discards_invalid_provisional_batch_and_still_reports(defect):
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, invalid_finding=defect)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["report"]["match_status"] == "uncertain"
    assert validated_facts_from_work(snapshots[-1]) == []
    assert snapshots[-1]["finding_attempts"]["1"]["state"] == "unavailable"
    projected = gateway.report_requests[0]["payload"]["research_history"]
    assert projected["finding_batches"] == []
    assert projected["assessment"]["anchors"]  # Selected anchors still permit a report.
    assert "answer" not in projected["attempts"]["1"]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 6)]


@pytest.mark.asyncio
async def test_azure_runner_derives_coverage_attempts_from_checkpoint():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, bad_coverage=True)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    coverage = {row["topic"]: row for row in result["research"]["coverage"]}
    assert coverage["career"]["attempt_ids"] == [1]
    assert coverage["travel"]["status"] == "not_attempted"
    assert coverage["travel"]["attempt_ids"] == []


@pytest.mark.asyncio
async def test_azure_runner_rejects_section_without_observed_topic_receipt():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, unsearched_section=True)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    with pytest.raises(ValueError, match="observed topic receipt"):
        await run_world_model_azure(
            identity=IDENTITY,
            user_id="owner",
            consent_token="synthetic",  # noqa: S106 - synthetic test authority
            require_access=AsyncMock(),
            on_attempts_start=charge,
            on_progress=progress,
            owner_decisions={"rejected": ["An unrelated claim"]},
            gateway=gateway,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", ["topic", "schema_bound", "citation"])
async def test_report_schema_matches_observed_topics_and_repairs_without_research(defect):
    from jsonschema import ValidationError, validate

    from hushh_mcp.one_adk.world_model_azure import _cap_unverified_contact

    accepted = _cap_unverified_contact(assessment())["identity"]
    valid = report(accepted)
    valid.pop("coverage")  # Provider reports facts; the host owns all coverage rows.
    invalid = copy.deepcopy(valid)
    if defect == "topic":
        invalid["sections"][0]["kind"] = "travel"
    elif defect == "schema_bound":
        invalid["summary"] = "x" * 501
    else:
        invalid["sections"][0]["facts"][0]["sources"][0]["ref"] = "s2"
    charges, snapshots = [], []
    accepted_assessment = assessment()
    accepted_assessment["candidates"].append(
        {
            "id": "c2",
            "label": "UNSELECTED_CANDIDATE",
            "anchor_ids": ["a2"],
            "blocking_conflicts": [],
        }
    )
    accepted_assessment["anchors"].append(
        {
            **accepted_assessment["anchors"][0],
            "id": "a2",
            "candidate_id": "c2",
            "source_refs": ["s2"],
            "assertion": "UNSELECTED_ANCHOR",
        }
    )

    class MixedDiscoveryGateway(FakeGateway):
        async def search(self, request):
            raw = await super().search(request)
            text = raw["output"][1]["content"][0]
            text["text"] += " RAW_UNPARTITIONED_DISCOVERY"
            text["annotations"].append(
                {
                    "type": "url_citation",
                    "start_index": 11,
                    "end_index": 20,
                    "title": "UNSELECTED_SOURCE",
                    "url": "https://example.test/namesake-only",
                }
            )
            return raw

    gateway = MixedDiscoveryGateway(
        charges=charges,
        snapshots=snapshots,
        report_results=[invalid, valid],
        assessment_results=[accepted_assessment],
    )

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["report"]["sections"][0]["kind"] == "career"
    assert gateway.calls.count("search") == 1
    assert gateway.calls[-3:] == [
        "world_model_report",
        "world_model_report_repair",
        "world_model_fact_review",
    ]
    original, repair = gateway.report_requests
    projected = original["payload"]["research_history"]
    serialized = json.dumps(projected)
    for marker in (
        "UNSELECTED_CANDIDATE",
        "UNSELECTED_ANCHOR",
        "UNSELECTED_SOURCE",
        "RAW_UNPARTITIONED_DISCOVERY",
    ):
        assert marker not in serialized
    assert set(projected["sources"]) == {"s1"}
    assert "RAW_UNPARTITIONED_DISCOVERY" in snapshots[-1]["attempts"]["1"]["answer"]
    assert snapshots[-1]["assessment"]["candidates"][1]["label"] == "UNSELECTED_CANDIDATE"
    assert result["research"]["candidates"][1]["label"] == "UNSELECTED_CANDIDATE"
    assert "RAW_UNPARTITIONED_DISCOVERY" in result["grounded_answers"][0]["answer"]
    assert "coverage" not in original["schema"]["properties"]
    assert "coverage" not in original["schema"]["required"]
    assert len(result["research"]["coverage"]) == len(TOPICS)
    validate(valid, original["schema"])
    with pytest.raises(ValidationError):
        validate(invalid, original["schema"])
    assert repair["schema"] == original["schema"]
    assert repair["payload"]["invalid_report"] == invalid
    assert repair["payload"]["validation_errors"] == [
        {"path": [], "type": "value_error"}
        if defect != "schema_bound"
        else {"path": ["summary"], "type": "string_too_long"}
    ]
    assert repair["payload"]["research_history"] == original["payload"]["research_history"]
    assert "usage_records" not in repair["payload"]["research_history"]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 7)]


@pytest.mark.parametrize("distinct_sources", [False, True])
def test_deep_report_schema_fits_azure_budgets_without_truncating_citations(distinct_sources):
    from jsonschema import Draft202012Validator, ValidationError, validate

    from hushh_mcp.one_adk.world_model_azure import (
        _cap_unverified_contact,
        _report_schema,
        _structured_schema,
    )

    sources = {
        topic: [
            "s1",
            *[
                f"s{2 + group * 100 + index}"
                for group in range(3)
                if distinct_sources and (position % 7 + 1) & (1 << group)
                for index in range(100)
            ],
        ]
        for position, topic in enumerate(TOPICS)
    }
    schema = _report_schema({topic: [1] for topic in TOPICS}, sources)
    definitions = {}
    native = _structured_schema(schema, definitions=definitions)
    native["$defs"] = definitions

    def counts(value, key):
        if isinstance(value, dict):
            return len(value.get(key, [])) + sum(counts(item, key) for item in value.values())
        if isinstance(value, list):
            return sum(counts(item, key) for item in value)
        return 0

    assert counts(native, "properties") + 1 <= 100  # result envelope
    assert counts(native, "enum") <= 1000
    Draft202012Validator.check_schema(native)
    eligible = sorted({ref for rows in sources.values() for ref in rows})
    assert native["$defs"]["ProfileSourceRef"]["properties"]["ref"]["enum"] == eligible
    value = report(_cap_unverified_contact(assessment())["identity"])
    value.pop("coverage")
    validate(value, native)
    value["sections"][0]["facts"][0]["sources"][0]["ref"] = "s9999"
    with pytest.raises(ValidationError):
        validate(value, native)


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["budget", "time", "authority"])
async def test_report_repair_preserves_execution_boundaries(boundary):
    from hushh_mcp.one_adk.world_model import TASK_SECONDS
    from hushh_mcp.one_adk.world_model_azure import MAX_AZURE_MODEL_CALLS

    charges, snapshots = [], []
    clock, revoked = [0.0], [False]

    class BoundaryGateway(FakeGateway):
        async def structured(self, **kwargs):
            value = await super().structured(**kwargs)
            if kwargs["purpose"] == "world_model_report":
                if boundary == "time":
                    clock[0] = TASK_SECONDS - 20
                if boundary == "authority":
                    revoked[0] = True
            return value

    gateway = BoundaryGateway(charges=charges, snapshots=snapshots, unsearched_section=True)

    async def access():
        if revoked[0]:
            raise PermissionError("Synthetic revocation")

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    async def run():
        return await run_world_model_azure(
            identity=IDENTITY,
            user_id="owner",
            consent_token="synthetic",  # noqa: S106
            require_access=access,
            on_attempts_start=charge,
            on_progress=progress,
            owner_decisions={"rejected": ["An unrelated claim"]},
            gateway=gateway,
            monotonic_clock=lambda: clock[0],
            attempts_used=tuple(range(MODEL_FIRST + 4, MODEL_FIRST + MAX_AZURE_MODEL_CALLS))
            if boundary == "budget"
            else (),
        )

    if boundary == "time":
        assert await run() == {"status": "paused", "pkm_written": False, "restart_required": True}
    else:
        with pytest.raises(PermissionError if boundary == "authority" else ValueError):
            await run()
    assert "world_model_report_repair" not in gateway.calls
    assert gateway.calls.count("search") == 1


@pytest.mark.asyncio
async def test_resumed_report_at_fourteenth_model_call_repairs_without_search_replay():
    from hushh_mcp.one_adk.world_model_azure import _cap_unverified_contact

    snapshots, charges = [], []

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    async def charge(slots):
        charges.extend(slots)

    kwargs = dict(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
    )
    await run_world_model_azure(**kwargs, gateway=FakeGateway(charges=charges, snapshots=snapshots))
    work = copy.deepcopy(snapshots[-1])
    work.pop("pending_report")
    work.pop("fact_review")
    accepted = _cap_unverified_contact(assessment())["identity"]
    valid = report(accepted)
    valid.pop("coverage")  # Provider reports facts; the host owns all coverage rows.
    invalid = copy.deepcopy(valid)
    invalid["sections"][0]["kind"] = "travel"
    charges.clear()
    gateway = FakeGateway(charges=charges, snapshots=snapshots, report_results=[invalid, valid])
    result = await run_world_model_azure(
        **kwargs,
        work=work,
        attempts_used=(1, *range(MODEL_FIRST, MODEL_FIRST + 13)),
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert gateway.calls == [
        "world_model_report",
        "world_model_report_repair",
        "world_model_fact_review",
    ]
    assert charges == [MODEL_FIRST + 13, MODEL_FIRST + 14, MODEL_FIRST + 14 + 1]
    assert result["research"]["searches_used"] == 1


@pytest.mark.asyncio
async def test_azure_runner_does_not_assess_uncited_search():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, citations=False)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        gateway=gateway,
    )
    assert result == {"status": "unavailable", "pkm_written": False}
    assert charges == [1, MODEL_FIRST, MODEL_FIRST + 1]
    assert gateway.calls == ["search", "plan"]
    assert snapshots[-1]["attempts"]["1"]["state"] == "unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", ["prose", "oversized_question", "extra_field"])
async def test_azure_runner_offers_existing_receipts_when_planner_contract_fails(defect, caplog):
    charges, snapshots = [], []

    class InvalidPlanGateway(FakeGateway):
        async def plan(self, payload):
            value = await super().plan(
                {
                    key: value
                    for key, value in payload.items()
                    if key not in {"invalid_plan", "validation_errors"}
                }
            )
            if defect == "oversized_question":
                value["plan"]["question"] = "x" * 601
            if defect == "extra_field":
                value["plan"][IDENTITY["email"]] = "untrusted"
            return value

    gateway = InvalidPlanGateway(
        charges=charges,
        snapshots=snapshots,
        phi_non_json=defect == "prose",
        coverage_plan=defect != "prose",
    )

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["report"]["match_status"] == "uncertain"
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        *(["plan"] if defect != "prose" else []),
        "world_model_report",
        "world_model_fact_review",
    ]
    assert charges == [
        1,
        *range(MODEL_FIRST, MODEL_FIRST + 6 + int(defect != "prose")),
    ]
    assert "one.pwm_planner_stopped" in caplog.text
    if defect == "oversized_question":
        assert "string_too_long" in caplog.text
    assert "x" * 601 not in caplog.text
    assert IDENTITY["email"] not in caplog.text


@pytest.mark.asyncio
async def test_planner_reserves_compilation_and_review_before_buying_unusable_repair():
    charges, snapshots = [], []

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    kwargs = dict(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
    )
    await run_world_model_azure(**kwargs, gateway=FakeGateway(charges=charges, snapshots=snapshots))
    work = copy.deepcopy(snapshots[-1])
    work.pop("pending_report")
    work.pop("fact_review")
    charges.clear()

    class RepairedPlanGateway(FakeGateway):
        async def plan(self, payload):
            result = await super().plan(
                {k: v for k, v in payload.items() if k not in {"invalid_plan", "validation_errors"}}
            )
            if "invalid_plan" not in payload:
                result["plan"]["question"] = "x" * 601
            return result

        async def search(self, request):
            raise AssertionError("A follow-up search would consume the compilation budget")

    gateway = RepairedPlanGateway(charges=charges, snapshots=snapshots, coverage_plan=True)
    result = await run_world_model_azure(
        **kwargs,
        work=work,
        attempts_used=(1, *range(MODEL_FIRST, MODEL_FIRST + 11)),
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert gateway.calls == ["plan", "world_model_report", "world_model_fact_review"]
    assert charges == list(range(MODEL_FIRST + 11, MODEL_FIRST + 14))
    assert result["research"]["searches_used"] == 1


@pytest.mark.asyncio
async def test_azure_runner_offers_existing_receipts_after_phi_provider_error():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, phi_api_error=True)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["report"]["match_status"] == "uncertain"
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        "world_model_report",
        "world_model_fact_review",
    ]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 6)]


@pytest.mark.asyncio
async def test_azure_runner_reserves_final_report_time_after_cited_assessment():
    clock = [0.0]
    charges, snapshots = [], []

    class SlowInitialGateway(FakeGateway):
        async def search(self, request):
            response = await super().search(request)
            clock[0] += 80
            return response

        async def structured(self, **kwargs):
            response = await super().structured(**kwargs)
            clock[0] += 70 if kwargs["purpose"] == "identity_assessment" else 20
            return response

    gateway = SlowInitialGateway(charges=charges, snapshots=snapshots)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
        monotonic_clock=lambda: clock[0],
    )
    assert result["status"] == "offered"
    assert result["report"]["match_status"] == "uncertain"
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "world_model_report",
        "world_model_fact_review",
    ]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 4)]
    assert clock[0] == 190


@pytest.mark.asyncio
async def test_azure_runner_skips_planner_without_followup_time():
    clock = [0.0]
    charges, snapshots = [], []

    class SlowPlannerGateway(FakeGateway):
        async def search(self, request):
            response = await super().search(request)
            clock[0] += 50
            return response

        async def structured(self, **kwargs):
            response = await super().structured(**kwargs)
            clock[0] += 40 if kwargs["purpose"] == "identity_assessment" else 20
            return response

        async def plan(self, payload):
            await super().plan(payload)
            clock[0] += 30
            raise TimeoutError("Synthetic Phi tail latency")

    gateway = SlowPlannerGateway(charges=charges, snapshots=snapshots)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
        monotonic_clock=lambda: clock[0],
    )
    assert result["status"] == "offered"
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "world_model_report",
        "world_model_fact_review",
    ]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 5)]
    assert clock[0] == 150


@pytest.mark.asyncio
@pytest.mark.parametrize("realistic_latency", [False, True])
@pytest.mark.parametrize("repair_plan", [False, True])
@pytest.mark.parametrize("receipt_missing", [False, True])
async def test_azure_runner_allows_coverage_for_review_candidate_without_linking_owner(
    realistic_latency,
    repair_plan,
    receipt_missing,
):
    charges, snapshots = [], []
    clock = [0.0]

    class TimedGateway(FakeGateway):
        async def search(self, request):
            result = await super().search(request)
            clock[0] += 20 if realistic_latency else 0
            if receipt_missing and self.calls.count("search") == 2:
                result.pop("tool_usage")
            return result

        async def structured(self, **kwargs):
            result = await super().structured(**kwargs)
            if realistic_latency:
                clock[0] += {"identity_assessment": 15, "provisional_findings": 8}.get(
                    kwargs["purpose"], 20
                )
            return result

        async def plan(self, payload):
            is_repair = "invalid_plan" in payload
            public_context = {
                k: v for k, v in payload.items() if k not in {"invalid_plan", "validation_errors"}
            }
            result = await super().plan(public_context)
            if repair_plan and not is_repair:
                result["plan"]["anchor_ids"] = ["a1"] * 5
            if is_repair:
                assert payload["invalid_plan"]["plan"]["anchor_ids"] == ["a1"] * 5
                assert payload["validation_errors"] == [
                    {"path": ["anchor_ids"], "type": "too_long"}
                ]
            clock[0] += 12 if realistic_latency else 0
            return result

    gateway = TimedGateway(charges=charges, snapshots=snapshots, coverage_plan=True)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
        monotonic_clock=lambda: clock[0],
    )
    assert result["status"] == "offered"
    assert result["report"]["match_status"] == "uncertain"
    assert result["research"]["identity"]["state"] == "candidate_for_review"
    assert result["research"]["searches_used"] == 2
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        *(["plan"] if repair_plan else []),
        "search",
        *([] if receipt_missing else ["identity_assessment"]),
        *(
            []
            if receipt_missing or (repair_plan and realistic_latency)
            else ["provisional_findings"]
        ),
        "world_model_report",
        "world_model_fact_review",
    ]
    if receipt_missing:
        assert snapshots[-1]["attempts"]["2"]["observed"] is False
        assert snapshots[-1]["attempts"]["2"]["state"] == "unavailable"
        assert "bing_requests" not in snapshots[-1]["attempts"]["2"]
        assert result["_provider_usage"]["bing_requests"] is None


@pytest.mark.asyncio
async def test_azure_runner_refuses_contact_seed_for_review_candidate_coverage():
    charges, snapshots = [], []
    gateway = FakeGateway(
        charges=charges,
        snapshots=snapshots,
        coverage_plan=True,
        coverage_with_contact=True,
    )

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["research"]["searches_used"] == 1
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        "plan",
        "world_model_report",
        "world_model_fact_review",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", ["missing_selection", "schema_bound", "unbridged_profiles"])
async def test_azure_runner_repairs_invalid_identity_without_repeating_search(defect):
    invalid = assessment()
    if defect == "missing_selection":
        invalid["identity"].update(
            state="ambiguous", selected_candidate_id=None, supporting_anchor_ids=[]
        )
    elif defect == "unbridged_profiles":
        invalid["anchors"].append({**invalid["anchors"][0], "id": "a2", "source_refs": ["s2"]})
        invalid["candidates"][0]["anchor_ids"].append("a2")
    else:
        invalid["candidates"][0]["label"] = "x" * 601
    charges, snapshots = [], []

    class IdentityGateway(FakeGateway):
        async def structured(self, **kwargs):
            value = await super().structured(**kwargs)
            if defect == "unbridged_profiles" and kwargs["purpose"] == "identity_assessment_repair":
                value["candidates"] = value["candidates"][0]
                value["candidates"]["anchor_ids"] = "a1"
                value["anchors"] = value["anchors"][0]
                value["anchors"]["source_refs"] = "s1"
                value["identity"]["supporting_anchor_ids"] = "a1"
            return value

        async def search(self, request):
            raw = await super().search(request)
            if defect == "unbridged_profiles":
                raw["output"][1]["content"][0]["annotations"].append(
                    {
                        "type": "url_citation",
                        "start_index": 11,
                        "end_index": 20,
                        "title": "Other public profile",
                        "url": "https://example.test/unlinked-profile",
                    }
                )
            return raw

    gateway = IdentityGateway(
        charges=charges,
        snapshots=snapshots,
        assessment_results=[invalid, assessment()],
    )

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["research"]["identity"]["state"] == "candidate_for_review"
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "identity_assessment_repair",
        "provisional_findings",
        "plan",
        "world_model_report",
        "world_model_fact_review",
    ]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 7)]
    original, repaired = gateway.assessment_payloads
    assert repaired["identity"] == original["identity"]
    assert repaired["research_history"] == original["research_history"]
    assert repaired["invalid_assessment"] == invalid
    assert repaired["validation_errors"] == [
        {"path": [], "type": "value_error"}
        if defect == "missing_selection"
        else {
            "path": ["candidates"],
            "type": "missing_received_profile_bridge",
            "disconnected_source_groups": [["s1"], ["s2"]],
        }
        if defect == "unbridged_profiles"
        else {"path": ["candidates", 0, "label"], "type": "string_too_long"}
    ]
    assert "usage_records" not in repaired["research_history"]
    assert "An unrelated claim" not in json.dumps(repaired)
    assert all(
        "assessment" not in snapshot
        or snapshot["assessment"]["identity"]["selected_candidate_id"] == "c1"
        for snapshot in snapshots
    )


@pytest.mark.parametrize(
    "bridge", ["connected", "same_url", "orphan", "foreign", "partial", "self_link"]
)
def test_selected_candidate_sources_require_received_link_connections(bridge):
    from hushh_mcp.one_adk.world_model_azure import (
        _cap_unverified_contact,
        _validate_candidate_sources,
    )
    from hushh_mcp.one_adk.world_model_contracts import IdentityAssessment

    value = _cap_unverified_contact(assessment())
    value["anchors"].append({**value["anchors"][0], "id": "a2", "source_refs": ["s2"]})
    # a2 is intentionally omitted from candidate.anchor_ids: it still owns sources.
    receipts = {
        "s1": {"url": URL},
        "s2": {"url": URL if bridge in {"same_url", "self_link"} else "https://example.test/other"},
    }
    if bridge in {"connected", "foreign", "partial", "self_link"}:
        value["anchors"].append(
            {
                **value["anchors"][0],
                "id": "a3",
                "kind": "reciprocal_link",
                "source_refs": ["s1", "s2"],
            }
        )
    if bridge == "foreign":
        value["anchors"][-1]["candidate_id"] = "c2"
        value["candidates"].append(
            {"id": "c2", "label": "Other person", "anchor_ids": ["a3"], "blocking_conflicts": []}
        )
    if bridge == "partial":
        value["anchors"].append({**value["anchors"][0], "id": "a4", "source_refs": ["s3"]})
        receipts["s3"] = {"url": "https://example.test/disconnected"}
    accepted = IdentityAssessment.model_validate(value).validate_evidence(
        identity=IDENTITY, source_refs=set(receipts)
    )
    if bridge in {"connected", "same_url"}:
        assert _validate_candidate_sources(accepted, receipts) is accepted
    else:
        with pytest.raises(ValueError):
            _validate_candidate_sources(accepted, receipts)


def test_report_projection_keeps_unanchored_coverage_as_a_lead_not_a_finding():
    from hushh_mcp.one_adk.world_model_azure import _cap_unverified_contact, _report_history
    from hushh_mcp.one_adk.world_model_contracts import IdentityAssessment

    accepted = IdentityAssessment.model_validate(_cap_unverified_contact(assessment()))
    work = {
        "sources": {
            "s1": {"title": "Public bio", "url": URL},
            "s2": {"title": "UNLINKED_SOURCE", "url": "https://example.test/unlinked"},
        },
        "attempts": {
            "1": {
                "plan": {
                    "purpose": "coverage",
                    "candidate_id": "c1",
                    "seed_fields": ["full_name"],
                    "anchor_ids": ["a1"],
                    "topics": ["career"],
                    "question": "Public work",
                },
                "observed": True,
                "source_refs": ["s2"],
            }
        },
        "finding_batches": [
            {
                "candidate_id": "c1",
                "attempt_id": 1,
                "topic": "career",
                "facts": [
                    {
                        "statement": "UNLINKED_CLAIM",
                        "confidence": "supported",
                        "sources": [{"ref": "s2", "title": "UNLINKED_SOURCE"}],
                    }
                ],
            }
        ],
    }
    before = copy.deepcopy(work)
    projected = _report_history(work, accepted)
    assert projected["finding_batches"] == []
    assert set(projected["sources"]) == {"s1"}
    assert "UNLINKED" not in json.dumps(projected)
    assert work == before


@pytest.mark.parametrize("no_match", [False, True])
def test_single_page_identity_repair_preserves_model_choice_and_original_validation(no_match):
    from jsonschema import ValidationError, validate

    from hushh_mcp.one_adk.world_model_azure import (
        _expand_single_page_assessment,
        _single_page_assessment_schema,
        _validate_candidate_sources,
    )
    from hushh_mcp.one_adk.world_model_contracts import IdentityAssessment

    schema = _single_page_assessment_schema(["s1", "s2"])
    large = _single_page_assessment_schema([f"s{index}" for index in range(1, 1101)])
    assert large["$defs"]["IdentityAnchor"]["properties"]["source_refs"] == {"type": "string"}
    value = assessment(source_ref="s2")
    value["identity"]["state"] = "candidate_for_review"
    value["candidates"] = value["candidates"][0]
    value["candidates"]["anchor_ids"] = "a1"
    value["anchors"] = value["anchors"][0]
    value["anchors"].update(source_refs="s2", kind="public_profile")
    value["identity"]["supporting_anchor_ids"] = "a1"
    if no_match:
        value.update(candidates=None, anchors=None)
        value["identity"].update(
            state="no_match", selected_candidate_id=None, supporting_anchor_ids=None
        )
    before = copy.deepcopy(value)
    validate(value, schema)
    expanded = _expand_single_page_assessment(value)
    accepted = IdentityAssessment.model_validate(expanded).validate_evidence(
        identity=IDENTITY, source_refs={"s1", "s2"}
    )
    _validate_candidate_sources(
        accepted, {"s1": {"url": URL}, "s2": {"url": "https://example.test/second"}}
    )
    assert value == before
    assert (
        expanded["identity"]["selected_candidate_id"] == value["identity"]["selected_candidate_id"]
    )
    assert accepted.identity.state == ("no_match" if no_match else "candidate_for_review")
    if not no_match:
        assert accepted.anchors[0].source_refs == ["s2"]  # Model chose s2, not host-first s1.
        invalid = copy.deepcopy(value)
        invalid["anchors"]["source_refs"] = ["s1", "s2"]
        with pytest.raises(ValidationError):
            validate(invalid, schema)
        invalid = copy.deepcopy(value)
        invalid["anchors"]["candidate_id"] = "c2"
        with pytest.raises(ValueError, match="Unknown candidate"):
            IdentityAssessment.model_validate(
                _expand_single_page_assessment(invalid)
            ).validate_evidence(identity=IDENTITY, source_refs={"s1", "s2"})


@pytest.mark.asyncio
async def test_final_report_rejects_observed_coverage_outside_owned_candidate_sources():
    from hushh_mcp.one_adk.world_model_azure import _cap_unverified_contact

    valid = report(_cap_unverified_contact(assessment())["identity"])
    invalid = copy.deepcopy(valid)
    invalid["sections"][0]["facts"][0]["sources"][0]["ref"] = "s2"
    charges, snapshots = [], []

    class CoverageGateway(FakeGateway):
        async def search(self, request):
            raw = await super().search(request)
            if self.calls.count("search") == 2:
                raw["output"][1]["content"][0]["annotations"].append(
                    {
                        "type": "url_citation",
                        "start_index": 11,
                        "end_index": 20,
                        "title": "Unlinked coverage lead",
                        "url": "https://example.test/unlinked",
                    }
                )
            return raw

        async def plan(self, payload):
            if self.calls.count("search") == 2:
                self.calls.append("plan")
                return {"action": "finish", "plan": None}
            return await super().plan(payload)

    gateway = CoverageGateway(
        charges=charges,
        snapshots=snapshots,
        coverage_plan=True,
        report_results=[invalid, valid],
    )

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert gateway.calls.count("search") == 2
    assert snapshots[-1]["attempts"]["2"]["observed"] is True
    assert "s2" in snapshots[-1]["attempts"]["2"]["source_refs"]
    assert gateway.calls[-3:] == [
        "world_model_report",
        "world_model_report_repair",
        "world_model_fact_review",
    ]
    assert set(gateway.report_requests[0]["payload"]["research_history"]["sources"]) == {"s1"}
    assert result["report"]["sections"][0]["facts"][0]["sources"][0]["url"] == URL
    assert len(charges) == len(set(charges))


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["time", "budget", "authority"])
async def test_identity_repair_preserves_authority_and_report_reserve(boundary):
    from hushh_mcp.one_adk.world_model_azure import MAX_AZURE_MODEL_CALLS

    charges, snapshots = [], []
    clock = [0.0]
    revoked = False

    class BoundaryGateway(FakeGateway):
        async def structured(self, **kwargs):
            nonlocal revoked
            result = await super().structured(**kwargs)
            if kwargs["purpose"] == "identity_assessment":
                if boundary == "time":
                    from hushh_mcp.one_adk.world_model import TASK_SECONDS
                    from hushh_mcp.one_adk.world_model_azure import FINAL_REPORT_RESERVE_SECONDS

                    clock[0] = TASK_SECONDS - FINAL_REPORT_RESERVE_SECONDS
                if boundary == "authority":
                    revoked = True
            return result

    gateway = BoundaryGateway(
        charges=charges, snapshots=snapshots, invalid_assessment="missing_ref"
    )

    async def access():
        if revoked:
            raise PermissionError("Synthetic authority revoked")

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    async def run():
        return await run_world_model_azure(
            identity=IDENTITY,
            user_id="owner",
            consent_token="synthetic",  # noqa: S106 - synthetic test authority
            require_access=access,
            on_attempts_start=charge,
            on_progress=progress,
            gateway=gateway,
            monotonic_clock=lambda: clock[0],
            attempts_used=tuple(range(MODEL_FIRST + 4, MODEL_FIRST + MAX_AZURE_MODEL_CALLS))
            if boundary == "budget"
            else (),
        )

    if boundary == "time":
        assert await run() == {"status": "paused", "pkm_written": False, "restart_required": True}
    else:
        with pytest.raises(PermissionError if boundary == "authority" else ValueError):
            await run()
    assert gateway.calls == ["search", "identity_assessment"]
    assert charges == [1, MODEL_FIRST, MODEL_FIRST + 1]
    assert all("assessment" not in snapshot for snapshot in snapshots)


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", ["missing_ref", "cross_candidate"])
async def test_azure_runner_rejects_unsupported_identity(defect):
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, invalid_assessment=defect)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    with pytest.raises(ValueError):
        await run_world_model_azure(
            identity=IDENTITY,
            user_id="owner",
            consent_token="synthetic",  # noqa: S106 - synthetic test authority
            require_access=AsyncMock(),
            on_attempts_start=charge,
            on_progress=progress,
            gateway=gateway,
        )
    assert charges == [1, MODEL_FIRST, MODEL_FIRST + 1, MODEL_FIRST + 2]
    assert gateway.calls == ["search", "identity_assessment", "identity_assessment_repair"]
    assert all("assessment" not in snapshot for snapshot in snapshots)


@pytest.mark.asyncio
async def test_azure_runner_downgrades_claimed_owner_link_without_contact_on_cited_page():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, answer_has_contact=False)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["report"]["match_status"] == "uncertain"
    assert result["research"]["identity"]["state"] == "candidate_for_review"
    assert snapshots[-1]["assessment"]["anchors"][0]["kind"] == "public_profile"
    assert snapshots[-1]["assessment"]["identity"]["next_step"] == "review"


@pytest.mark.asyncio
async def test_azure_runner_will_not_retry_unacknowledged_bing_spend():
    gateway = FakeGateway(charges=[], snapshots=[])
    charge = AsyncMock()
    history = {
        "azure_work_version": 1,
        "sources": {},
        "attempts": {
            "1": {
                "plan": {
                    "purpose": "identity",
                    "seed_fields": ["full_name", "email"],
                    "anchor_ids": [],
                    "candidate_id": None,
                    "topics": ["career"],
                    "question": "Synthetic lookup",
                },
                "query_key": "prior",
                "observed": False,
                "answer": "",
                "source_refs": [],
                "state": "started",
            }
        },
        "search_suggestions": [],
    }
    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        attempts_used=(1, MODEL_FIRST),
        work=history,
        gateway=gateway,
    )
    assert result == {"status": "unavailable", "pkm_written": False, "research_exhausted": True}
    assert gateway.calls == []
    charge.assert_not_awaited()


@pytest.mark.asyncio
async def test_azure_runner_caps_resume_assessment_and_billed_searches():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots)
    history = {
        "azure_work_version": 1,
        "sources": {"s1": {"title": "Public bio", "url": URL}},
        "attempts": {
            "1": {
                "plan": {
                    "purpose": "identity",
                    "seed_fields": ["full_name", "email"],
                    "anchor_ids": [],
                    "candidate_id": None,
                    "topics": ["career"],
                    "question": "Synthetic lookup",
                },
                "query_key": "prior",
                "observed": True,
                "answer": "A public bio names Alex Example.",
                "source_refs": ["s1"],
                "state": "received",
                "bing_requests": 16,
            }
        },
        "assessment": assessment(),
        "search_suggestions": [],
    }

    async def charge(slots):
        charges.extend(slots)

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        attempts_used=(1, MODEL_FIRST),
        work=history,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert result["report"]["match_status"] == "uncertain"
    assert result["research"]["identity"]["state"] == "candidate_for_review"
    assert gateway.calls == [
        "provisional_findings",
        "world_model_report",
        "world_model_fact_review",
    ]
    assert charges == [MODEL_FIRST + 1, MODEL_FIRST + 2, MODEL_FIRST + 2 + 1]


@pytest.mark.asyncio
async def test_azure_runner_does_not_rebuy_recorded_finding_on_resume():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots)
    history = {
        "azure_work_version": 1,
        "sources": {"s1": {"title": "Public bio", "url": URL}},
        "attempts": {
            "1": {
                "plan": {
                    "purpose": "identity",
                    "seed_fields": ["full_name", "email"],
                    "anchor_ids": [],
                    "candidate_id": None,
                    "topics": ["digital_presence", "career"],
                    "question": "Synthetic lookup",
                },
                "query_key": "prior",
                "observed": True,
                "answer": "A public bio names Alex Example.",
                "source_refs": ["s1"],
                "citations": [
                    {"start_index": 0, "end_index": 10, "title": "Public bio", "url": URL}
                ],
                "state": "received",
                "bing_requests": 16,
            }
        },
        "assessment": assessment(),
        "finding_batches": [
            {
                "candidate_id": "c1",
                "attempt_id": 1,
                "topic": "digital_presence",
                "facts": [
                    {
                        "statement": "A public bio names Alex Example.",
                        "confidence": "supported",
                        "sources": [{"title": "Public bio", "ref": "s1"}],
                    }
                ],
            }
        ],
        "finding_attempts": {"1": {"state": "recorded", "at": 1.0}},
        "search_suggestions": [],
    }

    async def charge(slots):
        charges.extend(slots)

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        attempts_used=(1, MODEL_FIRST, MODEL_FIRST + 1, MODEL_FIRST + 2),
        work=history,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    assert result["status"] == "offered"
    assert gateway.calls == ["world_model_report", "world_model_fact_review"]
    assert charges == [MODEL_FIRST + 3, MODEL_FIRST + 3 + 1]
    assert len(validated_facts_from_work(history)) == 1


@pytest.mark.asyncio
async def test_azure_runner_rejects_checkpoint_from_another_provider():
    with pytest.raises(ValueError, match="another research provider"):
        await run_world_model_azure(
            identity=IDENTITY,
            user_id="owner",
            consent_token="synthetic",  # noqa: S106 - synthetic test authority
            require_access=AsyncMock(),
            on_attempts_start=AsyncMock(),
            work={"sources": {}, "attempts": {}},
            gateway=FakeGateway(charges=[], snapshots=[]),
        )


@pytest.mark.asyncio
async def test_azure_gateway_rejects_parseable_but_incomplete_report():
    usage_received = AsyncMock()
    gateway = AzurePwmGateway(
        primary_endpoint="https://synthetic.openai.azure.com/openai/v1/",
        primary_deployment="primary",
        primary_token_supplier=lambda: "synthetic",
        phi_endpoint="https://synthetic.services.ai.azure.com/openai/v1/",
        phi_deployment="phi",
        phi_token_supplier=lambda: "synthetic",
        on_usage=usage_received,
    )
    response = SimpleNamespace(
        status="incomplete",
        incomplete_details=None,
        output_text="{}",
        usage={
            "input_tokens": 120,
            "output_tokens": 35,
            "input_tokens_details": {"cached_tokens": 20},
            "private_text": "SYNTHETIC_SECRET_MUST_NOT_ENTER_ACCOUNTING",
        },
    )

    class FakeClient:
        responses = SimpleNamespace(create=AsyncMock(return_value=response))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    async def fake_client(_endpoint, _supplier):
        return FakeClient()

    gateway._client = fake_client
    with pytest.raises(ValueError, match="did not complete"):
        await gateway.structured(
            purpose="world_model_report",
            instruction="Synthetic instruction",
            payload={},
            schema={},
            max_output_tokens=8192,
        )
    usage_received.assert_awaited_once()
    receipt = usage_received.await_args.args[0]
    assert (receipt.input_tokens, receipt.output_tokens, receipt.cached_input_tokens) == (
        120,
        35,
        20,
    )
    assert "SYNTHETIC_SECRET" not in receipt.model_dump_json()


@pytest.mark.asyncio
@pytest.mark.parametrize("repair", [False, True])
async def test_numeric_usage_survives_resume_without_entering_model_history(monkeypatch, repair):
    from hushh_mcp.one_adk import world_model_azure as runner

    charges, snapshots = [], []

    class MeteredGateway(FakeGateway):
        def __init__(self, **kwargs):
            invalid = assessment()
            invalid["identity"].update(
                state="ambiguous", selected_candidate_id=None, supporting_anchor_ids=[]
            )
            super().__init__(
                charges=charges,
                snapshots=snapshots,
                assessment_results=[invalid, assessment()] if repair else None,
            )
            self.on_usage = kwargs["on_usage"]

        async def meter(self):
            await self.on_usage(
                UsageReceipt(
                    input_tokens=100, output_tokens=20, cached_input_tokens=10, elapsed_ms=5
                )
            )

        async def search(self, request):
            result = await super().search(request)
            await self.meter()
            return result

        async def structured(self, **kwargs):
            assert "usage_records" not in kwargs["payload"].get("research_history", {})
            result = await super().structured(**kwargs)
            await self.meter()
            return result

        async def plan(self, payload):
            assert "usage_records" not in payload["research_history"]
            result = await super().plan(payload)
            await self.meter()
            return result

    monkeypatch.setattr(runner, "AzurePwmGateway", MeteredGateway)

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    async def run(work=None):
        return await run_world_model_azure(
            identity=IDENTITY,
            user_id="owner",
            consent_token="synthetic",  # noqa: S106
            primary_token_supplier=lambda: "synthetic",
            require_access=AsyncMock(),
            on_attempts_start=charge,
            on_progress=progress,
            attempts_used=tuple(charges),
            owner_decisions={"rejected": ["An unrelated claim"]},
            work=work,
        )

    first = await run()
    first_work = copy.deepcopy(snapshots[-1])
    assert first["_provider_usage"]["input_tokens"] == 100 * first["_provider_usage"]["model_calls"]
    resumed = await run(first_work)
    usage = resumed["_provider_usage"]
    assert usage["model_calls"] == usage["recorded_calls"]
    assert usage["input_tokens"] == 100 * usage["model_calls"]
    assert usage["output_tokens"] == 20 * usage["model_calls"]
    assert usage["cached_input_tokens"] == 10 * usage["model_calls"]
    assert usage["bing_requests"] == 1
    # Identity/policy resets can retain paid slots while dropping old work.
    # A retained count must not masquerade as the whole discovery's bill.
    assert runner.checkpoint_usage(snapshots[-1], [*charges, 2])["bing_requests"] is None
    assert runner.checkpoint_usage({"azure_work_version": 1}, charges)["input_tokens"] is None
    assert all(
        snapshots[-1]["usage_records"][key] == value
        for key, value in first_work["usage_records"].items()
    )


@pytest.mark.asyncio
async def test_azure_gateway_bounds_web_search_reasoning_and_sdk_retries():
    gateway = AzurePwmGateway(
        primary_endpoint="https://synthetic.openai.azure.com/openai/v1/",
        primary_deployment="primary",
        primary_token_supplier=lambda: "synthetic",
        phi_endpoint="https://synthetic.services.ai.azure.com/openai/v1/",
        phi_deployment="phi",
        phi_token_supplier=lambda: "synthetic",
    )
    client = await gateway._client(gateway.primary_endpoint, gateway.primary_token_supplier)
    try:
        assert client.max_retries == 0
        assert client.timeout == 90.0
    finally:
        await client.close()

    result = search_response()

    class FakeClient:
        responses = SimpleNamespace(
            create=AsyncMock(return_value=SimpleNamespace(model_dump=lambda **_kwargs: result))
        )

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    async def fake_client(_endpoint, _supplier):
        return FakeClient()

    gateway._client = fake_client
    assert await gateway.search({"research_question": "Synthetic"}) == result
    kwargs = FakeClient.responses.create.call_args.kwargs
    assert kwargs["reasoning"] == {"effort": "low"}
    assert kwargs["tools"] == [{"type": "web_search", "search_context_size": "medium"}]
    assert kwargs["max_output_tokens"] == 6000
    assert kwargs["max_tool_calls"] == 2 and kwargs["store"] is False
    from hushh_mcp.one_adk.world_model import manifest

    assert kwargs["instructions"].startswith(manifest().system_instruction)


@pytest.mark.asyncio
async def test_primary_planner_uses_native_schema_and_needs_no_phi_credentials():
    gateway = AzurePwmGateway(
        primary_endpoint="https://synthetic.openai.azure.com/openai/v1/",
        primary_deployment="primary",
        primary_token_supplier=lambda: "synthetic",
    )
    response = SimpleNamespace(
        status="completed",
        incomplete_details=None,
        output_text=json.dumps({"result": {"action": "finish", "plan": None}}),
    )
    create = AsyncMock(return_value=response)

    class FakeClient:
        responses = SimpleNamespace(create=create)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    client = AsyncMock(return_value=FakeClient())
    gateway._client = client
    assert await gateway.plan({"available_seed_fields": ["full_name"]}) == {
        "action": "finish",
        "plan": None,
    }
    client.assert_awaited_once_with(gateway.primary_endpoint, gateway.primary_token_supplier)
    kwargs = create.call_args.kwargs
    assert kwargs["model"] == "primary" and kwargs["store"] is False
    assert kwargs["text"]["format"]["type"] == "json_schema"
    assert kwargs["text"]["format"]["strict"] is True
    from jsonschema import Draft202012Validator, ValidationError

    from hushh_mcp.one_adk.world_model_azure import _cap_unverified_contact, _planner_schema
    from hushh_mcp.one_adk.world_model_contracts import IdentityAssessment

    reviewed = IdentityAssessment.model_validate(_cap_unverified_contact(assessment()))
    await gateway.plan({"query_plan_schema": _planner_schema(IDENTITY, reviewed)})
    native = create.call_args.kwargs["text"]["format"]["schema"]
    coverage = {
        "purpose": "coverage",
        "seed_fields": ["full_name"],
        "anchor_ids": ["a1"],
        "candidate_id": "c1",
        "topics": ["career"],
        "question": "Find public work.",
    }
    validator = Draft202012Validator(native)

    def envelope(plan):
        return {"result": {"action": "search", "plan": plan}}

    validator.validate(envelope(coverage))
    for changed in ({"seed_fields": ["email"]}, {"candidate_id": "c2"}, {"anchor_ids": ["a2"]}):
        with pytest.raises(ValidationError):
            validator.validate(envelope({**coverage, **changed}))
    validator.validate(envelope({**coverage, "purpose": "identity", "seed_fields": ["email"]}))
    # A malformed envelope is a provider failure, never a replacement decision.
    response.output_text = '{"action":"finish","plan":null}'
    with pytest.raises(ValueError, match="result envelope"):
        await gateway.plan({})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "contract",
    ["assessment", "findings", "report", "report_repair", "fact_review", "fact_review_repair"],
)
async def test_native_schema_preserves_resolvable_refs_and_host_bounds(contract):
    from jsonschema import Draft202012Validator

    from hushh_mcp.one_adk.world_model_azure import (
        _FINDING_SCHEMA,
        _fact_review_instruction,
        _finding_instruction,
        _report_instruction,
        manifest,
    )
    from hushh_mcp.one_adk.world_model_contracts import (
        FactReviewSelection,
        IdentityAssessment,
        WorldModelReport,
    )

    schema = {
        "assessment": IdentityAssessment.model_json_schema(),
        "findings": _FINDING_SCHEMA,
        "report": WorldModelReport.model_json_schema(),
        "report_repair": WorldModelReport.model_json_schema(),
        "fact_review": FactReviewSelection.model_json_schema(),
        "fact_review_repair": FactReviewSelection.model_json_schema(),
    }[contract]
    gateway = AzurePwmGateway(
        primary_endpoint="https://synthetic.openai.azure.com/openai/v1/",
        primary_deployment="primary",
        primary_token_supplier=lambda: "synthetic",
    )
    value = (
        assessment()
        if contract == "assessment"
        else {
            "candidate_id": "c1",
            "attempt_id": 1,
            "topic": "career",
            "facts": report(assessment()["identity"])["sections"][0]["facts"],
        }
        if contract == "findings"
        else {"kept_fact_ids": ["f1"], "summary": "Reviewed public findings."}
        if contract in {"fact_review", "fact_review_repair"}
        else report(assessment()["identity"])
    )
    create = AsyncMock(
        return_value=SimpleNamespace(
            status="completed",
            incomplete_details=None,
            output_text=json.dumps({"result": value}),
        )
    )

    class Client:
        responses = SimpleNamespace(create=create)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    gateway._client = AsyncMock(return_value=Client())
    assert (
        await gateway.structured(
            purpose={
                "assessment": "identity_assessment",
                "findings": "provisional_findings",
                "report": "world_model_report",
                "report_repair": "world_model_report_repair",
                "fact_review": "world_model_fact_review",
                "fact_review_repair": "world_model_fact_review_repair",
            }[contract],
            instruction=_finding_instruction()
            if contract == "findings"
            else _report_instruction(repair=contract == "report_repair")
            if contract in {"report", "report_repair"}
            else _fact_review_instruction()
            if contract in {"fact_review", "fact_review_repair"}
            else "Synthetic evaluation",
            payload={},
            schema=schema,
            max_output_tokens=2048,
        )
        == value
    )
    assert create.call_args.kwargs["reasoning"] == {
        "effort": "high"
        if contract in {"report", "report_repair"}
        else "medium"
        if contract in {"assessment", "findings", "fact_review", "fact_review_repair"}
        else "low"
    }
    if contract in {"findings", "report", "report_repair", "fact_review", "fact_review_repair"}:
        # Compilation must not inherit the whole research task's unrelated
        # duties. That composition produced padding even with high reasoning.
        assert create.call_args.kwargs["instructions"] == (
            _finding_instruction()
            if contract == "findings"
            else _fact_review_instruction()
            if contract in {"fact_review", "fact_review_repair"}
            else _report_instruction(repair=contract == "report_repair")
        )
        assert "AZURE EXECUTION STAGE" not in create.call_args.kwargs["instructions"]
        # Prompt compaction must retain authored privacy and owner-decision
        # boundaries in extraction, compilation AND its failure repair.
        shared_boundaries = (
            manifest()
            .system_instruction.split("BEGIN AZURE OUTPUT BOUNDARIES INSTRUCTION\n", 1)[1]
            .split("\nEND AZURE OUTPUT BOUNDARIES INSTRUCTION", 1)[0]
            .strip()
        )
        assert shared_boundaries in create.call_args.kwargs["instructions"]
    native = create.call_args.kwargs["text"]["format"]["schema"]
    Draft202012Validator(native).validate({"result": value})
    assert "$defs" not in native["properties"]["result"]
    assert (
        schema
        == {
            "assessment": IdentityAssessment.model_json_schema(),
            "findings": _FINDING_SCHEMA,
            "report": WorldModelReport.model_json_schema(),
            "report_repair": WorldModelReport.model_json_schema(),
            "fact_review": FactReviewSelection.model_json_schema(),
            "fact_review_repair": FactReviewSelection.model_json_schema(),
        }[contract]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("selection_ids", [["f1"], [], ["f99"], ["f1", "f1"]])
async def test_fact_review_uses_only_model_selected_immutable_facts(selection_ids):
    from hushh_mcp.one_adk.world_model_azure import _cap_unverified_contact

    charges, snapshots = [], []
    accepted_identity = _cap_unverified_contact(assessment())["identity"]
    proposed = report(accepted_identity)
    original = copy.deepcopy(proposed["sections"][0]["facts"][0])
    proposed["sections"][0]["facts"].append(
        {**original, "statement": "The exact supplied contact was not found."}
    )
    gateway = FakeGateway(charges=charges, snapshots=snapshots, report_results=[proposed])
    structured = gateway.structured

    async def select(**kwargs):
        if kwargs["purpose"] not in {"world_model_fact_review", "world_model_fact_review_repair"}:
            return await structured(**kwargs)
        gateway.calls.append(kwargs["purpose"])
        assert charges[-1] in range(MODEL_FIRST, MODEL_FIRST + 16)
        assert kwargs["payload"]["proposed_facts"][0]["statement"] == original["statement"]
        assert kwargs["payload"]["owner_decisions"] == {
            "confirmed": [],
            "rejected": ["An unrelated claim"],
        }
        return {"kept_fact_ids": selection_ids, "summary": "Reviewed public findings."}

    gateway.structured = select

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    async def run():
        return await run_world_model_azure(
            identity=IDENTITY,
            user_id="owner",
            consent_token="synthetic",  # noqa: S106 - synthetic test authority
            require_access=AsyncMock(),
            on_attempts_start=charge,
            on_progress=progress,
            owner_decisions={"rejected": ["An unrelated claim"]},
            gateway=gateway,
        )

    if selection_ids in (["f99"], ["f1", "f1"]):
        with pytest.raises(ValueError, match="unoffered|repeats"):
            await run()
        assert "pending_report" in snapshots[-1]
        assert "fact_review" not in snapshots[-1]
        assert gateway.calls.count("world_model_fact_review_repair") == 1
        return
    result = await run()
    assert result["status"] == "offered"
    assert result["pkm_written"] is False
    assert result["research"]["identity"] == accepted_identity
    assert result["report"]["summary"] == "Reviewed public findings."
    if selection_ids:
        fact = result["report"]["sections"][0]["facts"][0]
        assert fact["statement"] == original["statement"]
        assert fact["confidence"] == original["confidence"]
        assert fact["sources"] == [{"title": "Public bio", "url": URL}]
        assert len(result["report"]["sections"][0]["facts"]) == 1
    else:
        assert result["report"]["sections"] == []
        assert result["report"]["match_status"] == "uncertain"
    assert snapshots[-1]["pending_report"]["sections"] == proposed["sections"]
    assert snapshots[-1]["fact_review"]["selection"]["kept_fact_ids"] == selection_ids


@pytest.mark.asyncio
@pytest.mark.parametrize("defect", ["summary_bound", "unknown_id", "duplicate_id"])
async def test_fact_review_repairs_one_invalid_selection_without_rebuying_evidence(defect, caplog):
    charges, snapshots, review_requests = [], [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots)
    structured = gateway.structured
    invalid = {
        "kept_fact_ids": ["f99"]
        if defect == "unknown_id"
        else ["f1", "f1"]
        if defect == "duplicate_id"
        else ["f1"],
        "summary": "untrusted-owner-text" * 30 if defect == "summary_bound" else "Reviewed facts.",
    }

    async def select(**kwargs):
        if kwargs["purpose"] not in {"world_model_fact_review", "world_model_fact_review_repair"}:
            return await structured(**kwargs)
        gateway.calls.append(kwargs["purpose"])
        review_requests.append(copy.deepcopy(kwargs))
        return (
            copy.deepcopy(invalid)
            if len(review_requests) == 1
            else {"kept_fact_ids": ["f1"], "summary": "One source-attributed finding."}
        )

    gateway.structured = select

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=gateway,
    )
    initial, repaired = review_requests
    assert repaired["purpose"] == "world_model_fact_review_repair"
    assert repaired["schema"] == initial["schema"]
    assert repaired["payload"] == {
        **initial["payload"],
        "invalid_selection": invalid,
        "validation_errors": repaired["payload"]["validation_errors"],
    }
    assert repaired["payload"]["validation_errors"]
    assert gateway.calls.count("search") == 1
    assert gateway.calls.count("world_model_report") == 1
    assert gateway.calls.count("world_model_fact_review_repair") == 1
    assert result["status"] == "offered" and result["pkm_written"] is False
    expected = initial["payload"]["proposed_facts"][0]
    fact = result["report"]["sections"][0]["facts"][0]
    assert fact["statement"] == expected["statement"]
    assert fact["confidence"] == expected["confidence"]
    assert fact["sources"] == [{"title": "Public bio", "url": URL}]
    assert result["research"]["identity"] == initial["payload"]["identity"]
    assert "stage=fact_review attempt=initial" in caplog.text
    assert "untrusted-owner-text" not in caplog.text and IDENTITY["email"] not in caplog.text


@pytest.mark.asyncio
async def test_paused_fact_review_resumes_without_rebuying_report_and_rechecks_authority():
    charges, snapshots = [], []
    first = FakeGateway(charges=charges, snapshots=snapshots)
    structured = first.structured

    async def pause_review(**kwargs):
        if kwargs["purpose"] == "world_model_fact_review":
            first.calls.append(kwargs["purpose"])
            raise TimeoutError("Synthetic review interruption")
        return await structured(**kwargs)

    first.structured = pause_review

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    kwargs = dict(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
    )
    assert await run_world_model_azure(**kwargs, gateway=first) == {
        "status": "paused",
        "pkm_written": False,
        "restart_required": True,
    }
    work = copy.deepcopy(snapshots[-1])
    used = tuple(charges)
    assert work["pending_report"]["sections"]
    assert "fact_review" not in work
    charges.clear()
    resumed = FakeGateway(charges=charges, snapshots=snapshots, report_timeout=True)
    result = await run_world_model_azure(**kwargs, gateway=resumed, work=work, attempts_used=used)
    assert result["status"] == "offered"
    assert resumed.calls == ["world_model_fact_review"]
    assert len(charges) == 1 and charges[0] not in used
    completed = copy.deepcopy(snapshots[-1])
    cached = FakeGateway(charges=charges, snapshots=snapshots, report_timeout=True)
    exhausted = (1, *range(MODEL_FIRST, MODEL_FIRST + 16))
    before = list(charges)
    assert (
        await run_world_model_azure(
            **kwargs, gateway=cached, work=completed, attempts_used=exhausted
        )
    )["status"] == "offered"
    assert cached.calls == [] and charges == before
    for defect in ["report_digest", "invalid_selection", "missing_selection"]:
        corrupted = copy.deepcopy(completed)
        if defect == "report_digest":
            corrupted["fact_review"]["report_sha256"] = "wrong-report"
        elif defect == "missing_selection":
            corrupted["fact_review"].pop("selection")
        else:
            corrupted["fact_review"]["selection"]["kept_fact_ids"] = ["f99"]
        with pytest.raises(ValueError):
            await run_world_model_azure(
                **kwargs, gateway=cached, work=corrupted, attempts_used=exhausted
            )
        assert cached.calls == [] and charges == before
    revoked = {**kwargs, "require_access": AsyncMock(side_effect=PermissionError("revoked"))}
    with pytest.raises(PermissionError):
        await run_world_model_azure(
            **revoked, gateway=cached, work=completed, attempts_used=exhausted
        )
    assert cached.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["budget", "time", "authority"])
async def test_fact_review_repair_preserves_remaining_budget_time_and_access(boundary):
    from hushh_mcp.one_adk.world_model_azure import FACT_REVIEW_MAX_SECONDS, TASK_SECONDS

    charges, snapshots = [], []

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    kwargs = dict(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
    )
    await run_world_model_azure(
        **kwargs,
        require_access=AsyncMock(),
        gateway=FakeGateway(charges=charges, snapshots=snapshots),
    )
    work = copy.deepcopy(snapshots[-1])
    work.pop("fact_review")
    used = tuple(charges) if boundary != "budget" else (1, *range(MODEL_FIRST, MODEL_FIRST + 15))
    charges.clear()
    snapshots.clear()
    gateway = FakeGateway(charges=charges, snapshots=snapshots)
    now, invalid_returned = [0.0], [False]

    async def access():
        if boundary == "authority" and invalid_returned[0]:
            raise PermissionError("revoked")

    async def invalid_review(**request):
        gateway.calls.append(request["purpose"])
        assert request["purpose"] == "world_model_fact_review"
        invalid_returned[0] = True
        if boundary == "time":
            now[0] = TASK_SECONDS - FACT_REVIEW_MAX_SECONDS
        return {"kept_fact_ids": ["f1"], "summary": "x" * 501}

    gateway.structured = invalid_review

    async def run():
        return await run_world_model_azure(
            **kwargs,
            require_access=access,
            gateway=gateway,
            work=work,
            attempts_used=used,
            monotonic_clock=lambda: now[0],
        )

    if boundary == "time":
        assert (await run())["status"] == "paused"
    else:
        with pytest.raises(PermissionError if boundary == "authority" else ValueError):
            await run()
    assert gateway.calls == ["world_model_fact_review"]
    assert len(charges) == 1
    assert all("fact_review" not in checkpoint for checkpoint in snapshots)


@pytest.mark.asyncio
async def test_owner_public_profiles_are_charged_retrieval_leads_not_identity_receipts():
    charges, snapshots = [], []

    class PublicProfileGateway(FakeGateway):
        async def search(self, request):
            assert request["owner_selected_public_profiles"] == [URL]
            assert "owner_decisions" not in request
            return await super().search(request)

        async def structured(self, **kwargs):
            if kwargs["purpose"] == "identity_assessment":
                assert kwargs["payload"]["owner_selected_public_profiles"] == [URL]
                assert self.calls.count("search") == 1
            return await super().structured(**kwargs)

    async def charge(values):
        charges.extend(values)

    async def checkpoint(value):
        snapshots.append(copy.deepcopy(value))

    result = await run_world_model_azure(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=checkpoint,
        owner_decisions={"confirmed": [], "rejected": ["An unrelated claim"]},
        owner_public_profiles={"urls": [URL], "permitted_public_sources": True},
        gateway=PublicProfileGateway(charges=charges, snapshots=snapshots),
    )
    assert result["status"] == "offered"
    assert result["research"]["identity"]["state"] == "candidate_for_review"
    assert result["pkm_written"] is False
