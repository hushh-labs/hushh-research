"""The final PWM report may restate its reasoning; it may not move the identity decision."""

import copy

import pytest

from hushh_mcp.one_adk.profile_research import ProfileFact, ProfileSourceRef
from hushh_mcp.one_adk.world_model import OwnerDecisions
from hushh_mcp.one_adk.world_model_confidence import evidence_rating
from hushh_mcp.one_adk.world_model_contracts import (
    TOPICS,
    FindingBatch,
    IdentityAssessment,
    WorldModelReport,
    eligible_report_sources,
    validated_facts_from_work,
)

PLAN = {
    "purpose": "identity",
    "seed_fields": ["full_name", "email"],
    "anchor_ids": [],
    "candidate_id": "c1",
    "topics": ["career"],
    "question": "Who is Alex Example?",
}


def test_owner_decisions_accept_full_draft_but_bound_the_request():
    rows = [f"Rejected statement {index}" for index in range(269)]
    assert len(OwnerDecisions.model_validate({"rejected": rows}).rejected) == 269
    with pytest.raises(ValueError):
        OwnerDecisions.model_validate({"rejected": [*rows, "extra"]})


@pytest.mark.parametrize("state", ["owner_linked", "candidate_for_review", "ambiguous"])
def test_reviewed_empty_report_preserves_identity_instead_of_manufacturing_a_fact(state):
    identity = {**assessment()["identity"], "state": state}
    value = report(identity)
    value["match_status"] = "matched" if state == "owner_linked" else "uncertain"
    value["sections"] = []
    accepted = WorldModelReport.model_validate(value)
    assert accepted.identity.state == state
    assert accepted.sections == []
    # No-match still cannot carry a personal finding.
    invalid = report({**identity, "state": "no_match"})
    invalid["match_status"] = "no_match"
    with pytest.raises(ValueError, match="no-match report"):
        WorldModelReport.model_validate(invalid)


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


def test_coverage_receipts_reconcile_from_recorded_plans_without_changing_findings():
    value = report(assessment()["identity"])
    value["coverage"][TOPICS.index("career")]["attempt_ids"] = [2]
    attempts = {
        "1": {"plan": copy.deepcopy(PLAN), "observed": True, "source_refs": ["s1"]},
        "2": {
            "plan": {**copy.deepcopy(PLAN), "topics": ["education"]},
            "observed": True,
            "source_refs": [],
        },
    }
    # The second search was for education; its existence is reflected even
    # though the model forgot that attempt in its education coverage row.
    value["coverage"][TOPICS.index("education")]["status"] = "checked_no_findings"
    normalized = WorldModelReport.model_validate(value).validate_receipts(
        IdentityAssessment.model_validate(assessment()), attempts, {"s1"}
    )
    assert normalized.coverage[TOPICS.index("career")].attempt_ids == [1]
    assert normalized.coverage[TOPICS.index("education")].attempt_ids == [2]
    assert normalized.sections[0].facts[0].statement == "Builds software."


def test_coverage_repair_keeps_candidate_and_observation_gates():
    value = report(assessment()["identity"])
    value["coverage"][TOPICS.index("career")]["attempt_ids"] = [2]
    attempts = {
        "1": {"plan": copy.deepcopy(PLAN), "observed": True, "source_refs": ["s1"]},
        "2": {
            "plan": {**copy.deepcopy(PLAN), "candidate_id": "c2"},
            "observed": True,
            "source_refs": ["s2"],
        },
    }
    with pytest.raises(ValueError, match="another candidate"):
        WorldModelReport.model_validate(value).validate_receipts(
            IdentityAssessment.model_validate(assessment()), attempts, {"s1", "s2"}
        )
    value["coverage"][TOPICS.index("career")]["attempt_ids"] = []
    attempts["1"]["observed"] = False
    with pytest.raises(ValueError, match="failed search"):
        WorldModelReport.model_validate(value).validate_receipts(
            IdentityAssessment.model_validate(assessment()), attempts, {"s1", "s2"}
        )


