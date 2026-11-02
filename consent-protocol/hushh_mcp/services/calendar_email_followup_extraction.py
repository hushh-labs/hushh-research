"""Typed, tool-free semantic assessment over every complete-body section."""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Awaitable, Callable, MutableMapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from functools import lru_cache
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator

from hushh_mcp.agents.email.runtime import run_email_gene
from hushh_mcp.services.calendar_email_followup_reader import (
    BodySection,
    CompleteMailMessage,
    CompleteMailReadError,
)
from hushh_mcp.services.calendar_email_followup_relevance import (
    DROP_QUOTED,
    Category,
    MeetingState,
    Relevance,
    Urgency,
    dedupe,
    inside_region,
    quoted_or_signature_regions,
    surfaceable,
)


class FollowupCandidateV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    local_index: int = Field(ge=0, le=20)
    section_index: int = Field(ge=0, le=100)
    kind: Literal["action", "deadline", "meeting"]
    quote_start: int = Field(ge=0, le=32768)
    source_quote: str = Field(min_length=3, max_length=500)
    title: str = Field(min_length=1, max_length=200)
    original_due_wording: str | None = Field(default=None, max_length=160)
    due_date: str | None = None
    due_relation: Literal["before", "on", "by"] | None = None
    proposed_date: str | None = None
    proposed_at: str | None = None
    time_zone: str | None = None
    responsibility: Literal["owner", "other", "unclear"]
    ambiguities: list[Literal["date", "time", "time_zone", "responsibility", "duration"]] = Field(
        default_factory=list, max_length=5
    )
    # The relevance verdict. A missing verdict is "uncertain": an unexplained
    # guess is never shown to the owner as Calendar work.
    relevance: Relevance = "uncertain"
    category: Category | None = None
    requested_by: str | None = Field(default=None, max_length=120)
    evidence_reason: str | None = Field(default=None, max_length=240)
    urgency: Urgency = "none"
    meeting_state: MeetingState = "none"
    # Name of an existing meeting this request is about ("Hushh Growth Sync").
    # Used only to look the meeting up on the owner's Calendar, never stored raw.
    related_meeting_hint: str | None = Field(default=None, max_length=120)

    @field_validator("due_date", "proposed_date")
    @classmethod
    def valid_date(cls, value: str | None) -> str | None:
        if value is not None:
            if len(value) != 10:
                raise ValueError("invalid date")
            date.fromisoformat(value)
        return value

    @field_validator("proposed_at")
    @classmethod
    def valid_instant(cls, value: str | None) -> str | None:
        if value is not None and datetime.fromisoformat(value).tzinfo is None:
            raise ValueError("zoned instant required")
        return value

    @field_validator("time_zone")
    @classmethod
    def valid_time_zone(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ZoneInfo(value)
            except ZoneInfoNotFoundError as exc:
                raise ValueError("unknown time zone") from exc
        return value


class FollowupUpdateV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section_index: int = Field(ge=0, le=100)
    quote_start: int = Field(ge=0, le=32768)
    source_quote: str = Field(min_length=3, max_length=500)
    target_request_id: str = Field(min_length=36, max_length=36)
    outcome: Literal["corrected", "cancelled", "completed"]
    explanation: str = Field(min_length=1, max_length=200)


class FollowupChunkAssessmentV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidates: list[FollowupCandidateV1] = Field(default_factory=list, max_length=20)
    updates: list[FollowupUpdateV1] = Field(default_factory=list, max_length=20)
    overflow: bool = False
    # Audit only: what kind of message this section belongs to. It never
    # promotes a candidate; each candidate carries its own verdict.
    message_relevance: Relevance = "uncertain"


@dataclass(frozen=True)
class ValidatedCandidate:
    evidence_key: str
    message_id: str
    thread_id: str
    body_digest: str
    source_internal_date_ms: int
    kind: Literal["action", "deadline", "meeting"]
    global_quote_start: int
    quote: str
    title: str
    original_due_wording: str | None
    due_date: str | None
    due_relation: str | None
    proposed_date: str | None
    proposed_at: str | None
    time_zone: str | None
    responsibility: str
    ambiguities: tuple[str, ...]
    # Defaults keep sealed checkpoints written by an earlier release loadable.
    category: str | None = None
    urgency: str = "none"
    meeting_state: str = "none"
    evidence_reason: str | None = None
    requested_by: str | None = None
    related_meeting_hint: str | None = None
    # (calendar event id, title, start) set by Calendar reconciliation only.
    linked_event: tuple[str, str, str] | None = None


@dataclass(frozen=True)
class ValidatedUpdate:
    target_request_id: str
    outcome: Literal["corrected", "cancelled", "completed"]
    quote: str
    explanation: str
    source_internal_date_ms: int


@dataclass(frozen=True)
class CompleteAssessment:
    expected_sections: int
    completed_sections: int
    candidates: tuple[ValidatedCandidate, ...]
    updates: tuple[ValidatedUpdate, ...]
    # Value-free counts of what was withheld and why; never message content.
    dropped_counts: dict[str, int] = field(default_factory=dict)


def _verified_span(section: BodySection, quote_start: int, quote: str) -> int:
    end = quote_start + len(quote)
    if end > len(section.text) or section.text[quote_start:end] != quote:
        raise ValueError("unsupported_source_quote")
    return section.start + quote_start


@lru_cache(maxsize=16)
def _regions(body: str) -> tuple[tuple[int, int], ...]:
    return quoted_or_signature_regions(body)


def _count(drops: MutableMapping[str, int] | None, reason: str) -> None:
    if drops is not None:
        drops[reason] = drops.get(reason, 0) + 1


def _evidence_identity(
    message: CompleteMailMessage, item: Any, offset: int, evidence_key: bytes
) -> str:
    """Stable, value-free identity of one quoted request within its message."""
    discriminator = "\x1f".join(
        [
            message.message_id,
            str(offset),
            item.kind,
            item.source_quote,
            item.title.strip().casefold(),
        ]
    )
    return hmac.new(evidence_key, discriminator.encode(), hashlib.sha256).hexdigest()


def _validated_candidate(
    message: CompleteMailMessage, item: Any, offset: int, identity: str
) -> ValidatedCandidate:
    return ValidatedCandidate(
        evidence_key=identity,
        message_id=message.message_id,
        thread_id=message.thread_id,
        body_digest=message.body_digest,
        source_internal_date_ms=message.internal_date_ms,
        kind=item.kind,
        global_quote_start=offset,
        quote=item.source_quote,
        title=item.title,
        original_due_wording=item.original_due_wording,
        due_date=item.due_date,
        due_relation=item.due_relation,
        proposed_date=item.proposed_date,
        proposed_at=item.proposed_at,
        time_zone=item.time_zone,
        responsibility=item.responsibility,
        ambiguities=tuple(item.ambiguities),
        category=item.category,
        urgency=item.urgency,
        meeting_state=item.meeting_state,
        evidence_reason=item.evidence_reason,
        requested_by=item.requested_by,
        related_meeting_hint=item.related_meeting_hint,
    )


def validate_chunk(
    *,
    message: CompleteMailMessage,
    section: BodySection,
    payload: dict[str, Any],
    prior_request_ids: set[str],
    evidence_key: bytes,
    drops: MutableMapping[str, int] | None = None,
) -> tuple[list[ValidatedCandidate], list[ValidatedUpdate]]:
    """Admit only explicit, evidenced, Calendar-relevant, source-verified requests.

    Withheld candidates are counted by reason in ``drops`` and never persisted.
    The relevance gate runs before quote verification: a non-actionable item is
    discarded whether or not its quote is exact, so a sloppy offset on a
    security notice cannot fail the section and stall the scan.
    """
    assessment = FollowupChunkAssessmentV1.model_validate(payload)
    if assessment.overflow or len(assessment.candidates) == 20 or len(assessment.updates) == 20:
        raise CompleteMailReadError("assessment_overflow")
    candidates: list[ValidatedCandidate] = []
    updates: list[ValidatedUpdate] = []
    local_indices: set[int] = set()
    evidence_keys: set[str] = set()
    regions = _regions(message.body)
    for item in assessment.candidates:
        if item.section_index != section.index or item.local_index in local_indices:
            raise ValueError("invalid_candidate_identity")
        local_indices.add(item.local_index)
        reason = surfaceable(
            relevance=item.relevance,
            category=item.category,
            responsibility=item.responsibility,
            evidence_reason=item.evidence_reason,
        )
        if reason:
            _count(drops, reason)
            continue
        offset = _verified_span(section, item.quote_start, item.source_quote)
        if inside_region(offset, offset + len(item.source_quote), regions):
            _count(drops, DROP_QUOTED)
            continue
        identity = _evidence_identity(message, item, offset, evidence_key)
        if identity in evidence_keys:
            raise ValueError("ambiguous_duplicate_evidence")
        evidence_keys.add(identity)
        candidates.append(_validated_candidate(message, item, offset, identity))
    for update in assessment.updates:
        if (
            update.section_index != section.index
            or update.target_request_id not in prior_request_ids
        ):
            raise ValueError("unsupported_update_ref")
        _verified_span(section, update.quote_start, update.source_quote)
        updates.append(
            ValidatedUpdate(
                target_request_id=update.target_request_id,
                outcome=update.outcome,
                quote=update.source_quote,
                explanation=update.explanation,
                source_internal_date_ms=message.internal_date_ms,
            )
        )
    return candidates, updates


def finalize_candidates(
    candidates: Sequence[ValidatedCandidate], drops: MutableMapping[str, int] | None = None
) -> tuple[ValidatedCandidate, ...]:
    """Collapse repeated phrasings of one request across every section."""
    unique: dict[str, ValidatedCandidate] = {}
    for item in candidates:
        existing = unique.get(item.evidence_key)
        if existing is not None and existing != item:
            raise ValueError("ambiguous_overlapping_evidence")
        unique[item.evidence_key] = item
    kept, merged = dedupe(unique.values())
    for _ in range(merged):
        _count(drops, "duplicate")
    return tuple(kept)


def merge_sections(
    sections: Sequence[tuple[list[ValidatedCandidate], list[ValidatedUpdate]]],
    drops: MutableMapping[str, int] | None = None,
) -> CompleteAssessment:
    updates: dict[tuple[str, str, str], ValidatedUpdate] = {}
    found: list[ValidatedCandidate] = []
    for candidates, changed in sections:
        found.extend(candidates)
        for item in changed:
            updates[(item.target_request_id, item.outcome, item.quote)] = item
    counts: dict[str, int] = dict(drops or {})
    return CompleteAssessment(
        expected_sections=len(sections),
        completed_sections=len(sections),
        candidates=finalize_candidates(found, counts),
        updates=tuple(updates.values()),
        dropped_counts=counts,
    )


async def assess_complete_message(
    *,
    message: CompleteMailMessage,
    user_id: str,
    consent_token: str,
    owner_time_zone: str,
    prior_requests: Sequence[dict[str, str]],
    evidence_key: bytes,
    require_current: Callable[[], Awaitable[None]],
    gene_runner: Callable[..., Awaitable[dict[str, Any]]] = run_email_gene,
) -> CompleteAssessment:
    """All sections must succeed; no partial answer may become durable truth."""
    validated = []
    drops: dict[str, int] = {}
    for section in message.sections:
        validated.append(
            await assess_section(
                message=message,
                section=section,
                user_id=user_id,
                consent_token=consent_token,
                owner_time_zone=owner_time_zone,
                prior_requests=prior_requests,
                evidence_key=evidence_key,
                require_current=require_current,
                gene_runner=gene_runner,
                drops=drops,
            )
        )
    return merge_sections(validated, drops)


async def assess_section(
    *,
    message: CompleteMailMessage,
    section: BodySection,
    user_id: str,
    consent_token: str,
    owner_time_zone: str,
    prior_requests: Sequence[dict[str, str]],
    evidence_key: bytes,
    require_current: Callable[[], Awaitable[None]],
    gene_runner: Callable[..., Awaitable[dict[str, Any]]] = run_email_gene,
    drops: MutableMapping[str, int] | None = None,
) -> tuple[list[ValidatedCandidate], list[ValidatedUpdate]]:
    await require_current()
    prompt = json.dumps(
        {
            "section_index": section.index,
            "section_text": section.text,
            "message_received_at_ms": message.internal_date_ms,
            "subject": message.subject,
            "sender": message.sender,
            "automated_signals": list(message.signals),
            "owner_time_zone": owner_time_zone,
            "prior_requests": list(prior_requests)[:20],
        },
        ensure_ascii=False,
    )
    payload = await gene_runner(
        gene_id="agent_email_followup_extractor",
        prompt=prompt,
        user_id=user_id,
        consent_token=consent_token,
        output_schema=FollowupChunkAssessmentV1,
        timeout_seconds=30,
    )
    await require_current()
    return validate_chunk(
        message=message,
        section=section,
        payload=payload,
        prior_request_ids={item["request_id"] for item in prior_requests},
        evidence_key=evidence_key,
        drops=drops,
    )
