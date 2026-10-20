"""Manifest-owned document and package judgements, with host-verified citations.

This module cannot read or share files. Its caller owns the live connection,
request revision, processing consent and source-version fences. Scores are
model assessments, never calibrated probabilities or permission grants.
"""

from __future__ import annotations

import asyncio
import calendar
import json
import os
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import date, timedelta
from functools import partial
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers.vertex_failover import is_retryable_vertex_error
from hushh_mcp.services.drive_request_model_feedback import validation_feedback

MAX_BATCH_DOCUMENTS = 6
MAX_PACKAGE_DOCUMENTS = 120
MAX_PROMPT_BYTES = 160 * 1024
ASSESSMENT_TIMEOUT_SECONDS = 60
REQUEST_ASSESSMENT_TIMEOUT_SECONDS = 75
REQUEST_FIRST_ATTEMPT_TIMEOUT_SECONDS = 55


def semantic_request_model_binding(
    *,
    provider: str | None = None,
    approval_generation: str | None = None,
    authorization_basis: str | None = None,
) -> dict[str, str | None]:
    """Resolve a provider descriptor without granting access to private content."""
    from hushh_mcp.managed_ai_config import load_pwm_policy, profile_hash
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
    from hushh_mcp.runtime_providers.managed_text import managed_text_binding, managed_text_policy
    from hushh_mcp.runtime_settings import managed_ai_settings

    if provider is None and managed_text_policy() is not None:
        return managed_text_binding()
    provider = (
        (
            os.environ.get("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "gemini")
            if provider is None
            else provider
        )
        .strip()
        .lower()
    )
    if provider == "gemini":
        if approval_generation is not None or authorization_basis is not None:
            raise ValueError("Gemini binding cannot contain an Azure approval")
        settings = managed_ai_settings()
        return {
            "provider": "gemini",
            "deployment": resolve_fleet_model_name("gemini-default"),
            "config_fingerprint": settings.config_hash,
            "approval_generation": None,
        }
    if provider != "azure_openai" or os.environ.get("ENVIRONMENT", "").lower() != "uat":
        raise ValueError("Unsupported Documents semantic model binding")
    if authorization_basis not in {None, "uat_policy"}:
        raise ValueError("Invalid Documents authorization basis")
    if authorization_basis == "uat_policy":
        from hushh_mcp.services.private_text_processing_approval_service import (
            private_drive_text_policy,
        )

        active_policy = private_drive_text_policy()
        if active_policy is None or approval_generation != active_policy["generation"]:
            raise ValueError("Documents UAT processing policy changed")
    policy = load_pwm_policy(environment="uat")
    if policy["provider"] != "azure_openai_web_search":
        raise ValueError("Documents requires the trusted UAT Azure configuration")
    if approval_generation is not None:
        try:
            approval_generation = str(uuid.UUID(approval_generation))
        except (ValueError, TypeError, AttributeError):
            raise ValueError("Invalid private text approval generation") from None
    return {
        "provider": "azure_openai",
        "deployment": policy["azure"]["primary_deployment"],
        "config_fingerprint": profile_hash(policy["azure"]),
        "approval_generation": approval_generation,
        **({"authorization_basis": authorization_basis} if authorization_basis else {}),
    }


def validate_semantic_model_binding(binding: dict | None) -> dict[str, str | None]:
    """Freeze old jobs on Gemini and reject a changed or disabled Azure binding."""
    if binding is None:
        return semantic_request_model_binding(provider="gemini")
    fields = {
        "provider",
        "deployment",
        "config_fingerprint",
        "approval_generation",
    }
    if (
        not isinstance(binding, dict)
        or set(binding) not in (fields, fields | {"authorization_basis"})
        or ("authorization_basis" in binding and binding["authorization_basis"] != "uat_policy")
    ):
        raise ValueError("Invalid Documents model binding")
    provider = binding.get("provider")
    generation = binding.get("approval_generation")
    if (
        not isinstance(provider, str)
        or provider not in {"gemini", "azure_openai"}
        or (provider == "azure_openai" and generation is None)
    ):
        raise ValueError("Invalid Documents model binding")
    if (
        not isinstance(binding.get("deployment"), str)
        or not isinstance(binding.get("config_fingerprint"), str)
        or (generation is not None and not isinstance(generation, str))
    ):
        raise ValueError("Invalid Documents model binding")
    expected = semantic_request_model_binding(
        provider=provider,
        approval_generation=generation,
        **(
            {"authorization_basis": "uat_policy"}
            if binding.get("authorization_basis") == "uat_policy"
            else {}
        ),
    )
    if binding != expected:
        raise ValueError("Documents model binding changed")
    return expected


def build_semantic_request_azure_model(*, require_current, model_binding: dict | None = None):
    """Trusted transport construction; callers must supply their invocation authority."""
    from hushh_mcp.managed_ai_config import load_pwm_policy
    from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel

    binding = (
        semantic_request_model_binding()
        if model_binding is None
        else validate_semantic_model_binding(model_binding)
    )
    if binding["provider"] != "azure_openai" or require_current is None:
        raise ValueError("Azure Documents transport requires a current-authority guard")
    config = load_pwm_policy(environment="uat")["azure"]
    return AzureOpenAIAdkModel.from_keyless(
        endpoint=config["primary_endpoint"],
        deployment=config["primary_deployment"],
        tenant_id=config["tenant_id"],
        client_id=config["client_id"],
        require_current=require_current,
    )


async def private_semantic_request_model(
    *, user_id, require_current=None, model_binding: dict | None = None
):
    """Bind one explicit owner approval generation for this operation and every retry."""
    binding = (
        semantic_request_model_binding()
        if model_binding is None
        else validate_semantic_model_binding(model_binding)
    )
    if binding["provider"] == "gemini":
        from hushh_mcp.runtime_providers.managed_text import managed_text_policy

        if managed_text_policy() is not None:
            raise ValueError("Documents processor binding requires recorded UAT migration")
        return None
    from hushh_mcp.services.private_text_processing_approval_service import (
        private_azure_text_require_current,
        require_private_azure_text_approval,
    )

    await _require_request_current(require_current)
    grant = await require_private_azure_text_approval(
        user_id,
        expected_generation=binding["approval_generation"],
        **(
            {"scope": "drive_document_requests"}
            if binding.get("authorization_basis") == "uat_policy"
            else {}
        ),
    )
    approval_current = private_azure_text_require_current(grant)

    async def current():
        await _require_request_current(require_current)
        await approval_current()

    if binding.get("authorization_basis") == "uat_policy":
        from hushh_mcp.runtime_providers.managed_text import build_managed_text_model

        return build_managed_text_model(scope="drive_document_requests", require_current=current)
    return build_semantic_request_azure_model(require_current=current, model_binding=binding)


class RequestAssessmentAuthorityError(RuntimeError):
    """Keep a failed current-authority guard outside model-failure handling."""


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
    # Legacy assessments omit this. V1 request-scoped selections require a
    # separate comparative 1–10 judgment; neither value is a probability.
    weightage_out_of_10: float | None = Field(default=None, ge=1, le=10, allow_inf_nan=False)
    # Typed semantic claims are model judgments. The host binds their cited
    # quotations to this exact source; independent eval grades their meaning.
    record_type_claim: str | None = Field(default=None, max_length=120)
    entity_claim: str | None = Field(default=None, max_length=120)
    period_role: Literal[
        "statement_coverage", "reporting_period", "event_date", "transaction_date", "unknown"
    ] = "unknown"
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


_MONTHS = (
    "jan(?:uary)?",
    "feb(?:ruary)?",
    "mar(?:ch)?",
    "apr(?:il)?",
    "may",
    "jun(?:e)?",
    "jul(?:y)?",
    "aug(?:ust)?",
    "sep(?:t(?:ember)?)?",
    "oct(?:ober)?",
    "nov(?:ember)?",
    "dec(?:ember)?",
)


def _cited_day(day: date, quotation: str) -> bool:
    """Require a claimed calendar endpoint in an exact source quotation.

    This is a lexical evidence gate, not a substitute for semantic date-role
    judgment. Both US and day-first numeric forms remain possible; the model
    must use the document's locale/context to decide which one is its period.
    """
    year, month, number = day.year, day.month, day.day
    yy = year % 100
    numeric = (
        rf"(?<!\d){year}[-/.]0?{month}[-/.]0?{number}(?!\d)",
        rf"(?<!\d)0?{month}[-/.]0?{number}[-/.](?:{year}|{yy:02d})(?!\d)",
        rf"(?<!\d)0?{number}[-/.]0?{month}[-/.](?:{year}|{yy:02d})(?!\d)",
    )
    if any(re.search(pattern, quotation) for pattern in numeric):
        return True
    month_name = _MONTHS[month - 1]
    # A year elsewhere in the same short quotation can qualify an interval
    # such as "September 1 – October 9, 2026".
    if not re.search(rf"(?<!\d){year}(?!\d)", quotation):
        return False
    named = (
        rf"\b{month_name}\.?\s+0?{number}(?:st|nd|rd|th)?\b",
        rf"\b0?{number}(?:st|nd|rd|th)?\s+{month_name}\b",
    )
    if any(re.search(pattern, quotation, re.I) for pattern in named):
        return True
    # A monthly statement often says only "September 2026". Calendar-month
    # endpoints can be normalized from that wording; arbitrary days cannot.
    if number not in {1, calendar.monthrange(year, month)[1]}:
        return False
    return bool(re.search(rf"\b{month_name}\.?\s+{year}\b", quotation, re.I))


_CLAIM_GENERIC = frozenset(
    {
        "a",
        "an",
        "and",
        "document",
        "documents",
        "file",
        "files",
        "for",
        "from",
        "of",
        "record",
        "records",
        "the",
    }
)


def _entity_cited(claim: str | None, quotation: str) -> bool:
    """Require the full issuer/subject name in one cited quotation."""
    if not claim:
        return False
    terms = [token.casefold() for token in re.findall(r"[^\W_]+", claim, re.UNICODE)]
    while terms and terms[0] in _CLAIM_GENERIC:
        terms.pop(0)
    while terms and terms[-1] in _CLAIM_GENERIC:
        terms.pop()
    if not any(len(token) >= 3 and token not in _CLAIM_GENERIC for token in terms):
        return False
    cited = [token.casefold() for token in re.findall(r"[^\W_]+", quotation, re.UNICODE)]
    return any(cited[index : index + len(terms)] == terms for index in range(len(cited)))


def _record_type_cited(claim: str, quotation: str, *, institutional_statement: bool) -> bool:
    """Evidence validation after retrieval, never a filename discovery rule."""
    tokens = [
        token.casefold()
        for token in re.findall(r"[^\W_]+", claim, re.UNICODE)
        if len(token) >= 4 and token.casefold() not in _CLAIM_GENERIC
    ]
    cited = {token.casefold() for token in re.findall(r"[^\W_]+", quotation, re.UNICODE)}
    has_statement_alias = (
        institutional_statement
        and "statement" in tokens
        and bool(cited.intersection({"estmt", "estatement", "stmt", "stmts"}))
    )
    if not tokens or not (any(term in cited for term in tokens) or has_statement_alias):
        return False
    if not institutional_statement:
        return True
    # An educational bulletin can mention statements without being one. A
    # positive account-statement heading/eStatement cue must be cited.
    for match in re.finditer(r"\b(?:(?:e-?)?statements?|e-?stmts?|stmts?)\b", quotation, re.I):
        prefix = quotation[max(0, match.start() - 48) : match.start()]
        if re.search(r"\b(?:not|never|how\s+to\s+read|guide\s+to|about)\b[^.!?\n]*$", prefix, re.I):
            continue
        if re.search(
            r"\b(?:account|brokerage|bank|monthly|quarterly|annual|investment|portfolio)\s*$",
            prefix,
            re.I,
        ):
            return True
        if re.search(r"\be-?statement\b", quotation[: match.end()], re.I):
            return True
    return False


_NOTE_CUE = re.compile(r"\b(?:meeting\s+notes?|minutes|notes\s+by\s+gemini)\b", re.I)


def _note_cue_negated(text: str, start: int, end: int) -> bool:
    nearby = text[max(0, start - 40) : min(len(text), end + 50)]
    return bool(
        re.search(r"\b(?:no|without|missing)\s+(?:meeting\s+notes?|minutes)\b", nearby, re.I)
        or re.search(
            r"\b(?:meeting\s+notes?|minutes)\b[^.!?\n]{0,35}"
            r"\b(?:not\s+available|unavailable|missing|absent|not\s+(?:recorded|taken))\b",
            nearby,
            re.I,
        )
    )


def _meeting_note_type_cited(claim: str, quotation: str) -> bool:
    """A meeting title alone is not evidence that notes were recorded."""
    if not re.search(r"\b(?:notes?|minutes)\b", claim, re.I):
        return False
    if not re.search(r"\b(?:meetings?|stand[\s-]?up|syncs?|huddles?)\b", quotation, re.I):
        return False
    affirmative_note = any(
        not _note_cue_negated(quotation, match.start(), match.end())
        for match in _NOTE_CUE.finditer(quotation)
    )
    return bool(
        affirmative_note
        or re.search(
            r"\b(?:decisions?|action\s+items?|discussion|takeaways|blockers)\b"
            r"(?:\s*:|\s*\n\s*(?:[-•*]|\d+[.)]))",
            quotation,
            re.I,
        )
        or (
            re.search(
                r"\b(?:discussed|decided|agreed|reviewed|identified|noted|resolved)\b",
                quotation,
                re.I,
            )
            and not re.search(r"\b(?:agenda|planned|scheduled|upcoming)\b", quotation, re.I)
            and not any(
                _note_cue_negated(quotation, match.start(), match.end())
                for match in _NOTE_CUE.finditer(quotation)
            )
        )
    )


def _meeting_event_date_cited(day: date, quotation: str) -> bool:
    if not _cited_day(day, quotation):
        return False
    # A note's next scheduled meeting is not the event date of these notes.
    # Keep ambiguous mixed quotations uncertain so the model can cite the
    # actual meeting header instead of laundering a planned date.
    return not re.search(
        r"\b(?:next\s+meeting|upcoming|scheduled|planned|due\s+date|published|last\s+updated)\b",
        quotation,
        re.I,
    )


_MEETING_NOTE_EVIDENCE = re.compile(
    r"\b(?:meeting\s+notes?|minutes|notes\s+by\s+gemini)\b"
    r"|\b(?:decisions?|action\s+items?|discussion|takeaways|blockers)\b"
    r"(?:\s*:|\s*\n\s*(?:[-•*]|\d+[.)]))",
    re.I,
)
_MEETING_CUE = re.compile(r"\b(?:meetings?|stand[\s-]?up|syncs?|huddles?)\b", re.I)


def _recover_meeting_citations(item, citations, document_sources, required_entities):
    """Bind omitted type/subject anchors to exact text from this document only.

    An existing valid model citation is required. Date citations and claimed
    periods are never synthesized here; the event-date gate stays independent.
    """
    if not citations:
        return citations
    recovered = list(citations)
    seen = {(cite.source_ref, cite.quote) for cite in recovered}

    def add(source_ref, quote):
        if len(recovered) >= 8 or not quote or len(quote) > 500:
            return
        if (source_ref, quote) not in seen:
            recovered.append(EvidenceQuote(source_ref=source_ref, quote=quote))
            seen.add((source_ref, quote))

    def joined():
        return "\n".join(cite.quote for cite in recovered)

    if item.record_type_claim and not _meeting_note_type_cited(item.record_type_claim, joined()):
        for pattern in (_MEETING_NOTE_EVIDENCE, _MEETING_CUE):
            for source_ref, source_text in document_sources:
                match = next(
                    (
                        match
                        for match in pattern.finditer(source_text)
                        if not (
                            _NOTE_CUE.fullmatch(match.group(0))
                            and _note_cue_negated(source_text, match.start(), match.end())
                        )
                    ),
                    None,
                )
                if match is not None:
                    add(source_ref, match.group(0))
                    break

    for claim in [item.entity_claim, *required_entities]:
        if not claim or any(_entity_cited(claim, cite.quote) for cite in recovered):
            continue
        terms = [token.casefold() for token in re.findall(r"[^\W_]+", claim, re.UNICODE)]
        while terms and terms[0] in _CLAIM_GENERIC:
            terms.pop(0)
        while terms and terms[-1] in _CLAIM_GENERIC:
            terms.pop()
        if not terms:
            continue
        for source_ref, source_text in document_sources:
            tokens = list(re.finditer(r"[^\W_]+", source_text, re.UNICODE))
            for index in range(len(tokens) - len(terms) + 1):
                if [
                    token.group(0).casefold() for token in tokens[index : index + len(terms)]
                ] != terms:
                    continue
                quote = source_text[tokens[index].start() : tokens[index + len(terms) - 1].end()]
                if _entity_cited(claim, quote):
                    add(source_ref, quote)
                    break
            if any(_entity_cited(claim, cite.quote) for cite in recovered):
                break
    return recovered


def verify_v1_document_batch(
    assessment: BoundDocumentBatchAssessment, *, request: dict, retrieved: dict
) -> BoundDocumentBatchAssessment:
    """Downgrade unsupported V1 inclusions without losing the other candidates.

    The model still decides meaning. The host binds typed claims to exact
    same-document citations, checks cited period dates and overlaps the
    selected window. Filename, modifiedTime and importance never substitute.
    """
    sources = {item["source_ref"]: item for item in retrieved["untrusted_external_content"]}
    try:
        start = date.fromisoformat(request["periodStart"])
        end = date.fromisoformat(request["periodEnd"])
    except (KeyError, TypeError, ValueError):
        start = end = None
    required_entities = request.get("requiredEntities")
    if not isinstance(required_entities, list) or not all(
        isinstance(entity, str) and 1 <= len(entity) <= 120 for entity in required_entities
    ):
        required_entities = []
    institutional = request.get("semanticIntent") == "institutional_statement"
    purpose = request.get("purpose", "")
    meeting_notes = bool(
        re.search(r"\b(?:notes?|minutes)\b", purpose, re.I)
        and re.search(r"\b(?:meetings?|stand[\s-]?up|syncs?|huddles?)\b", purpose, re.I)
    )
    checked = []
    for item in assessment.documents:
        if item.decision != "include":
            checked.append(item)
            continue
        citations = [
            cite
            for cite in item.citations
            if sources.get(cite.source_ref, {}).get("document_ref") == item.document_ref
            and cite.quote in sources[cite.source_ref]["text"]
        ]
        periods = []
        for period in item.covered_periods:
            period_quote = "\n".join(
                cite.quote for cite in citations if cite.source_ref in period.source_refs
            )
            cited_day = _meeting_event_date_cited if meeting_notes else _cited_day
            if cited_day(date.fromisoformat(period.period_start), period_quote) and cited_day(
                date.fromisoformat(period.period_end), period_quote
            ):
                periods.append(period)
        if meeting_notes:
            document_sources = [
                (source_ref, source["text"])
                for source_ref, source in sources.items()
                if source.get("document_ref") == item.document_ref
                and isinstance(source.get("text"), str)
                and source.get("truncated") is not True
                and source.get("evidence_kind") != "versioned_document_facts"
                and source.get("source_version", item.source_version) == item.source_version
            ]
            citations = _recover_meeting_citations(
                item, citations, document_sources, required_entities
            )
        joined = "\n".join(cite.quote for cite in citations)
        supported = (
            bool(citations)
            and bool(joined.strip())
            and bool(item.record_type_claim and item.record_type_claim.strip())
            and (
                _meeting_note_type_cited(item.record_type_claim, joined)
                if meeting_notes
                else _record_type_cited(
                    item.record_type_claim, joined, institutional_statement=institutional
                )
            )
            and (
                not item.entity_claim
                or any(_entity_cited(item.entity_claim, cite.quote) for cite in citations)
            )
            and all(
                any(_entity_cited(entity, cite.quote) for cite in citations)
                for entity in required_entities
            )
            and (
                item.period_role == "statement_coverage"
                if institutional
                else item.period_role == "event_date"
                if meeting_notes
                else item.period_role != "unknown"
            )
            and item.confidence >= 80
            and item.weightage_out_of_10 is not None
            and bool(periods)
            and (
                start is None
                or any(
                    date.fromisoformat(period.period_start) <= end
                    and date.fromisoformat(period.period_end) >= start
                    for period in periods
                )
            )
        )
        checked.append(
            item.model_copy(update={"citations": citations})
            if supported
            else item.model_copy(
                update={
                    "decision": "uncertain",
                    "confidence": 0,
                    "reason": "The cited content does not verify the requested record and period.",
                    "covered_periods": [],
                }
            )
        )
    return BoundDocumentBatchAssessment(documents=checked)


def verify_v1_package(
    assessment: PackageAssessment, *, request: dict, documents: list[BoundDocumentAssessment]
) -> PackageAssessment:
    """A ready V1 selection must have gap-free cited content coverage."""
    if assessment.decision != "ready":
        return assessment
    if assessment.confidence < 80:
        return assessment.model_copy(
            update={
                "decision": "partial",
                "coverage_status": "partial",
                "gaps": ["The evidence assessment is below the V1 readiness threshold."],
            }
        )
    # The model may rank a subset highly, but ranking cannot silently turn an
    # exhaustive request into a partial delivery. Explicit result limits are
    # permitted only when the requester did not ask for every matching file.
    explicit_limit = request.get("resultLimit")
    purpose = request.get("purpose", "")
    exhaustive = (
        type(explicit_limit) is not int
        or not 1 <= explicit_limit <= 1000
        or bool(re.search(r"\b(?:all|every)\b", purpose, re.I))
    )
    included = {item.document_ref for item in documents if item.decision == "include"}
    selected = set(assessment.selected_document_refs)
    if exhaustive and selected != included:
        return assessment.model_copy(
            update={
                "decision": "partial",
                "coverage_status": "partial",
                "gaps": ["Additional verified matching documents were not selected."],
            }
        )
    if request.get("semanticIntent") != "institutional_statement":
        return assessment
    try:
        requested_start = date.fromisoformat(request["periodStart"])
        requested_end = date.fromisoformat(request["periodEnd"])
    except (KeyError, TypeError, ValueError):
        return assessment.model_copy(
            update={
                "decision": "partial",
                "coverage_status": "partial",
                "gaps": ["The requested period could not be verified."],
            }
        )
    spans = sorted(
        (date.fromisoformat(period.period_start), date.fromisoformat(period.period_end))
        for document in documents
        if document.document_ref in selected and document.decision == "include"
        for period in document.covered_periods
        if date.fromisoformat(period.period_end) >= requested_start
    )
    covered_through = requested_start - timedelta(days=1)
    for start, end in spans:
        if start > covered_through + timedelta(days=1):
            break
        covered_through = max(covered_through, end)
        if covered_through >= requested_end:
            return assessment
    return assessment.model_copy(
        update={
            "decision": "partial",
            "coverage_status": "partial",
            "gaps": ["The selected documents do not verify the full requested period."],
        }
    )


def _prompt(payload: dict) -> str:
    prompt = json.dumps(payload, ensure_ascii=False)
    if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise ValueError("package assessment input exceeds context budget")
    return prompt


async def _interpret(
    *, prompt, user_id, output_schema, gene_id="agent_documents_suggestions", model=None
):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == gene_id)
    if (
        gene.privacy.plaintext_telemetry
        or gene.runtime.adk_mode != "single_turn"
        or gene.runtime.transport != ["in_process"]
    ):
        raise ValueError("invalid package interpreter")
    agent = build_single_turn_agent(
        gene, output_schema=output_schema, **({"model": model} if model is not None else {})
    )
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


