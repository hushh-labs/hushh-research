import copy
import json

import httpx
from openai import APIError

from hushh_mcp.one_adk.world_model import MAX_SEARCHES
from hushh_mcp.one_adk.world_model_contracts import TOPICS

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
