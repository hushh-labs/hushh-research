"""One's tool-free period assessment, bound to authenticated current-turn evidence.

The host checks provenance and calendar contracts. Date meaning belongs to the
manifest-owned gene; no language, institution, or numeric-year heuristic routes
the request. This helper cannot read files, send requests, or grant access.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

GENE_ID = "one_document_period"
TIMEOUT_SECONDS = 12
MAX_INPUT_BYTES = 128 * 1024
MissingDimension = Literal[
    "year",
    "day_month_order",
    "requested_period",
    "owner_timezone",
    "relative_anchor",
    "relative_window",
]


class PeriodSourceSpan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: Literal["current", "pending"] = "current"
    message_index: int = Field(ge=0, le=16)
    start: int = Field(ge=0)
    end: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=4096)


class PeriodSourceReference(BaseModel):
    """Model-cited text; character locations are derived by exact host lookup."""

    model_config = ConfigDict(extra="forbid", strict=True)
    source: Literal["current", "pending"] = "current"
    message_index: int = Field(ge=0, le=16)
    quote: str = Field(min_length=1, max_length=4096)


class PendingPeriodContext(BaseModel):
    """Host-admitted previous request, never general conversation history."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    original_user_texts: list[str] = Field(min_length=1, max_length=17)
    asked_missing_dimension: MissingDimension

    @model_validator(mode="after")
    def bounded_texts(self):
        if any(not text.strip() or len(text) > 4096 for text in self.original_user_texts):
            raise ValueError("invalid pending document request text")
        return self