async def interpret_request_document_batch(*, prompt, user_id, model=None, model_binding=None):
    """Use the bounded request-local Documents gene; legacy package modes stay separate."""
    if model is None:
        model = await private_semantic_request_model(user_id=user_id, model_binding=model_binding)
    return await _interpret(
        prompt=prompt,
        user_id=user_id,
        output_schema=DocumentBatchAssessment,
        gene_id="agent_documents_request_assessment",
        model=model,
    )


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


def _request_period(request: dict) -> tuple[date, date] | None:
    if request.get("dateBasis") != "content":
        return None
    first, last = (
        date.fromisoformat(request["periodStart"]),
        date.fromisoformat(request["periodEnd"]),
    )
    if first > last:
        raise ValueError("reversed requested content period")
    return first, last


def validate_request_document_batch(
    result, *, request: dict, retrieved: dict
) -> BoundDocumentBatchAssessment:
    """Preserve exact evidence checks, including requested content-date grounding."""
    period_window = _request_period(request)
    parsed = validate_document_batch(result, retrieved=retrieved)
    if period_window is None:
        return parsed
    first, last = period_window
    for item in parsed.documents:
        if item.decision != "include":
            continue
        if item.period_role == "unknown" or not item.covered_periods:
            raise ValueError("content period is unverified")
        quotes = {citation.source_ref: citation.quote for citation in item.citations}
        for period in item.covered_periods:
            quotation = "\n".join(quotes[ref] for ref in period.source_refs)
            if not all(
                _cited_day(date.fromisoformat(day), quotation)
                for day in (period.period_start, period.period_end)
            ):
                raise ValueError("content period is unverified")
        if not any(
            date.fromisoformat(period.period_start) <= last
            and date.fromisoformat(period.period_end) >= first
            for period in item.covered_periods
        ):
            raise ValueError("content period outside request")
    return parsed