def test_identity_search_cannot_cite_an_unanchored_namesake_source():
    attempts = {
        "1": {
            "plan": copy.deepcopy(PLAN),
            "observed": True,
            "source_refs": ["s1", "s2"],
        }
    }
    value = report(assessment()["identity"])
    value["sections"][0]["facts"][0]["sources"] = [{"title": "Namesake", "ref": "s2"}]
    with pytest.raises(ValueError, match="unreceived source"):
        WorldModelReport.model_validate(value).validate_receipts(
            IdentityAssessment.model_validate(assessment()), attempts, {"s1", "s2"}
        )


@pytest.mark.parametrize(
    "defect", [None, "unobserved", "other_candidate", "other_topic", "unreceived"]
)
def test_report_cannot_borrow_citation_from_ineligible_coverage(defect):
    from jsonschema import ValidationError, validate

    from hushh_mcp.one_adk.world_model_azure import _report_schema, _topic_attempts

    value = report(assessment()["identity"])
    value["sections"][0]["facts"][0]["sources"] = [{"title": "Other result", "ref": "s2"}]
    attempts = {
        "1": {"plan": copy.deepcopy(PLAN), "observed": True, "source_refs": ["s1"]},
        "2": {
            "plan": {**copy.deepcopy(PLAN), "purpose": "coverage", "candidate_id": "c1"},
            "observed": defect != "unobserved",
            "source_refs": ["s2"],
        },
    }
    if defect == "other_candidate":
        attempts["2"]["plan"]["candidate_id"] = "c2"
    if defect == "other_topic":
        attempts["2"]["plan"]["topics"] = ["education"]
        value["coverage"][TOPICS.index("education")]["status"] = "checked_no_findings"
    accepted = IdentityAssessment.model_validate(assessment())
    refs = {"s1"} if defect == "unreceived" else {"s1", "s2"}
    topics = {
        topic: [index for index in indices if attempts[str(index)]["observed"]]
        for topic, indices in _topic_attempts(accepted, attempts).items()
    }
    schema = _report_schema(
        topics,
        {
            topic: sorted(eligible & refs)
            for topic, eligible in eligible_report_sources(accepted, attempts).items()
        },
    )
    model = WorldModelReport.model_validate(value)
    provider_value = copy.deepcopy(value)
    provider_value.pop("coverage")  # The existing host ledger authors public coverage.
    args = (accepted, attempts, refs)
    if defect is None:
        validate(provider_value, schema)
        assert model.validate_receipts(*args).sections[0].facts[0].sources[0].ref == "s2"
    else:
        with pytest.raises(ValidationError):
            validate(provider_value, schema)
        with pytest.raises(ValueError, match="unreceived source"):
            model.validate_receipts(*args)


@pytest.mark.parametrize("field", ["candidate", "anchor", "source"])
def test_identity_identifiers_cannot_change_namespaces(field):
    value = assessment()
    if field == "candidate":
        value["candidates"][0]["id"] = "s1"
    elif field == "anchor":
        value["anchors"][0]["id"] = "c1"
    else:
        value["anchors"][0]["source_refs"] = ["a1"]
    with pytest.raises(ValueError):
        IdentityAssessment.model_validate(value)


