"""Manifest-owned document and package judgements, with host-verified citations.

This module cannot read or share files. Its caller owns the live connection,
request revision, processing consent and source-version fences. Scores are
model assessments, never calibrated probabilities or permission grants.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

MAX_BATCH_DOCUMENTS = 6
MAX_PACKAGE_DOCUMENTS = 120
MAX_PROMPT_BYTES = 160 * 1024
ASSESSMENT_TIMEOUT_SECONDS = 60


class EvidenceQuote(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source_ref: str = Field(min_length=1, max_length=128)
    quote: str = Field(min_length=1, max_length=500)


class AssessedPeriod(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    period_start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    period_end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    source_refs: list[str]

    @model_validator(mode="after")
    def valid_period(self):
        if date.fromisoformat(self.period_start) > date.fromisoformat(self.period_end):
            raise ValueError("reversed content period")
        if not 1 <= len(self.source_refs) <= 8:
            raise ValueError("invalid period references")
        return self


class DocumentAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    document_ref: str = Field(min_length=1, max_length=128)
    decision: Literal["include", "exclude", "uncertain"]
    confidence: int = Field(ge=0, le=100)
    reason: str = Field(min_length=1, max_length=500)
    citations: list[EvidenceQuote]
    covered_periods: list[AssessedPeriod]

    @model_validator(mode="after")
    def bounded_evidence(self):
        if len(self.citations) > 8 or len(self.covered_periods) > 8:
            raise ValueError("too much assessment evidence")
        if self.decision == "include" and not self.citations:
            raise ValueError("included document requires content evidence")
        return self


class DocumentBatchAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    documents: list[DocumentAssessment]


class BoundDocumentAssessment(DocumentAssessment):
    """Provider version is copied by the host, never supplied by the model."""

    source_version: str


class BoundDocumentBatchAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    documents: list[BoundDocumentAssessment]
    confidence_kind: Literal["model_assessment"] = "model_assessment"
    calibrated_probability: None = None


class PackageAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    decision: Literal["ready", "partial", "no_match", "insufficient_evidence"]
    coverage_status: Literal["complete", "partial", "unknown"]
    selected_document_refs: list[str]
    confidence: int = Field(ge=0, le=100)
    importance: int = Field(ge=1, le=500)
    suggested_price_cents: int = Field(ge=50, le=50000)
    rationale: str = Field(min_length=1, max_length=1000)
    coverage_summary: str = Field(min_length=1, max_length=1000)
    gaps: list[str]

    @model_validator(mode="after")
    def bounded_package(self):
        if len(self.selected_document_refs) > MAX_PACKAGE_DOCUMENTS or len(self.gaps) > 24:
            raise ValueError("oversized package assessment")
        if any(not gap or len(gap) > 500 for gap in self.gaps):
            raise ValueError("invalid package gap")
        if len(set(self.selected_document_refs)) != len(self.selected_document_refs):
            raise ValueError("duplicate package reference")
        if (self.decision in {"ready", "partial"}) != bool(self.selected_document_refs):
            raise ValueError("package decision and selection disagree")
        if self.decision == "ready" and self.gaps:
            raise ValueError("ready package cannot have gaps")
        if (self.decision == "ready") != (self.coverage_status == "complete"):
            raise ValueError("package decision and coverage disagree")
        return self


def _prompt(payload: dict) -> str:
    prompt = json.dumps(payload, ensure_ascii=False)
    if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise ValueError("package assessment input exceeds context budget")
    return prompt


async def _interpret(*, prompt, user_id, output_schema):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_suggestions")
    if (
        gene.privacy.plaintext_telemetry
        or gene.runtime.adk_mode != "single_turn"
        or gene.runtime.transport != ["in_process"]
    ):
        raise ValueError("invalid package interpreter")
    agent = build_single_turn_agent(gene, output_schema=output_schema)
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        user_id=user_id,
        consent_token="",
        timeout_seconds=ASSESSMENT_TIMEOUT_SECONDS,  # nosec B106
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


async def interpret_document_batch(*, prompt, user_id):
    return await _interpret(prompt=prompt, user_id=user_id, output_schema=DocumentBatchAssessment)


async def interpret_package(*, prompt, user_id):
    return await _interpret(prompt=prompt, user_id=user_id, output_schema=PackageAssessment)


def _sources(retrieved: dict) -> tuple[list[dict], dict[str, dict], dict[str, str]]:
    content = retrieved.get("untrusted_external_content", [])
    if not isinstance(content, list) or len(content) > 48:
        raise ValueError("invalid document source collection")
    sources: dict[str, dict] = {}
    versions: dict[str, str] = {}
    for source in content:
        if not isinstance(source, dict) or any(
            not isinstance(source.get(key), str) or not source[key]
            for key in ("source_ref", "document_ref", "text", "source_version")
        ):
            raise ValueError("document source requires text and a provider version")
        ref, document, version = (
            source["source_ref"],
            source["document_ref"],
            source["source_version"],
        )
        if ref in sources or (document in versions and versions[document] != version):
            raise ValueError("duplicate or inconsistent document source")
        sources[ref] = source
        versions[document] = version
    if not 1 <= len(versions) <= MAX_BATCH_DOCUMENTS:
        raise ValueError("document assessment requires one to six documents")
    return content, sources, versions


def validate_document_batch(result, *, retrieved: dict) -> BoundDocumentBatchAssessment:
    """Validate identity/evidence integrity without interpreting document meaning."""
    _, sources, versions = _sources(retrieved)
    parsed = DocumentBatchAssessment.model_validate(result)
    refs = [item.document_ref for item in parsed.documents]
    if len(refs) != len(set(refs)) or set(refs) != set(versions):
        raise ValueError("assessment must account for every supplied document exactly once")
    bound = []
    for item in parsed.documents:
        for citation in item.citations:
            source = sources.get(citation.source_ref)
            if (
                not source
                or source["document_ref"] != item.document_ref
                or citation.quote not in source["text"]
                or not citation.quote.strip()
            ):
                raise ValueError("assessment citation does not match observed content")
        cited = {citation.source_ref for citation in item.citations}
        if any(not set(period.source_refs) <= cited for period in item.covered_periods):
            raise ValueError("content period requires same-document cited evidence")
        bound.append(
            BoundDocumentAssessment(**item.model_dump(), source_version=versions[item.document_ref])
        )
    return BoundDocumentBatchAssessment(documents=bound)


async def assess_document_batch(
    *, request: dict, retrieved: dict, user_id: str, interpreter=interpret_document_batch
) -> BoundDocumentBatchAssessment:
    _sources(retrieved)
    result = await interpreter(
        prompt=_prompt(
            {
                "package_mode": "document_assessment",
                "document_request": request,
                "retrieved_documents": retrieved,
            }
        ),
        user_id=user_id,
    )
    return validate_document_batch(result, retrieved=retrieved)


async def assess_package(
    *,
    request: dict,
    assessments: list[BoundDocumentAssessment],
    user_id: str,
    truncated: bool = False,
    unreadable: list | None = None,
    retrieval_counts: dict | None = None,
    interpreter=interpret_package,
) -> PackageAssessment:
    if len(assessments) > MAX_PACKAGE_DOCUMENTS:
        raise ValueError("too many document assessments")
    known = {item.document_ref: item for item in assessments}
    if len(known) != len(assessments):
        raise ValueError("duplicate assessed document")
    result = PackageAssessment.model_validate(
        await interpreter(
            prompt=_prompt(
                {
                    "package_mode": "package_assessment",
                    "document_request": request,
                    "document_assessments": [item.model_dump() for item in assessments],
                    "truncated": truncated,
                    "unreadable": unreadable or [],
                    "retrieval_counts": retrieval_counts or {},
                }
            ),
            user_id=user_id,
        )
    )
    if any(
        ref not in known or known[ref].decision != "include"
        for ref in result.selected_document_refs
    ):
        raise ValueError("package includes an unverified document")
    if result.decision == "ready" and (
        truncated or unreadable or any(item.decision == "uncertain" for item in assessments)
    ):
        raise ValueError("ready package has unresolved retrieval evidence")
    return result
