"""PWM evidence contracts. Gemini judges meaning; this module validates receipts."""

from __future__ import annotations

import json
from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.one_adk.profile_research import ProfileReport, ProfileSourceRef

Topic = Literal[
    "business",
    "career",
    "education",
    "personal",
    "projects",
    "publications",
    "achievements",
    "community",
    "interests",
    "preferences",
    "dislikes",
    "style",
    "food",
    "travel",
    "entertainment",
    "shopping",
    "communication",
    "digital_presence",
    "public_records",
    "security",
]
TOPICS = list(get_args(Topic))
ShortText = Annotated[str, Field(min_length=1, max_length=600)]
Reference = Annotated[str, Field(pattern=r"^[acs][1-9][0-9]{0,3}$")]
Seed = Literal["full_name", "email", "phone_number"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class QueryPlan(Contract):
    purpose: Literal["identity", "coverage"]
    seed_fields: list[Seed] = Field(max_length=3)
    anchor_ids: list[Reference] = Field(max_length=4)
    candidate_id: Reference | None
    topics: list[Topic] = Field(max_length=20)
    question: str = Field(max_length=600)

    @model_validator(mode="after")
    def distinct(self):
        for values in (self.seed_fields, self.anchor_ids, self.topics):
            if len(values) != len(set(values)):
                raise ValueError("Repeated query input")
        if not self.seed_fields and not self.anchor_ids:
            raise ValueError("A query needs admitted input or received evidence")
        if self.purpose == "coverage" and (not self.candidate_id or not self.topics):
            raise ValueError("Coverage must name a candidate and topics")
        return self

    def key(self):
        return json.dumps(self.model_dump(), sort_keys=True)


class IdentityAnchor(Contract):
    id: Reference
    candidate_id: Reference
    kind: Literal["verified_contact", "public_profile", "reciprocal_link"]
    seed_field: Seed | None
    assertion: ShortText
    source_refs: list[Reference] = Field(min_length=1, max_length=3)
    temporal_context: ShortText


class CandidateCluster(Contract):
    id: Reference
    label: ShortText
    anchor_ids: list[Reference] = Field(max_length=12)
    blocking_conflicts: list[ShortText] = Field(max_length=8)


class IdentityPivot(Contract):
    state: Literal["owner_linked", "candidate_for_review", "ambiguous", "no_match"]
    reason: ShortText
    probability: None = None
    selected_candidate_id: Reference | None
    supporting_anchor_ids: list[Reference] = Field(max_length=12)
    next_step: Literal["search", "review", "request_owner_anchor", "finish"]


class IdentityAssessment(Contract):
    candidates: list[CandidateCluster] = Field(max_length=6)
    anchors: list[IdentityAnchor] = Field(max_length=24)
    identity: IdentityPivot

    def validate_evidence(self, *, identity: dict, source_refs: set[str]):
        candidates = {candidate.id: candidate for candidate in self.candidates}
        anchors = {anchor.id: anchor for anchor in self.anchors}
        if len(candidates) != len(self.candidates) or len(anchors) != len(self.anchors):
            raise ValueError("Repeated evidence identifier")
        for anchor in self.anchors:
            if anchor.candidate_id not in candidates or not set(anchor.source_refs) <= source_refs:
                raise ValueError("Unknown candidate or provider receipt")
            if anchor.kind == "verified_contact" and (
                anchor.seed_field not in {"email", "phone_number"}
                or not identity.get(anchor.seed_field)
            ):
                raise ValueError("Missing verified owner anchor")
        for candidate in self.candidates:
            if any(
                ref not in anchors or anchors[ref].candidate_id != candidate.id
                for ref in candidate.anchor_ids
            ):
                raise ValueError("Cross-candidate evidence")
        pivot = self.identity
        selected = (
            candidates.get(pivot.selected_candidate_id) if pivot.selected_candidate_id else None
        )
        if pivot.state == "no_match":
            if selected or pivot.supporting_anchor_ids:
                raise ValueError("No match cannot select a candidate")
        elif selected is None:
            raise ValueError("Assessment must select the candidate shown for review")
        elif not selected.anchor_ids or not pivot.supporting_anchor_ids:
            raise ValueError("A candidate needs received supporting evidence")
        if any(
            ref not in anchors or anchors[ref].candidate_id != pivot.selected_candidate_id
            for ref in pivot.supporting_anchor_ids
        ):
            raise ValueError("Identity evidence belongs to another candidate")
        if pivot.state == "owner_linked" and (
            selected is None
            or selected.blocking_conflicts
            or not any(
                anchors[ref].kind == "verified_contact" for ref in pivot.supporting_anchor_ids
            )
        ):
            raise ValueError("Owner linkage requires an unconflicted verified-contact chain")
        return self


class TopicCoverage(Contract):
    topic: Topic
    status: Literal["findings", "checked_no_findings", "unavailable", "not_attempted"]
    attempt_ids: list[Annotated[int, Field(ge=1, le=32)]] = Field(max_length=32)
    explanation: ShortText


class WorldModelReport(ProfileReport[ProfileSourceRef]):
    identity: IdentityPivot
    coverage: list[TopicCoverage] = Field(min_length=20, max_length=20)
    gaps: list[ShortText] = Field(max_length=20)

    @model_validator(mode="after")
    def identity_contract(self):
        expected = {
            "owner_linked": "matched",
            "candidate_for_review": "uncertain",
            "ambiguous": "uncertain",
            "no_match": "no_match",
        }[self.identity.state]
        if self.match_status != expected:
            raise ValueError("Identity and report decisions disagree")
        if {row.topic for row in self.coverage} != set(TOPICS):
            raise ValueError("Report every topic, including unavailable and unattempted topics")
        return self

    def validate_receipts(self, assessment: IdentityAssessment, attempts: dict, refs: set[str]):
        # The final report may restate the reason and name the next step; the
        # decision itself (state, candidate, supporting evidence) must not move.
        final, assessed = self.identity, assessment.identity
        if (
            final.state != assessed.state
            or final.selected_candidate_id != assessed.selected_candidate_id
            or set(final.supporting_anchor_ids) != set(assessed.supporting_anchor_ids)
        ):
            raise ValueError("Final report changed the assessed identity")
        findings = {section.kind for section in self.sections}
        candidate_id = assessment.identity.selected_candidate_id
        selected_sources = {
            ref
            for anchor in assessment.anchors
            if anchor.candidate_id == candidate_id
            for ref in anchor.source_refs
        }
        topic_sources = {}
        for topic in self.coverage:
            if len(topic.attempt_ids) != len(set(topic.attempt_ids)):
                raise ValueError("Repeated attempt receipt")
            rows: list[dict] = []
            for index in topic.attempt_ids:
                row = attempts.get(str(index))
                if not isinstance(row, dict) or topic.topic not in row["plan"]["topics"]:
                    raise ValueError("Coverage has no matching search receipt")
                rows.append(row)
            if any(row["plan"]["candidate_id"] not in {None, candidate_id} for row in rows):
                raise ValueError("Coverage belongs to another candidate")
            topic_sources[topic.topic] = selected_sources | {
                ref
                for row in rows
                if row["plan"]["candidate_id"] == candidate_id and candidate_id is not None
                for ref in row["source_refs"]
            }
            if topic.status in {"findings", "checked_no_findings"} and (
                not rows or not any(row["observed"] for row in rows)
            ):
                raise ValueError("A failed search cannot establish absence")
            if topic.status == "not_attempted" and rows:
                raise ValueError("Unattempted topic has attempts")
            if (topic.status == "findings") != (topic.topic in findings):
                raise ValueError("Coverage and findings disagree")
        for section in self.sections:
            for fact in section.facts:
                if not {source.ref for source in fact.sources} <= (
                    refs & topic_sources[section.kind]
                ):
                    raise ValueError("Finding cites an unreceived source")
        return self