def test_provisional_facts_need_selected_candidate_observed_plan_and_received_citation():
    work = {
        "assessment": assessment(),
        "attempts": {
            "1": {"plan": copy.deepcopy(PLAN), "observed": True, "source_refs": ["s1", "s2"]}
        },
        "sources": {
            "s1": {"title": "Bio", "url": "https://example.test/alex"},
            "s2": {"title": "Namesake", "url": "https://example.test/namesake"},
        },
        "finding_batches": [
            {
                "candidate_id": "c1",
                "attempt_id": 1,
                "topic": "career",
                "facts": [
                    {
                        "statement": "Builds software.",
                        "confidence": "supported",
                        "sources": [{"title": "Untrusted model title", "ref": "s1"}],
                    }
                ],
            }
        ],
    }
    facts = validated_facts_from_work(work)
    assert len(facts) == 1 and facts[0]["sources"] == [work["sources"]["s1"]]
    assert facts[0]["id"].startswith("p")
    coverage = copy.deepcopy(work)
    coverage["attempts"]["1"]["plan"].update(purpose="coverage", candidate_id="c1")
    for anchor in coverage["assessment"]["anchors"]:
        anchor["source_refs"] = ["s2"]
    # Vertex's original observed-coverage contract remains unchanged.
    assert len(validated_facts_from_work(coverage)) == 1
    # Azure cannot keep old provisional claims after c1 moves to a different page.
    coverage["azure_work_version"] = 1
    assert validated_facts_from_work(coverage) == []
    for anchor in coverage["assessment"]["anchors"]:
        anchor["source_refs"] = ["s1"]
    assert len(validated_facts_from_work(coverage)) == 1
    for defect in ("candidate", "unobserved", "topic", "source", "unanchored_identity"):
        invalid = copy.deepcopy(work)
        batch = invalid["finding_batches"][0]
        if defect == "candidate":
            batch["candidate_id"] = "c2"
        elif defect == "unobserved":
            invalid["attempts"]["1"]["observed"] = False
        elif defect == "topic":
            batch["topic"] = "education"
        elif defect == "source":
            batch["facts"][0]["sources"][0]["ref"] = "s3"
        else:
            batch["facts"][0]["sources"][0]["ref"] = "s2"
        assert validated_facts_from_work(invalid) == [], defect
    with pytest.raises(ValueError):
        FindingBatch.model_validate(work["finding_batches"][0]).validate_receipts(
            IdentityAssessment.model_validate(work["assessment"]),
            {"1": {**work["attempts"]["1"], "observed": False}},
            {"s1"},
        )


def test_deep_draft_keeps_distinct_facts_without_forcing_269():
    value = report(assessment()["identity"])
    value["sections"][0]["facts"] = [
        {
            "statement": f"Published distinct project detail {index}.",
            "confidence": "supported",
            "sources": [{"title": "Bio", "ref": "s1"}],
        }
        for index in range(40)
    ]
    assert len(WorldModelReport.model_validate(value).sections[0].facts) == 40
    repeated = copy.deepcopy(value)
    repeated["sections"][0]["facts"][1]["statement"] = "  published DISTINCT project detail 0. "
    with pytest.raises(ValueError, match="repeats"):
        WorldModelReport.model_validate(repeated)
    value["sections"][0]["facts"].append(value["sections"][0]["facts"][0])
    with pytest.raises(ValueError):
        WorldModelReport.model_validate(value)

    deep = report(assessment()["identity"])
    deep["sections"] = [
        {
            "kind": kind,
            "facts": [
                {
                    "statement": f"Distinct sourced detail {group}-{index}.",
                    "confidence": "supported",
                    "sources": [{"title": "Bio", "ref": "s1"}],
                }
                for index in range(29 if group == 6 else 40)
            ],
        }
        for group, kind in enumerate(TOPICS[:7])
    ]
    assert (
        sum(len(section.facts) for section in WorldModelReport.model_validate(deep).sections) == 269
    )
    deep["sections"][-1]["facts"].append(
        {
            "statement": "One too many.",
            "confidence": "supported",
            "sources": [{"title": "Bio", "ref": "s1"}],
        }
    )
    with pytest.raises(ValueError, match="limit"):
        WorldModelReport.model_validate(deep)


def test_evidence_score_is_host_computed_and_caps_preferences_and_namesakes():
    fact = ProfileFact[ProfileSourceRef].model_validate(
        {
            "statement": "Publishes a technical paper.",
            "confidence": "supported",
            "sources": [{"title": "First", "ref": "s1"}, {"title": "Second", "ref": "s2"}],
        }
    )
    receipts = {
        "s1": {"url": "https://publisher.example/paper"},
        "s2": {"url": "https://university.example/author"},
    }
    linked = evidence_rating(
        fact=fact, topic="publications", identity_state="owner_linked", receipts=receipts
    )
    namesake = evidence_rating(
        fact=fact, topic="publications", identity_state="candidate_for_review", receipts=receipts
    )
    preference = evidence_rating(
        fact=fact, topic="preferences", identity_state="owner_linked", receipts=receipts
    )
    assert linked["evidence_score"] > namesake["evidence_score"]
    assert namesake["evidence_score"] <= 4
    assert preference["evidence_score"] <= 5
    assert linked["evidence_score"] <= 4
    assert "unverified" in linked["evidence_reason"]


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
