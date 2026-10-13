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


class DocumentPageFacts(EvidenceModel):
    """Request-independent observations from an explicitly accounted page range."""

    pages: list[int] = Field(min_length=1)
    document_type: EvidenceFact | None
    issuer: EvidenceFact | None
    subject: EvidenceFact | None
    account: EvidenceFact | None
    periods: list[ContentPeriod] = Field(max_length=24)
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
    periods: list[ContentPeriod] = Field(max_length=120)
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


class PacketAssessment(EvidenceModel):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=1000)
    state: Literal["ready", "incomplete", "unable_to_verify"]
    selected_document_ids: list[str]
    coverage_summary: str = Field(min_length=1, max_length=1000)
    periods: list[ContentPeriod] = Field(max_length=120)
    gaps: list[str] = Field(max_length=64)
    assessment_score: int = Field(ge=0, le=100)
    importance: int = Field(ge=1, le=500)
    pricing: PricingAssessment

    @model_validator(mode="after")
    def coherent(self):
        if len(set(self.selected_document_ids)) != len(self.selected_document_ids):
            raise ValueError("duplicate packet membership")
        if self.state == "ready" and (
            not self.selected_document_ids
            or self.gaps
            or self.pricing.coverage != "complete"
            or self.pricing.quality != "verified"
        ):
            raise ValueError("ready packet requires complete evidence")
        return self


class PacketVerification(EvidenceModel):
    """Independent runtime checking stage; benchmark reference labels remain external."""

    state: Literal["ready", "incomplete", "unable_to_verify"]
    correct_subject_and_account: bool
    correct_issuer_and_type: bool
    correct_coverage: bool
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
        if self.state == "ready" and (not all(checks) or self.issues):
            raise ValueError("checker cannot declare unresolved packet ready")
        return self


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
        *result.periods,
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
