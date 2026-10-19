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
            assert self.charges == [
                1,
                MODEL_FIRST,
                MODEL_FIRST + 1,
                MODEL_FIRST + 2,
                MODEL_FIRST + 3,
                2,
                MODEL_FIRST + 4,
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
        if purpose == "identity_assessment":
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
        assert purpose == "world_model_report"
        if self.report_timeout:
            raise TimeoutError("Synthetic report interruption")
        assert payload["owner_decisions"]["rejected"] == ["An unrelated claim"]
        assert payload["topic_attempt_ids"]["career"]
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
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 5)]
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        "world_model_report",
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
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 5)]


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
async def test_azure_runner_offers_existing_receipts_when_phi_returns_prose():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, phi_non_json=True)

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
    ]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 5)]


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
    ]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 5)]


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
    assert gateway.calls == ["search", "identity_assessment", "world_model_report"]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 3)]
    assert clock[0] == 170


@pytest.mark.asyncio
async def test_azure_runner_phi_timeout_keeps_report_reserve():
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
    assert gateway.calls == ["search", "identity_assessment", "plan", "world_model_report"]
    assert charges == [1, *range(MODEL_FIRST, MODEL_FIRST + 4)]
    assert clock[0] == 140


@pytest.mark.asyncio
async def test_azure_runner_allows_coverage_for_review_candidate_without_linking_owner():
    charges, snapshots = [], []
    gateway = FakeGateway(charges=charges, snapshots=snapshots, coverage_plan=True)

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
    assert result["research"]["searches_used"] == 2
    assert gateway.calls == [
        "search",
        "identity_assessment",
        "provisional_findings",
        "plan",
        "search",
        "identity_assessment",
        "provisional_findings",
        "world_model_report",
    ]


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
        "world_model_report",
    ]


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
    assert charges == [1, MODEL_FIRST, MODEL_FIRST + 1]
    assert gateway.calls == ["search", "identity_assessment"]


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
    assert gateway.calls == ["provisional_findings", "world_model_report"]
    assert charges == [MODEL_FIRST + 1, MODEL_FIRST + 2]


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
    assert gateway.calls == ["world_model_report"]
    assert charges == [MODEL_FIRST + 3]
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
    gateway = AzurePwmGateway(
        primary_endpoint="https://synthetic.openai.azure.com/openai/v1/",
        primary_deployment="primary",
        primary_token_supplier=lambda: "synthetic",
        phi_endpoint="https://synthetic.services.ai.azure.com/openai/v1/",
        phi_deployment="phi",
        phi_token_supplier=lambda: "synthetic",
    )
    response = SimpleNamespace(status="incomplete", incomplete_details=None, output_text="{}")

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
    # A malformed envelope is a provider failure, never a replacement decision.
    response.output_text = '{"action":"finish","plan":null}'
    with pytest.raises(ValueError, match="result envelope"):
        await gateway.plan({})


@pytest.mark.asyncio
@pytest.mark.parametrize("contract", ["assessment", "findings", "report"])
async def test_native_schema_preserves_resolvable_refs_and_host_bounds(contract):
    from jsonschema import Draft202012Validator

    from hushh_mcp.one_adk.world_model_azure import _FINDING_SCHEMA
    from hushh_mcp.one_adk.world_model_contracts import IdentityAssessment, WorldModelReport

    schema = {
        "assessment": IdentityAssessment.model_json_schema(),
        "findings": _FINDING_SCHEMA,
        "report": WorldModelReport.model_json_schema(),
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
            purpose=contract,
            instruction="Synthetic evaluation",
            payload={},
            schema=schema,
            max_output_tokens=2048,
        )
        == value
    )
    native = create.call_args.kwargs["text"]["format"]["schema"]
    Draft202012Validator(native).validate({"result": value})
    assert "$defs" not in native["properties"]["result"]
    assert (
        schema
        == {
            "assessment": IdentityAssessment.model_json_schema(),
            "findings": _FINDING_SCHEMA,
            "report": WorldModelReport.model_json_schema(),
        }[contract]
    )