class _DocumentPeriodMeaning(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    decision: Literal["supported", "clarify"]
    basis: Literal["absolute", "relative"] | None
    period_start: str | None = Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    period_end: str | None = Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    missing_dimension: MissingDimension | None

    @model_validator(mode="after")
    def coherent_decision(self):
        if self.decision == "supported":
            if self.basis is None or self.missing_dimension is not None:
                raise ValueError("supported period needs a basis and no missing dimension")
            start, end = _calendar_date(self.period_start), _calendar_date(self.period_end)
            if start > end:
                raise ValueError("reversed period")
        elif (
            self.period_start is not None
            or self.period_end is not None
            or self.missing_dimension is None
        ):
            raise ValueError("clarification cannot assert period bounds")
        return self


class DocumentPeriodAssessment(_DocumentPeriodMeaning):
    """Validated internal evidence, including host-located character spans."""

    source_spans: list[PeriodSourceSpan] = Field(min_length=1, max_length=8)


class DocumentPeriodAssessmentOutput(_DocumentPeriodMeaning):
    """Wire contract leaves dates to the model and text location to the host."""

    source_refs: list[PeriodSourceReference] = Field(min_length=1, max_length=8)


class HostClockReceipt(BaseModel):
    """Construct only from this invocation's actual host get_current_time result."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    invocation_id: str = Field(min_length=1)
    user_texts_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: Literal["ok"]
    date: str
    time_zone: str
    time_zone_source: Literal["owner", "request", "utc_fallback"]
    user_time_zone_quote: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def valid_clock(self):
        _calendar_date(self.date)
        try:
            ZoneInfo(self.time_zone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("clock requires a valid IANA timezone") from error
        if self.time_zone_source == "request":
            if self.user_time_zone_quote != self.time_zone:
                raise ValueError("requested clock requires exact timezone evidence")
        elif self.user_time_zone_quote is not None:
            raise ValueError("only a requested timezone may carry request evidence")
        return self


@dataclass(frozen=True)
class DocumentPeriodResult:
    status: Literal[
        "supported",
        "clarify",
        "clock_required",
        "timezone_required",
        "candidate_mismatch",
        "timeout",
        "unavailable",
        "invalid_response",
        "invalid_input",
    ]
    assessment: DocumentPeriodAssessment | None = None
    reason: str | None = None


class PeriodClockAuthorityRequired(ValueError):
    """A model-declared relative period lacks the required host clock authority."""

    def __init__(
        self,
        status: Literal["clock_required", "timezone_required"],
        assessment: DocumentPeriodAssessment,
    ) -> None:
        super().__init__(status)
        self.status = status
        self.assessment = assessment


def _calendar_date(value: str | None) -> date:
    if not isinstance(value, str):
        raise ValueError("calendar date required")
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("calendar date must use YYYY-MM-DD")
    return parsed


def user_texts_sha256(current_user_texts: Sequence[str]) -> str:
    """Bind a host receipt to the exact ordered authenticated input collection."""
    encoded = json.dumps(
        list(current_user_texts), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _clock_matches_current_text(
    receipt: HostClockReceipt, texts: Sequence[str], invocation_id: str
) -> bool:
    return (
        receipt.invocation_id == invocation_id
        and receipt.user_texts_sha256 == user_texts_sha256(texts)
        and (
            receipt.time_zone_source != "request"
            or (
                isinstance(receipt.user_time_zone_quote, str)
                and any(receipt.user_time_zone_quote in text for text in texts)
            )
        )
    )


def validate_period_assessment(
    value: object,
    *,
    current_user_texts: Sequence[str],
    invocation_id: str,
    clock_receipt: HostClockReceipt | None = None,
    pending_context: PendingPeriodContext | None = None,
) -> DocumentPeriodAssessment:
    """Validate structure and provenance without reinterpreting natural language."""
    parsed = DocumentPeriodAssessment.model_validate(value)
    for span in parsed.source_spans:
        texts = (
            current_user_texts
            if span.source == "current"
            else pending_context.original_user_texts
            if pending_context is not None
            else ()
        )
        if (
            span.message_index >= len(texts)
            or span.end <= span.start
            or span.end > len(texts[span.message_index])
            or texts[span.message_index][span.start : span.end] != span.quote
            or not span.quote.strip()
        ):
            raise ValueError("assessment source span does not match admitted user text")
    if parsed.decision == "supported" and not any(
        span.source == "current" for span in parsed.source_spans
    ):
        raise ValueError("supported continuation requires current-message evidence")
    if parsed.decision == "supported" and parsed.basis == "relative":
        if clock_receipt is None:
            raise PeriodClockAuthorityRequired("clock_required", parsed)
        if not _clock_matches_current_text(clock_receipt, current_user_texts, invocation_id):
            raise ValueError("relative period requires this owner's current trusted clock")
        if clock_receipt.time_zone_source == "utc_fallback":
            raise PeriodClockAuthorityRequired("timezone_required", parsed)
    return parsed


def locate_period_assessment(
    value: object,
    *,
    current_user_texts: Sequence[str],
    pending_context: PendingPeriodContext | None = None,
) -> DocumentPeriodAssessment:
    """Locate exact cited text without inferring or rewriting semantic fields."""
    parsed = DocumentPeriodAssessmentOutput.model_validate(value)
    spans = []
    for reference in parsed.source_refs:
        texts = (
            current_user_texts
            if reference.source == "current"
            else pending_context.original_user_texts
            if pending_context is not None
            else ()
        )
        if reference.message_index >= len(texts) or not reference.quote.strip():
            raise ValueError("assessment quote has no admitted source")
        text = texts[reference.message_index]
        start = text.find(reference.quote)
        if start < 0 or text.find(reference.quote, start + 1) >= 0:
            raise ValueError("assessment quote is absent or ambiguous in its source")
        spans.append(
            PeriodSourceSpan(
                source=reference.source,
                message_index=reference.message_index,
                start=start,
                end=start + len(reference.quote),
                quote=reference.quote,
            )
        )
    return DocumentPeriodAssessment(
        **parsed.model_dump(exclude={"source_refs"}), source_spans=spans
    )


def _timeout(error: BaseException) -> bool:
    seen: set[int] = set()
    while id(error) not in seen:
        if isinstance(error, TimeoutError):
            return True
        seen.add(id(error))
        if error.__cause__ is None:
            return False
        error = error.__cause__
    return False


async def assess_document_period(
    *,
    current_user_texts: Sequence[str],
    user_id: str,
    consent_token: str,
    invocation_id: str,
    clock_receipt: HostClockReceipt | None = None,
    pending_context: PendingPeriodContext | None = None,
    candidate_start: str | None = None,
    candidate_end: str | None = None,
) -> DocumentPeriodResult:
    """Assess once, then compare an optional candidate without silently changing it.

    Callers supply only authenticated current/queued messages and a host-created
    clock receipt. Only a host-admitted pending clarification may carry prior
    request text; general history, documents and other tool output are excluded.
    Operational failures are never ambiguity.
    """
    if (
        isinstance(current_user_texts, (str, bytes))
        or not 1 <= len(current_user_texts) <= 17
        or any(not isinstance(text, str) or not text.strip() for text in current_user_texts)
        or not user_id
        or not invocation_id
        or (candidate_start is None) != (candidate_end is None)
    ):
        return DocumentPeriodResult("invalid_input", reason="invalid_current_turn_input")
    if clock_receipt is not None and not _clock_matches_current_text(
        clock_receipt, current_user_texts, invocation_id
    ):
        return DocumentPeriodResult("invalid_input", reason="clock_binding_mismatch")
    prompt = json.dumps(
        {
            "current_user_messages": [
                {"message_index": index, "text": text, "character_count": len(text)}
                for index, text in enumerate(current_user_texts)
            ],
            "host_clock": (
                clock_receipt.model_dump(
                    exclude={"user_texts_sha256", "invocation_id"}, exclude_none=True
                )
                if clock_receipt is not None
                else None
            ),
            "pending_clarification": (
                {
                    "asked_missing_dimension": pending_context.asked_missing_dimension,
                    "original_user_messages": [
                        {"message_index": index, "text": text, "character_count": len(text)}
                        for index, text in enumerate(pending_context.original_user_texts)
                    ],
                }
                if pending_context is not None
                else None
            ),
        },
        ensure_ascii=False,
    )
    if len(prompt.encode("utf-8")) > MAX_INPUT_BYTES:
        return DocumentPeriodResult("invalid_input", reason="input_budget_exceeded")
    try:
        manifest = ManifestLoader.load(
            str(Path(__file__).resolve().parents[1] / "agents/one/agent.yaml")
        )
        gene = next(child for child in manifest.subagents if child.id == GENE_ID)
        if (
            gene.privacy.plaintext_telemetry
            or gene.runtime.adk_mode != "single_turn"
            or gene.runtime.transport != ["in_process"]
        ):
            raise ValueError("invalid period assessment gene")
        agent = build_single_turn_agent(gene, output_schema=DocumentPeriodAssessmentOutput)
    except Exception:
        return DocumentPeriodResult("unavailable", reason="assessment_not_available")
    try:
        value = await run_single_turn(
            agent,
            prompt_parts=prompt,
            user_id=user_id,
            consent_token=consent_token,
            timeout_seconds=TIMEOUT_SECONDS,
        )
        located = locate_period_assessment(
            value, current_user_texts=current_user_texts, pending_context=pending_context
        )
        parsed = validate_period_assessment(
            located,
            current_user_texts=current_user_texts,
            invocation_id=invocation_id,
            clock_receipt=clock_receipt,
            pending_context=pending_context,
        )
    except Exception as error:
        if isinstance(error, PeriodClockAuthorityRequired):
            return DocumentPeriodResult(error.status, error.assessment, "relative_clock_authority")
        if _timeout(error):
            return DocumentPeriodResult("timeout", reason="assessment_timed_out")
        if isinstance(error, ValueError):
            return DocumentPeriodResult("invalid_response", reason="invalid_assessment_evidence")
        return DocumentPeriodResult("unavailable", reason="assessment_not_available")
    if (
        parsed.decision == "supported"
        and candidate_start is not None
        and (parsed.period_start != candidate_start or parsed.period_end != candidate_end)
    ):
        return DocumentPeriodResult("candidate_mismatch", parsed, "candidate_does_not_match")
    return DocumentPeriodResult(parsed.decision, parsed)
