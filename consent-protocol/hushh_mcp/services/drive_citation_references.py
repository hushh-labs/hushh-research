"""Lossless citation references for model wire output, resolved before storage.

The model chooses evidence IDs. This leaf only binds each ID to its exact supplied
source text and location; it never changes a fact value or judges its meaning.
"""

from __future__ import annotations

from pydantic import Field

from hushh_mcp.services.drive_packet_contract import (
    CanonicalPacketKey,
    DateRole,
    DocumentFacts,
    DocumentPageFacts,
    EvidenceModel,
    RecordStatusBasis,
    RecordStatusValue,
)

FACT_FIELDS = (
    "document_type",
    "issuer",
    "subject",
    "account",
    "record_status",
    "periods",
    "date_evidence",
    "topics",
    "facts",
)
SPAN_CHARACTERS = 300


class ReferencedFact(EvidenceModel):
    value: str = Field(min_length=1, max_length=500)
    citation_refs: list[str] = Field(min_length=1, max_length=8)


class ReferencedPeriod(EvidenceModel):
    start: str
    end: str
    citation_refs: list[str] = Field(min_length=1, max_length=8)


class ReferencedDateEvidence(EvidenceModel):
    role: DateRole
    start: str | None
    end: str | None
    meaning: str = Field(min_length=1, max_length=500)
    citation_refs: list[str] = Field(min_length=1, max_length=8)


class ReferencedRecordStatus(EvidenceModel):
    status: RecordStatusValue
    evidence_basis: RecordStatusBasis
    explanation: str = Field(min_length=1, max_length=1000)
    citation_refs: list[str] = Field(max_length=8)


class ReferencedPageFacts(EvidenceModel):
    pages: list[int] = Field(min_length=1)
    document_type: ReferencedFact | None
    issuer: ReferencedFact | None
    subject: ReferencedFact | None
    account: ReferencedFact | None
    record_status: ReferencedRecordStatus
    periods: list[ReferencedPeriod] = Field(max_length=24)
    date_evidence: list[ReferencedDateEvidence] = Field(max_length=24)
    topics: list[ReferencedFact] = Field(max_length=16)
    facts: list[ReferencedFact] = Field(max_length=32)
    missing_information: list[str] = Field(max_length=24)
    ambiguous: bool


class ReferencedDocumentFacts(EvidenceModel):
    document_type: ReferencedFact | None
    issuer: ReferencedFact | None
    subject: ReferencedFact | None
    account: ReferencedFact | None
    record_status: ReferencedRecordStatus
    periods: list[ReferencedPeriod] = Field(max_length=120)
    date_evidence: list[ReferencedDateEvidence] = Field(max_length=120)
    topics: list[ReferencedFact] = Field(max_length=24)
    facts: list[ReferencedFact] = Field(max_length=64)
    missing_information: list[str] = Field(max_length=32)
    ambiguous: bool
    canonical_packets: list[CanonicalPacketKey] = Field(max_length=4)


def page_references(pages):
    """Replace full text with lossless, contiguous spans; never duplicate or drop it."""
    encoded, references = [], {}
    for page in pages:
        text = page["text"]
        spans, start = [], 0
        while start < len(text):
            end = min(start + SPAN_CHARACTERS, len(text))
            newline = text.rfind("\n", start, end)
            if newline >= start + SPAN_CHARACTERS // 2:
                end = newline + 1
            ref = f"p{page['page']}s{len(spans)}"
            quote = text[start:end]
            references[ref] = {
                "page": int(page["page"]),
                "unit_kind": page.get("unit_kind", "page"),
                "quote": quote,
            }
            spans.append({"ref": ref, "text": quote})
            start = end
        encoded.append({**{k: v for k, v in page.items() if k != "text"}, "text_spans": spans})
    return encoded, references


def _records(payload):
    for field in FACT_FIELDS:
        value = payload[field]
        for record in value if isinstance(value, list) else [value]:
            if record is not None:
                yield record


def fact_references(previous, observations):
    """Deduplicate already validated quotes without borrowing any catalog evidence."""
    references, identities = {}, {}

    def encode(model):
        if model is None:
            return None
        payload = model.model_dump()
        for record in _records(payload):
            refs = []
            for citation in record.pop("citations"):
                identity = (citation["page"], citation["unit_kind"], citation["quote"])
                if identity not in identities:
                    ref = f"c{len(references)}"
                    identities[identity] = ref
                    references[ref] = citation
                refs.append(identities[identity])
            record["citation_refs"] = refs
        return payload

    encoded_previous = encode(previous)
    encoded_observations = [encode(item) for item in observations]
    return encoded_previous, encoded_observations, references


def resolve_references(result, references, *, document=False):
    payload = result.model_dump()
    for record in _records(payload):
        refs = record.pop("citation_refs")
        if any(ref not in references for ref in refs):
            raise ValueError("unknown citation reference")
        record["citations"] = [dict(references[ref]) for ref in refs]
    return (DocumentFacts if document else DocumentPageFacts).model_validate(payload)
