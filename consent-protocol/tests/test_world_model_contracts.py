"""The final PWM report may restate its reasoning; it may not move the identity decision."""

import copy

import pytest

from hushh_mcp.one_adk.world_model_contracts import TOPICS, IdentityAssessment, WorldModelReport

PLAN = {
    "purpose": "identity",
    "seed_fields": ["full_name", "email"],
    "anchor_ids": [],
    "candidate_id": "c1",
    "topics": ["career"],
    "question": "Who is Alex Example?",
}


def assessment():
    return {
        "candidates": [
            {
                "id": "c1",
                "label": "Alex Example",
                "anchor_ids": ["a1", "a2"],
                "blocking_conflicts": [],
            }
        ],
        "anchors": [
            {
                "id": "a1",
                "candidate_id": "c1",
                "kind": "verified_contact",
                "seed_field": "email",
                "assertion": "Publishes the supplied contact.",
                "source_refs": ["s1"],
                "temporal_context": "Current public bio",
            },
            {
                "id": "a2",
                "candidate_id": "c1",
                "kind": "public_profile",
                "seed_field": None,
                "assertion": "Profile links back to the bio.",
                "source_refs": ["s1"],
                "temporal_context": "Current",
            },
        ],
        "identity": {
            "state": "owner_linked",
            "reason": "Exact public contact matches",
            "probability": None,
            "selected_candidate_id": "c1",
            "supporting_anchor_ids": ["a1", "a2"],
            "next_step": "search",
        },
    }


def report(identity):
    return {
        "identity": identity,
        "match_status": "matched",
        "name": "Alex Example",
        "summary": "Public work",
        "sections": [
            {
                "kind": "career",
                "facts": [
                    {
                        "statement": "Builds software.",
                        "confidence": "supported",
                        "sources": [{"title": "Bio", "ref": "s1"}],
                    }
                ],
            }
        ],
        "coverage": [
            {
                "topic": topic,
                "status": "findings" if topic == "career" else "not_attempted",
                "attempt_ids": [1] if topic == "career" else [],
                "explanation": "Public bio" if topic == "career" else "No attempt in this fixture",
            }
            for topic in TOPICS
        ],
        "gaps": ["Other topics have not been researched."],
    }


def validate(identity):
    attempts = {"1": {"plan": copy.deepcopy(PLAN), "observed": True, "source_refs": ["s1"]}}
    return (
        WorldModelReport.model_validate(report(identity))
        .validate_receipts(IdentityAssessment.model_validate(assessment()), attempts, {"s1"})
        .model_dump()
    )


@pytest.mark.parametrize("restated", ["reason", "next_step", "anchor_order"])
def test_final_report_may_restate_the_assessed_identity(restated):
    # UAT 2026-10-15: every run failed because the final report re-worded the
    # identity reason, so no draft was ever offered.
    identity = copy.deepcopy(assessment()["identity"])
    if restated == "reason":
        identity["reason"] = "The published contact is the supplied one."
    if restated == "next_step":
        identity["next_step"] = "finish"
    if restated == "anchor_order":
        identity["supporting_anchor_ids"] = ["a2", "a1"]
    result = validate(identity)
    assert result["identity"]["reason"] == identity["reason"]
    assert result["match_status"] == "matched"


@pytest.mark.parametrize("moved", ["state", "candidate", "anchors"])
def test_final_report_cannot_move_the_identity_decision(moved):
    identity = copy.deepcopy(assessment()["identity"])
    if moved == "state":
        identity["state"] = "candidate_for_review"
    if moved == "candidate":
        identity["selected_candidate_id"] = "c2"
    if moved == "anchors":
        identity["supporting_anchor_ids"] = ["a1"]
    with pytest.raises(ValueError):
        if moved == "state":
            value = report(identity)
            value["match_status"] = "uncertain"
            attempts = {"1": {"plan": copy.deepcopy(PLAN), "observed": True, "source_refs": ["s1"]}}
            WorldModelReport.model_validate(value).validate_receipts(
                IdentityAssessment.model_validate(assessment()), attempts, {"s1"}
            )
        else:
            validate(identity)
