"""Shared evidence contracts for reusable private Drive packets.

The Documents manifest owns meaning. These types validate identities, citations,
coverage accounting and immutable version bindings; none grants read or sale access.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class EvidenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        """Keep Vertex's response grammar small; full host validation still runs.

        Expanding bounded arrays of nested citations exceeded the provider's
        grammar complexity (400). These are presentation constraints only:
        Pydantic retains every original field limit and validator at acceptance.
        """
        schema = super().model_json_schema(*args, **kwargs)
        host_constraints = {
            "minItems",
            "maxItems",
            "minLength",
            "maxLength",
            "minimum",
            "maximum",
            "title",
            "default",
        }

        def project(node):
            if isinstance(node, dict):
                result = {}
                for key, value in node.items():
                    if key in host_constraints:
                        continue
                    # These dictionaries contain user-defined names, not schema
                    # keywords. A field named "title" is still required data.
                    if key in {"properties", "$defs", "definitions", "patternProperties"}:
                        result[key] = {name: project(child) for name, child in value.items()}
                    else:
                        result[key] = project(value)
                return result
            return [project(value) for value in node] if isinstance(node, list) else node

        return project(schema)


class PageCitation(EvidenceModel):
    page: int = Field(ge=1)
    unit_kind: Literal["page", "text_segment"] = "page"
    quote: str = Field(min_length=1, max_length=1000)


class EvidenceFact(EvidenceModel):
    value: str = Field(min_length=1, max_length=500)
    citations: list[PageCitation] = Field(min_length=1, max_length=8)


class ContentPeriod(EvidenceModel):
    start: str
    end: str
    citations: list[PageCitation] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def dates(self):
        if date.fromisoformat(self.start) > date.fromisoformat(self.end):
            raise ValueError("reversed content period")
        return self


DateRole = Literal["event", "publication", "planned_action", "transaction", "as_of", "unknown"]
TemporalScope = Literal["document_period", "as_of_snapshot", "no_period_claim", "unknown"]
RecordStatusValue = Literal[
    "draft", "sample", "requested", "pending", "completed", "cancelled", "unknown"
]
RecordStatusBasis = Literal[
    "documentary_form", "source_assertion", "completion_evidence", "unknown"
]


class RecordStatus(EvidenceModel):
    """Model-authored status and its evidence, not a host authenticity judgment."""

    status: RecordStatusValue
    evidence_basis: RecordStatusBasis
    explanation: str = Field(min_length=1, max_length=1000)
    citations: list[PageCitation] = Field(max_length=8)

    @model_validator(mode="after")
    def supported_status(self):
        if self.status != "unknown" and self.evidence_basis == "unknown":
            raise ValueError("known record status requires an evidence basis")
        if (self.status != "unknown" or self.evidence_basis != "unknown") and not self.citations:
            raise ValueError("record status evidence requires citations")
        if self.status == "completed" and self.evidence_basis != "completion_evidence":
            raise ValueError("completed record requires completion evidence")
        return self


def unknown_record_status() -> RecordStatus:
    """Read historical facts without retroactively assigning their record status."""
    return RecordStatus(
        status="unknown",
        evidence_basis="unknown",
        explanation="Record status was not assessed under this facts policy.",
        citations=[],
    )


class DateEvidence(EvidenceModel):
    """A date mentioned by content, without claiming a document coverage window."""

    role: DateRole
    start: str | None
    end: str | None
    meaning: str = Field(min_length=1, max_length=500)
    citations: list[PageCitation] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def dates(self):
        if (self.start is None) != (self.end is None):
            raise ValueError("date evidence requires both endpoints or neither")
        if self.start is not None:
            if date.fromisoformat(self.start) > date.fromisoformat(self.end):
                raise ValueError("reversed date evidence")
            if self.role == "as_of" and self.start != self.end:
                raise ValueError("as-of evidence is a snapshot date")
        return self


class DocumentPageFacts(EvidenceModel):
    """Request-independent observations from an explicitly accounted page range."""

    pages: list[int] = Field(min_length=1)
    document_type: EvidenceFact | None
    issuer: EvidenceFact | None
    subject: EvidenceFact | None
    account: EvidenceFact | None
    record_status: RecordStatus = Field(default_factory=unknown_record_status)
    periods: list[ContentPeriod] = Field(max_length=24)
    date_evidence: list[DateEvidence] = Field(default_factory=list, max_length=24)
    topics: list[EvidenceFact] = Field(max_length=16)
    facts: list[EvidenceFact] = Field(max_length=32)
    missing_information: list[str] = Field(max_length=24)
    ambiguous: bool


class CanonicalPacketKey(EvidenceModel):
    """The model proposes a stable semantic key, never a permission or DB identity."""

    key: str = Field(min_length=1, max_length=500)
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=1000)


class DocumentFacts(EvidenceModel):
    document_type: EvidenceFact | None
    issuer: EvidenceFact | None
    subject: EvidenceFact | None
    account: EvidenceFact | None
    record_status: RecordStatus = Field(default_factory=unknown_record_status)
    periods: list[ContentPeriod] = Field(max_length=120)
    date_evidence: list[DateEvidence] = Field(default_factory=list, max_length=120)
    topics: list[EvidenceFact] = Field(max_length=24)
    facts: list[EvidenceFact] = Field(max_length=64)
    missing_information: list[str] = Field(max_length=32)
    ambiguous: bool
    canonical_packets: list[CanonicalPacketKey] = Field(max_length=4)


class PacketSource(EvidenceModel):
    document_id: str
    source_version: str
    extraction_profile: str
    facts_version: str


class PricingAssessment(EvidenceModel):
    rubric_version: Literal["drive-packet-price-v1"]
    useful_scope: Literal["single", "period", "multi_period", "collection"]
    coverage: Literal["complete", "partial", "unknown"]
    quality: Literal["verified", "limited", "unverifiable"]
    rationale: str = Field(min_length=1, max_length=500)
    suggested_price_cents: int = Field(ge=50, le=50000)


class PacketExclusion(EvidenceModel):
    document_id: str = Field(min_length=1)
    reason: Literal["duplicate", "outside_group", "unverifiable"]
    explanation: str = Field(min_length=1, max_length=1000)
    duplicate_of_document_id: str | None = None


class PacketAssessment(EvidenceModel):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=1000)
    state: Literal["ready", "incomplete", "unable_to_verify"]
    selected_document_ids: list[str]
    # Older immutable manifests remain readable. New construction separately
    # requires explicit accounting for every supplied candidate.
    excluded_documents: list[PacketExclusion] = Field(default_factory=list)
    coverage_summary: str = Field(min_length=1, max_length=1000)
    periods: list[ContentPeriod] = Field(max_length=120)
    # Legacy immutable manifests have no typed scope. New model proposals must
    # supply it, using PacketProposal below; historical approvals remain readable.
    temporal_scope: TemporalScope = "unknown"
    gaps: list[str] = Field(max_length=64)
    assessment_score: int = Field(ge=0, le=100)
    importance: int = Field(ge=1, le=500)
    pricing: PricingAssessment
    # Historical immutable manifests predate a separate buyer-usefulness check.
    standalone_value: Literal["supported", "unsupported", "unknown"] | None = None
    utility_rationale: str | None = Field(default=None, min_length=1, max_length=500)

    @model_validator(mode="after")
    def coherent(self):
        if len(set(self.selected_document_ids)) != len(self.selected_document_ids):
            raise ValueError("duplicate packet membership")
        excluded = [item.document_id for item in self.excluded_documents]
        if len(set(excluded)) != len(excluded) or set(excluded) & set(self.selected_document_ids):
            raise ValueError("invalid packet exclusion")
        for item in self.excluded_documents:
            if item.reason == "duplicate":
                if item.duplicate_of_document_id not in self.selected_document_ids:
                    raise ValueError("invalid packet exclusion")
            elif item.duplicate_of_document_id is not None:
                raise ValueError("invalid packet exclusion")
        if self.state == "ready" and (
            not self.selected_document_ids
            or self.gaps
            or any(item.reason == "unverifiable" for item in self.excluded_documents)
            or self.pricing.coverage != "complete"
            or self.pricing.quality != "verified"
        ):
            raise ValueError("ready packet requires complete evidence")
        return self


class PacketProposal(PacketAssessment):
    temporal_scope: TemporalScope
    standalone_value: Literal["supported", "unsupported", "unknown"]
    utility_rationale: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def temporal_claim(self):
        if self.state == "ready" and self.standalone_value != "supported":
            raise ValueError("ready packet requires supported standalone value")
        if self.periods and self.temporal_scope != "document_period":
            raise ValueError("periods require document-period scope")
        if self.state == "ready" and (
            self.temporal_scope == "unknown"
            or (self.temporal_scope == "document_period" and not self.periods)
        ):
            raise ValueError("ready packet requires an explicit supported temporal scope")
        if self.temporal_scope in {"as_of_snapshot", "no_period_claim"} and (
            self.pricing.useful_scope in {"period", "multi_period"}
        ):
            raise ValueError("snapshot or undated packet cannot be priced as period coverage")
        return self


class PacketVerification(EvidenceModel):
    """Independent runtime checking stage; benchmark reference labels remain external."""

    state: Literal["ready", "incomplete", "unable_to_verify"]
    correct_subject_and_account: bool
    correct_issuer_and_type: bool
    correct_coverage: bool
    # Historical immutable checker records predate this separate assertion.
    # Current model output must supply it through PacketVerificationProposal.
    correct_record_status: bool | None = None
    # Legacy checker rows are readable; new Ready verdicts must assess this.
    correct_standalone_value: bool | None = None
    no_unrelated_inclusions: bool
    no_unexplained_omissions: bool
    issues: list[str] = Field(max_length=64)

    @model_validator(mode="after")
    def ready_is_verified(self):
        checks = (
            self.correct_subject_and_account,
            self.correct_issuer_and_type,
            self.correct_coverage,
            self.no_unrelated_inclusions,
            self.no_unexplained_omissions,
        )
        if self.state == "ready" and (
            not all(checks)
            or self.correct_record_status is False
            or self.correct_standalone_value is False
            or self.issues
        ):
            raise ValueError("checker cannot declare unresolved packet ready")
        return self


class PacketVerificationProposal(PacketVerification):
    correct_record_status: bool
    correct_standalone_value: bool


class PacketRequestMatch(EvidenceModel):
    decision: Literal["exact", "derive", "no_match", "unable_to_verify"]
    packet_id: str | None
    version: int | None
    reason: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def identity(self):
        if (self.decision in {"exact", "derive"}) != (
            self.packet_id is not None and self.version is not None
        ):
            raise ValueError("matched packet requires an identity")
        if self.version is not None and self.version < 1:
            raise ValueError("invalid packet version")
        return self


def evidence_digest(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def validate_page_citations(
    result: DocumentPageFacts, pages: dict[int, str], unit_kinds: dict[int, str] | None = None
) -> None:
    """Require exact supplied pages and quotations; never infer semantic correctness."""
    if len(set(result.pages)) != len(result.pages) or set(result.pages) != set(pages):
        raise ValueError("unaccounted extraction pages")
    records = [
        result.document_type,
        result.issuer,
        result.subject,
        result.account,
        result.record_status,
        *result.periods,
        *result.date_evidence,
        *result.topics,
        *result.facts,
    ]
    for fact in records:
        if fact is None:
            continue
        for citation in fact.citations:
            if citation.page not in pages or citation.quote not in pages[citation.page]:
                raise ValueError("unsupported fact citation")
            if unit_kinds and citation.unit_kind != unit_kinds[citation.page]:
                raise ValueError("citation location kind differs from extraction")
