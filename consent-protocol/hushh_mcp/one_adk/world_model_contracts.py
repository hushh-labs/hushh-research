"""PWM evidence contracts. Gemini judges meaning; this module validates receipts."""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.one_adk.profile_research import (
    ProfileFact,
    ProfileSection,
    ProfileSource,
    ProfileSourceRef,
)

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
MAX_WORLD_MODEL_FACTS = 269
MAX_WORLD_MODEL_FACTS_PER_TOPIC = 40
ShortText = Annotated[str, Field(min_length=1, max_length=600)]
Reference = Annotated[str, Field(pattern=r"^[acs][1-9][0-9]{0,3}$")]
CandidateReference = Annotated[str, Field(pattern=r"^c[1-9][0-9]{0,3}$")]
AnchorReference = Annotated[str, Field(pattern=r"^a[1-9][0-9]{0,3}$")]
SourceReference = Annotated[str, Field(pattern=r"^s[1-9][0-9]{0,3}$")]
Seed = Literal["full_name", "email", "phone_number"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class QueryPlan(Contract):
    purpose: Literal["identity", "coverage"]
    seed_fields: list[Seed] = Field(max_length=3)
    anchor_ids: list[AnchorReference] = Field(max_length=4)
    candidate_id: CandidateReference | None
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
    id: AnchorReference
    candidate_id: CandidateReference
    kind: Literal["verified_contact", "public_profile", "reciprocal_link"]
    seed_field: Seed | None
    assertion: ShortText
    source_refs: list[SourceReference] = Field(min_length=1, max_length=3)
    temporal_context: ShortText


class CandidateCluster(Contract):
    id: CandidateReference
    label: ShortText
    anchor_ids: list[AnchorReference] = Field(max_length=12)
    blocking_conflicts: list[ShortText] = Field(max_length=8)


class IdentityPivot(Contract):
    state: Literal["owner_linked", "candidate_for_review", "ambiguous", "no_match"]
    reason: ShortText
    probability: None = None
    selected_candidate_id: CandidateReference | None
    supporting_anchor_ids: list[AnchorReference] = Field(max_length=12)
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


class CoverageCoherenceError(ValueError):
    """A model's topic judgment conflicts with recorded execution or findings."""


class CoverageRepair(Contract):
    """One bounded model retry for semantic coverage rows, never new findings."""

    coverage: list[TopicCoverage] = Field(min_length=20, max_length=20)
    gaps: list[ShortText] = Field(max_length=20)

    @model_validator(mode="after")
    def complete_topics(self):
        if {row.topic for row in self.coverage} != set(TOPICS):
            raise ValueError("Repair must report every topic")
        return self


class FindingBatch(Contract):
    """A provisional model-authored batch tied to one observed search."""

    candidate_id: CandidateReference
    attempt_id: Annotated[int, Field(ge=1, le=32)]
    topic: Topic
    facts: list[ProfileFact[ProfileSourceRef]] = Field(min_length=1, max_length=8)

    def validate_receipts(
        self, assessment: IdentityAssessment, attempts: dict, refs: set[str]
    ) -> FindingBatch:
        pivot = assessment.identity
        if pivot.state not in {"owner_linked", "candidate_for_review"}:
            raise ValueError("A provisional finding needs an assessed candidate")
        if self.candidate_id != pivot.selected_candidate_id:
            raise ValueError("Provisional finding belongs to another candidate")
        row = attempts.get(str(self.attempt_id))
        if not isinstance(row, dict) or row.get("observed") is not True:
            raise ValueError("Provisional finding needs an observed search")
        try:
            plan = QueryPlan.model_validate(row.get("plan"))
        except (TypeError, ValueError) as error:
            raise ValueError("Invalid recorded search receipt") from error
        if self.topic not in plan.topics or plan.candidate_id not in {None, self.candidate_id}:
            raise ValueError("Provisional finding has no matching search receipt")
        received = row.get("source_refs")
        if not isinstance(received, list) or not set(received) <= refs:
            raise ValueError("Provisional finding has an unreceived source")
        if plan.purpose == "identity":
            linked = {
                ref
                for anchor in assessment.anchors
                if anchor.candidate_id == self.candidate_id
                for ref in anchor.source_refs
            }
            received = [ref for ref in received if ref in linked]
        if any(not {source.ref for source in fact.sources} <= set(received) for fact in self.facts):
            raise ValueError("Provisional finding cites an unreceived candidate source")
        return self


def finding_id(candidate_id: str, topic: str, statement: str) -> str:
    """Stable within a research generation, without putting owner text in the id."""
    normalized = " ".join(statement.casefold().split())
    return (
        "p"
        + hashlib.sha256(
            json.dumps([candidate_id, topic, normalized], ensure_ascii=False).encode()
        ).hexdigest()[:24]
    )


def validated_facts_from_work(work: dict) -> list[dict]:
    """Project only candidate-bound, cited batches from a sealed checkpoint."""
    if not isinstance(work, dict):
        return []
    try:
        assessment = IdentityAssessment.model_validate(work.get("assessment"))
        attempts = work.get("attempts")
        sources = work.get("sources")
        batches = work.get("finding_batches")
        if (
            not isinstance(attempts, dict)
            or not isinstance(sources, dict)
            or not isinstance(batches, list)
        ):
            return []
        receipts = {
            ref: ProfileSource.model_validate(value)
            for ref, value in sources.items()
            if isinstance(ref, str)
        }
        if len(receipts) != len(sources):
            return []
    except (TypeError, ValueError):
        return []
    result: list[dict] = []
    seen: set[str] = set()
    azure_owned_refs = (
        {
            ref
            for anchor in assessment.anchors
            if anchor.candidate_id == assessment.identity.selected_candidate_id
            for ref in anchor.source_refs
        }
        if "azure_work_version" in work
        else None
    )
    for raw in batches[:MAX_WORLD_MODEL_FACTS]:
        try:
            batch = FindingBatch.model_validate(raw).validate_receipts(
                assessment, attempts, set(receipts)
            )
        except (TypeError, ValueError):
            continue
        if azure_owned_refs is not None and any(
            source.ref not in azure_owned_refs for fact in batch.facts for source in fact.sources
        ):
            continue
        for fact in batch.facts:
            identifier = finding_id(batch.candidate_id, batch.topic, fact.statement)
            if identifier in seen:
                continue
            seen.add(identifier)
            result.append(
                {
                    "id": identifier,
                    "topic": batch.topic,
                    "statement": fact.statement,
                    "confidence": fact.confidence,
                    "sources": [receipts[source.ref].model_dump() for source in fact.sources],
                    "identity_state": assessment.identity.state,
                }
            )
            if len(result) >= MAX_WORLD_MODEL_FACTS:
                return result
    return result


class WorldModelSection(ProfileSection[ProfileSourceRef]):
    """PWM can show a deep cited draft without widening other profile contracts."""

    facts: list[ProfileFact[ProfileSourceRef]] = Field(
        min_length=1, max_length=MAX_WORLD_MODEL_FACTS_PER_TOPIC
    )


def eligible_report_sources(assessment: IdentityAssessment, attempts: dict) -> dict[str, set[str]]:
    """Project assessed anchors and observed candidate coverage into citation receipts."""
    candidate_id = assessment.identity.selected_candidate_id
    selected_sources = {
        ref
        for anchor in assessment.anchors
        if anchor.candidate_id == candidate_id
        for ref in anchor.source_refs
    }
    eligible = {topic: set(selected_sources) for topic in TOPICS}
    for row in attempts.values():
        plan = QueryPlan.model_validate(row.get("plan"))
        if (
            plan.purpose == "coverage"
            and row.get("observed") is True
            and plan.candidate_id == candidate_id
            and candidate_id is not None
        ):
            for topic in plan.topics:
                eligible[topic].update(row["source_refs"])
    return eligible


class WorldModelReport(Contract):
    """A PWM-specific deep report without changing other profile report bounds."""

    match_status: Literal["matched", "uncertain", "no_match"]
    name: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=500)
    sections: list[WorldModelSection] = Field(max_length=20)
    identity: IdentityPivot
    coverage: list[TopicCoverage] = Field(min_length=20, max_length=20)
    gaps: list[ShortText] = Field(max_length=20)

    @model_validator(mode="after")
    def identity_contract(self):
        if len({section.kind for section in self.sections}) != len(self.sections):
            raise ValueError("Duplicate sections")
        if self.match_status == "no_match" and self.sections:
            raise ValueError("A no-match report cannot contain findings")
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
        statements = [
            " ".join(fact.statement.casefold().split())
            for section in self.sections
            for fact in section.facts
        ]
        if len(statements) > MAX_WORLD_MODEL_FACTS:
            raise ValueError("PWM draft exceeds the reviewed fact limit")
        if len(statements) != len(set(statements)):
            raise ValueError("PWM draft repeats a finding")
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
        # Attempt numbers are execution receipts, not model judgements. Rebuild
        # their topic mapping from the sealed search plans so a report with a
        # mistaken number can still be offered without inventing evidence.
        recorded: dict[int, dict] = {}
        for key, row in attempts.items():
            try:
                index = int(key)
                if str(index) != key or not 1 <= index <= 32 or not isinstance(row, dict):
                    raise ValueError
                plan = QueryPlan.model_validate(row.get("plan"))
            except (TypeError, ValueError) as error:
                raise ValueError("Invalid recorded search receipt") from error
            recorded[index] = {**row, "plan": plan}
        topic_sources = eligible_report_sources(assessment, recorded)
        for topic in self.coverage:
            # An explicit reference to another candidate remains a hard error.
            for index in topic.attempt_ids:
                row = recorded.get(index)
                if (
                    row is not None
                    and topic.topic in row["plan"].topics
                    and row["plan"].candidate_id not in {None, candidate_id}
                ):
                    raise ValueError("Coverage belongs to another candidate")
            topic.attempt_ids = sorted(
                index
                for index, row in recorded.items()
                if topic.topic in row["plan"].topics
                and row["plan"].candidate_id in {None, candidate_id}
            )
            rows = [recorded[index] for index in topic.attempt_ids]
            if topic.status in {"findings", "checked_no_findings"} and (
                not rows or not any(row["observed"] for row in rows)
            ):
                raise CoverageCoherenceError("A failed search cannot establish absence")
            if topic.status == "not_attempted" and rows:
                raise CoverageCoherenceError("Unattempted topic has attempts")
            if (topic.status == "findings") != (topic.topic in findings):
                raise CoverageCoherenceError("Coverage and findings disagree")
        for section in self.sections:
            for fact in section.facts:
                if not {source.ref for source in fact.sources} <= (
                    refs & topic_sources[section.kind]
                ):
                    raise ValueError("Finding cites an unreceived source")
        return self


class FactReviewSelection(Contract):
    """A model-owned subset of immutable, already cited report facts."""

    kept_fact_ids: list[Annotated[str, Field(pattern=r"^f[1-9][0-9]{0,2}$")]] = Field(
        max_length=MAX_WORLD_MODEL_FACTS
    )
    summary: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def distinct_fact_ids(self):
        if len(set(self.kept_fact_ids)) != len(self.kept_fact_ids):
            raise ValueError("Fact review repeats an ID")
        return self