def _model_validation_error(error: BaseException) -> BaseException | None:
    """Only structured-output failures qualify for a model correction."""
    current = error
    seen = set()
    for _ in range(6):
        if id(current) in seen:
            break
        seen.add(id(current))
        if isinstance(current, (ValidationError, json.JSONDecodeError)):
            return current
        current = current.__cause__ or current.__context__
        if current is None:
            break
    return None


async def _require_request_current(require_current):
    if require_current is None:
        return
    try:
        await require_current()
    except Exception as error:
        raise RequestAssessmentAuthorityError("request authority ended") from error


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


async def assess_request_document_batch(
    *,
    request: dict,
    retrieved: dict,
    user_id: str,
    interpreter=interpret_request_document_batch,
    require_current: Callable[[], Awaitable[None]] | None = None,
    model_binding: dict | None = None,
) -> BoundDocumentBatchAssessment:
    """At most one correction or transient retry inside the existing model budget.

    A correction adds only bounded machine feedback to the original request and
    sources. Valid exclusions and uncertainty are complete model judgments.
    """
    if request.get("assessmentMode") not in {None, "generic_request_candidate_v1"}:
        raise ValueError("invalid request assessment mode")
    _sources(retrieved)
    _request_period(request)
    request = {**request, "assessmentMode": "generic_request_candidate_v1"}
    payload = {
        "package_mode": "document_assessment",
        "document_request": request,
        "retrieved_documents": retrieved,
    }
    prompt = _prompt(payload)
    if interpreter is interpret_request_document_batch:
        selected_binding = validate_semantic_model_binding(model_binding)
        model = await private_semantic_request_model(
            user_id=user_id,
            require_current=require_current,
            model_binding=selected_binding,
        )
        interpreter = partial(interpreter, model=model, model_binding=selected_binding)
    # Leave a bounded retry slot if the provider never answers the first request.
    # A local timeout is transport absence, never an assessment decision.
    async with asyncio.timeout(REQUEST_ASSESSMENT_TIMEOUT_SECONDS):
        for attempt in (1, 2):
            await _require_request_current(require_current)
            try:
                if attempt == 1:
                    first_slot = asyncio.timeout(REQUEST_FIRST_ATTEMPT_TIMEOUT_SECONDS)
                    try:
                        async with first_slot:
                            result = await interpreter(prompt=prompt, user_id=user_id)
                    except TimeoutError:
                        if not first_slot.expired():
                            raise
                        # Only our first-call deadline grants a second attempt.
                        # Preserve the exact prompt and the outer 75-second cap.
                        continue
                else:
                    result = await interpreter(prompt=prompt, user_id=user_id)
            except Exception as error:
                if attempt == 2:
                    raise
                invalid = _model_validation_error(error)
                if invalid is None:
                    if not is_retryable_vertex_error(error):
                        raise
                    # Confirmed transient transport failure has no judgment to
                    # correct. Replay the same prompt within the shared budget.
                    await asyncio.sleep(0.5)
                    continue
                feedback = validation_feedback(invalid, schema=DocumentBatchAssessment)
            else:
                await _require_request_current(require_current)
                try:
                    return validate_request_document_batch(
                        result, request=request, retrieved=retrieved
                    )
                except ValueError as error:
                    if attempt == 2:
                        raise
                    feedback = validation_feedback(error, schema=DocumentBatchAssessment)
                    # These are host-owned structural evidence failures only.
                    # Unknown errors and Pydantic values never become prose in
                    # a correction prompt; no model judgment is replaced here.
                    if type(error) is ValueError and len(error.args) == 1:
                        rule = {
                            "assessment must account for every supplied document exactly once": (
                                "all_document_refs_required_once"
                            ),
                            "assessment citation does not match observed content": (
                                "citation_must_match_same_document_source"
                            ),
                            "content period requires same-document cited evidence": (
                                "period_requires_cited_same_document_source"
                            ),
                            "content period is unverified": (
                                "included_coverage_requires_cited_role_and_endpoint_dates"
                            ),
                            "content period outside request": (
                                "included_coverage_requires_requested_overlap"
                            ),
                        }.get(error.args[0] if isinstance(error.args[0], str) else None)
                        if rule:
                            feedback["rule"] = rule
            prompt = _prompt(
                {
                    **payload,
                    "assessment_validation_feedback": feedback,
                }
            )
    raise AssertionError("unreachable")


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
