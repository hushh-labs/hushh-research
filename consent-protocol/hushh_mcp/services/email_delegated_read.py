"""Nonpersisting, two-stage Mail read orchestration for One's conversation.

The planner sees only the person's request. A separate tool-less interpreter
sees the bounded metadata, or bounded message text when the person asked to
read mail. No model that has read external content may select another
operation in this hop. The existing Email/ADK genes own all semantics.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from datetime import timezone as datetime_timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from hushh_mcp.agents.email.runtime import run_email_gene
from hushh_mcp.services.gmail_metadata_reader import (
    MAX_ANALYSIS_MESSAGES,
    MAX_BODY_MESSAGES,
    GmailMetadataError,
    GmailMetadataReader,
    RequireAccess,
)
from hushh_mcp.services.gmail_personal_information_request_service import (
    SensitiveRequestAssessment,
    get_personal_gmail_information_request_service,
)
from hushh_mcp.services.owner_time import owner_zone
from hushh_mcp.services.receipt_memory_read import (
    OPEN_RECEIPTS_ACTION_ID,
    ReceiptIdentifierKind,
    ReceiptPlanError,
    ReceiptPlanFields,
    ReceiptStatus,
    read_receipt_memory,
)

logger = logging.getLogger(__name__)


class MailLatencySpan:
    """Lets a caller report a stage that returned normally but did not succeed
    (an unknown send outcome, an analysis that failed in some categories)."""

    __slots__ = ("status",)

    def __init__(self) -> None:
        self.status = "ok"


@contextmanager
def mail_latency(stage: str, log: logging.Logger | None = None) -> Iterator[MailLatencySpan]:
    """Log how long one Mail stage took, with bounded metadata only.

    ``stage`` and the status are short authored enums. Nothing from the
    request, the mailbox or a provider error is ever formatted into the line,
    and every token stays under the log redactor's 24-character threshold.
    A block that returns normally logs ``ok`` unless it set ``span.status``.
    """

    started = time.monotonic()
    outcome = "failed"
    span = MailLatencySpan()
    try:
        yield span
        outcome = span.status if 0 < len(span.status) < 24 else "ok"
    except TimeoutError:
        outcome = "timeout"
        raise
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except GmailMetadataError as exc:
        outcome = exc.code if len(exc.code) < 24 else "refused"
        raise
    finally:
        (log or logger).info(
            "one_voice.mail.latency stage=%s ms=%d status=%s",
            stage,
            int((time.monotonic() - started) * 1000),
            outcome,
        )


AnalysisCategory = Literal["personal_info", "action_items", "meetings"]
_ANALYSIS_CATEGORIES = ("personal_info", "action_items", "meetings")
_CATEGORY_TITLES = {
    "personal_info": "personal-information request",
    "action_items": "action item",
    "meetings": "meeting",
}


class MailReadPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: Literal[
        "list_needs_reply",
        "list_recent",
        "search_inbox",
        "read_message",
        "read_thread",
        "read_offered",
        "analyze_mail",
        "read_receipts",
        "clarify",
    ]
    query: str = Field(default="", max_length=512)
    # Omitted means the operation's default: ten listed, one message read.
    limit: int | None = Field(default=None, ge=1, le=25)
    mailbox: Literal["inbox", "sent", "anywhere"] = "inbox"
    clarification: str = Field(default="", max_length=500)
    categories: list[AnalysisCategory] = Field(default_factory=list, max_length=3)
    # Only for read_receipts: the window and filters the planner chose from the
    # person's own words, answered from their saved receipt memory and never
    # from the inbox. Flat scalars and one array of enums on purpose; nested
    # objects in a structured-output schema are what Vertex rejected for
    # ``MailItemGist``. An empty value means "no such restriction".
    receipt_since: str = Field(default="", max_length=10)
    receipt_until: str = Field(default="", max_length=10)
    receipt_statuses: list[ReceiptStatus] = Field(default_factory=list, max_length=4)
    receipt_identifier_kinds: list[ReceiptIdentifierKind] = Field(
        default_factory=list, max_length=4
    )
    receipt_merchant: str = Field(default="", max_length=80)
    receipt_window_label: str = Field(default="", max_length=60)
    # "Show more" / "next" / "older": continue the receipts list just shown.
    receipt_more: bool = False

    def receipt_fields(self) -> ReceiptPlanFields:
        return ReceiptPlanFields(
            since=self.receipt_since,
            until=self.receipt_until,
            statuses=tuple(self.receipt_statuses),
            identifier_kinds=tuple(self.receipt_identifier_kinds),
            merchant=self.receipt_merchant,
            window_label=self.receipt_window_label,
            more=self.receipt_more,
        )

    @property
    def has_receipt_fields(self) -> bool:
        fields = self.receipt_fields()
        return fields.more or fields.has_filters or bool(fields.window_label)

    # The model must explicitly distinguish "newest" from a reference to the
    # last shown list. An absent anchor never silently becomes the newest mail.
    target_origin: Literal["newest", "offered"] | None = None
    ordinal: int | None = Field(default=None, ge=1, le=25)


class MailReadOffer(BaseModel):
    """Private, short-lived exact selection carried by One's encrypted session."""

    model_config = ConfigDict(extra="forbid", strict=True)
    owner_id: str = Field(min_length=1, max_length=256)
    conversation_id: str = Field(min_length=1, max_length=256)
    account: str = Field(min_length=1, max_length=256)
    mailbox: Literal["inbox", "sent", "anywhere"]
    message_ids: list[str] = Field(min_length=1, max_length=25)
    created_at_ms: int = Field(ge=1)
    selected_ordinal: int | None = Field(default=None, ge=1, le=25)

    @field_validator("message_ids")
    @classmethod
    def valid_ids(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values) or any(
            not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value)
            for value in values
        ):
            raise ValueError("invalid_mail_offer_ids")
        return values

    def message_id_at(self, ordinal: int) -> str | None:
        if 1 <= ordinal <= len(self.message_ids):
            return self.message_ids[ordinal - 1]
        if len(self.message_ids) == 1 and ordinal == self.selected_ordinal:
            return self.message_ids[0]
        return None


def current_mail_read_offer(
    raw: Any, *, owner_id: str, conversation_id: str, now_ms: int | None = None
) -> MailReadOffer | None:
    """Reject stale, cross-owner or cross-conversation selections before a read."""

    try:
        offer = MailReadOffer.model_validate(raw)
    except (ValidationError, TypeError, ValueError):
        return None
    now = int(time.time() * 1000) if now_ms is None else now_ms
    if (
        offer.owner_id != owner_id
        or offer.conversation_id != conversation_id
        or now - offer.created_at_ms > 300_000
        or offer.created_at_ms - now > 5_000
    ):
        return None
    return offer


def make_mail_read_offer(raw: Any, *, owner_id: str, conversation_id: str) -> dict[str, Any] | None:
    """Bind only a reader-minted exact offer to the authenticated chat session."""

    if not isinstance(raw, dict):
        return None
    try:
        offer = MailReadOffer.model_validate(
            {
                "owner_id": owner_id,
                "conversation_id": conversation_id,
                "account": raw.get("account"),
                "mailbox": raw.get("mailbox"),
                "message_ids": raw.get("message_ids"),
                "created_at_ms": int(time.time() * 1000),
                "selected_ordinal": raw.get("selected_ordinal"),
            }
        )
    except (ValidationError, TypeError, ValueError):
        return None
    return offer.model_dump(mode="json")


class MailAnalysisFinding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    category: Literal["action_items", "meetings"]
    source_ref: str = Field(pattern=r"^mail:(?:[1-9]|1[0-9]|2[0-5])$")
    # A later message in the same retrieved thread can resolve or cancel an
    # earlier one. The analyzer cites every message it used for that conclusion.
    update_refs: list[str] = Field(default_factory=list, max_length=12)
    detail: str = Field(min_length=1, max_length=280)
    state: Literal["active", "completed", "cancelled", "rescheduled", "unclear"]
    due_at: str | None = Field(default=None, max_length=40)
    event_at: str | None = Field(default=None, max_length=40)


class MailAnalysisAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    findings: list[MailAnalysisFinding] = Field(default_factory=list, max_length=12)


class MailItemGist(BaseModel):
    """What one message is about, for the row that shows it.

    Scalars only. A nested bounded array inside a bounded array is what made
    Vertex answer 400 INVALID_ARGUMENT for the Drive suggestions schema
    (measured 2026-09-25, see ``drive_suggestion_service``), so this object
    stays flat and its bound lives on the list that holds it.
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    source_ref: str = Field(pattern=r"^mail:(?:[1-9]|1[0-9]|2[0-5])$")
    gist: str = Field(min_length=1, max_length=280)


class MailReadAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    answer: str = Field(min_length=1, max_length=4000)
    source_refs: list[str] = Field(default_factory=list, max_length=25)
    # One line per message the person can see, so a row says what it is about
    # instead of only who sent it. Only rows whose text was actually supplied
    # may carry one; see the validation in ``run_delegated_mail_read``.
    item_summaries: list[MailItemGist] = Field(default_factory=list, max_length=25)


_ERRORS = {
    "connect_required": "Connect Mail in Connections to search your inbox.",
    "reconnect_required": "Reconnect Mail in Connections to continue.",
    "connection_changed": "Your Mail connection changed. Please try that request again.",
    "permission_denied": "Mail did not allow that read. Check your connection permissions.",
    "quota_exceeded": "Gmail's daily read limit was reached. Please try again later.",
    "domain_policy": "Your Google Workspace policy does not allow this Mail read.",
    "retryable": "Gmail is temporarily unavailable. Please try again.",
    "source_changed": "The inbox changed during that read. Please try again.",
    "response_too_large": "That inbox result is too large. Try a narrower search.",
    "invalid_argument": (
        "Please ask for your recent emails, an inbox search, messages needing a reply, "
        "or an email or conversation to read."
    ),
}


# Calendar-date terms in a Gmail query ("after:2026/09/21"). Gmail resolves
# these at midnight Pacific time, not the person's, so a "since Monday" read can
# miss or include a day. They are rewritten to epoch seconds at local midnight
# in the person's timezone; epoch terms the planner already wrote pass through.
_DATE_TERM = re.compile(
    r"(?<![\w:])(after|before|newer|older):(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?![\w/-])",
    re.IGNORECASE,
)
_DATE_OPERATOR = {"after": "after", "newer": "after", "before": "before", "older": "before"}


def _owner_zone(name: str) -> ZoneInfo:
    # One owner-zone rule for every surface; see ``owner_time.owner_zone``.
    zone: ZoneInfo = owner_zone(name)
    return zone


def _epoch_date_terms(query: str, zone: ZoneInfo) -> str:
    """Pin each calendar-date term to local midnight as an epoch-second term."""

    def convert(match: re.Match[str]) -> str:
        operator, year, month, day = match.groups()
        try:
            midnight = datetime(int(year), int(month), int(day), tzinfo=zone)
        except ValueError:
            raise GmailMetadataError("invalid_argument") from None
        return f"{_DATE_OPERATOR[operator.lower()]}:{int(midnight.timestamp())}"

    return _DATE_TERM.sub(convert, query)


async def _assess_personal_row(row: dict[str, Any]) -> SensitiveRequestAssessment:
    """Reuse the Email monitor's nonpersisting classifier for an owner read."""
    body = str(row.get("body") or "")
    encoded = base64.urlsafe_b64encode(body.encode("utf-8")).decode("ascii")
    message = {
        "payload": {
            "headers": [{"name": "Subject", "value": str(row.get("subject") or "")}],
            "mimeType": "text/plain",
            "body": {"data": encoded},
        }
    }
    return await get_personal_gmail_information_request_service().assess_without_recording(message)


def _analysis_time(value: str | None) -> bool:
    if value is None:
        return True
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _received_at(row: dict[str, Any]) -> datetime | None:
    value = row.get("received_at")
    if not isinstance(value, str):
        return None
    try:
        received = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return received if received.tzinfo is not None else None


async def _analyze_rows(
    *,
    rows: list[dict[str, Any]],
    categories: list[AnalysisCategory],
    message: str,
    time_context: dict[str, str],
    user_id: str,
    consent_token: str,
    gene_runner: Callable[..., Awaitable[dict[str, Any]]],
    personal_assessor: Callable[[dict[str, Any]], Awaitable[SensitiveRequestAssessment]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Classify one bounded page; category failures remain explicit and separate."""
    if not rows:
        return [], []
    findings: list[dict[str, Any]] = []
    failed: list[str] = []

    async def personal() -> list[dict[str, Any]]:
        semaphore = asyncio.Semaphore(4)

        async def one(row: dict[str, Any]) -> dict[str, Any] | None:
            async with semaphore:
                assessment = await asyncio.wait_for(personal_assessor(row), timeout=25)
            if not assessment.is_information_request:
                return None
            fields = list(assessment.requested_fields[:3])
            detail = (
                "Requests " + ", ".join(fields) + "."
                if fields
                else "Requests personal information."
            )
            return {
                "category": "personal_info",
                "source_ref": row["source_ref"],
                "update_refs": [],
                "detail": detail,
                "state": "active",
                "due_at": None,
                "event_at": None,
            }

        # A failed classifier must not leave sibling calls processing mailbox
        # text after this read has returned (or after access is withdrawn).
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(one(row)) for row in rows]
        return [result for task in tasks if (result := task.result()) is not None]

    async def tasks_and_meetings(category: AnalysisCategory) -> list[dict[str, Any]]:
        parsed = MailAnalysisAnswer.model_validate(
            await gene_runner(
                gene_id="agent_email_read_analyzer",
                prompt=json.dumps(
                    {
                        "user_request": message,
                        "requested_categories": [category],
                        "retrieved_messages": rows,
                        **time_context,
                    },
                    ensure_ascii=False,
                ),
                user_id=user_id,
                consent_token=consent_token,
                output_schema=MailAnalysisAnswer,
                timeout_seconds=25,
            )
        )
        by_ref = {row["source_ref"]: row for row in rows}
        seen: set[tuple[str, str]] = set()
        result: list[dict[str, Any]] = []
        for finding in parsed.findings:
            if finding.category != category or finding.source_ref not in by_ref:
                raise ValueError("invalid_mail_sources")
            if not _analysis_time(finding.due_at) or not _analysis_time(finding.event_at):
                raise ValueError("invalid_mail_analysis_time")
            key = (finding.category, finding.source_ref)
            if key in seen or len(set(finding.update_refs)) != len(finding.update_refs):
                raise ValueError("duplicate_mail_analysis")
            seen.add(key)
            origin_thread = by_ref[finding.source_ref].get("thread_ref")
            origin_received = _received_at(by_ref[finding.source_ref])
            if any(
                ref not in by_ref
                or ref == finding.source_ref
                or not origin_thread
                or by_ref[ref].get("thread_ref") != origin_thread
                or origin_received is None
                or (updated_at := _received_at(by_ref[ref])) is None
                or updated_at <= origin_received
                for ref in finding.update_refs
            ):
                raise ValueError("invalid_mail_update_sources")
            result.append(finding.model_dump())
        return result

    jobs: list[tuple[list[str], Awaitable[list[dict[str, Any]]]]] = []
    if "personal_info" in categories:
        jobs.append((["personal_info"], personal()))
    for category in categories:
        if category != "personal_info":
            jobs.append(([category], tasks_and_meetings(category)))
    outcomes = await asyncio.gather(*(job for _, job in jobs), return_exceptions=True)
    for (owned_categories, _), outcome in zip(jobs, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            failed.extend(owned_categories)
        else:
            findings.extend(outcome)
    return findings, failed


def _result(
    conversation_id: str,
    text: str,
    status: str,
    *,
    sources=(),
    truncated=False,
    metadata_only=True,
    items=(),
    coverage=None,
    offer=None,
    failure_stage: str | None = None,
    analysis_failed: tuple[AnalysisCategory, ...] = (),
) -> dict[str, Any]:
    """The specialist turn, plus what a surface needs to show the person.

    ``structured`` is the shared ``specialist_read.v1`` receipt. It is validated
    by ``SpecialistReadResult`` with ``extra="forbid"`` and parsed on the web by
    ``parseConnectorReadReceipt``, which rejects the whole receipt if it carries
    a key it does not know. So nothing new goes in there.

    ``items`` and ``coverage`` are siblings for that reason. Typed chat ignores
    them -- it renders the answer as the assistant's message and needs only the
    receipt's provenance. One Live Voice has no message body to render into, so
    it needs the rows themselves.

    ``coverage`` is absent, never zeroed, when no read happened. A count of
    nothing and a count nobody took are different facts.
    """
    return {
        "conversationId": conversation_id,
        "response": text,
        "isComplete": True,
        "stateChanged": False,
        "structured": {
            "schema_version": "specialist_read.v1",
            "connector": "mail",
            "status": status,
            "sources": list(sources),
            "truncated": truncated,
            "metadata_only": metadata_only,
        },
        "items": list(items),
        "coverage": dict(coverage) if coverage else None,
        # Which messages the rows are, so a caller can bind "the second one" to
        # the message it named. Absent when the operation cannot name one per
        # row, which makes a later positional request refuse instead of guess.
        "offer": dict(offer) if offer else None,
        "failure_stage": failure_stage,
        # Bounded planner categories, separate from the strict shared receipt.
        # A failed read has no coverage, but One still needs to name the
        # requested analyses it could not complete.
        "analysis_failed": list(analysis_failed),
    }


_RECEIPT_ERRORS = {
    "invalid_argument": (
        "I couldn't turn that into a receipts request. "
        "Try “show my receipts from the last 2 months”."
    ),
    "not_in_this_surface": (
        "I can't read your saved receipts here yet. Ask in chat, or open Receipts in Mail."
    ),
}


def _answer_from_receipt_memory(
    *,
    conversation_id: str,
    plan: MailReadPlan,
    receipt_memory: object | None,
    receipt_cursor: str | None,
    receipt_reads: bool,
    zone: ZoneInfo,
    now: datetime,
) -> dict[str, Any]:
    """Answer a planned receipts question from the saved receipt memory alone.

    This path builds no Gmail reader and so cannot reach ``search_inbox``. The
    planner chose the window and filters; the interpreter is not asked, because
    every value in the answer is copied from the person's saved memory and
    formatted by code, and a model re-writing a number is the failure to avoid.
    That skip is logged, never silent.
    """
    if plan.categories:
        raise GmailMetadataError("invalid_argument")
    if not receipt_reads:
        # One Live Voice has no channel for the saved memory. Refuse plainly
        # instead of falling back to a search of the inbox.
        return _result(
            conversation_id,
            _RECEIPT_ERRORS["not_in_this_surface"],
            "invalid_argument",
            failure_stage="planning",
        )
    try:
        with mail_latency("receipts"):
            outcome = read_receipt_memory(
                index_raw=receipt_memory,
                plan=plan.receipt_fields(),
                cursor_raw=receipt_cursor,
                zone=zone,
                now=now,
            )
    except ReceiptPlanError:
        return _result(
            conversation_id,
            _RECEIPT_ERRORS["invalid_argument"],
            "invalid_argument",
            failure_stage="planning",
        )
    logger.info("one_voice.mail.latency stage=%s ms=%d status=%s", "interpret", 0, "skipped")
    if outcome.drift:
        logger.info("one_voice.mail.receipts drift=%s", ",".join(outcome.drift))
    result = _result(
        conversation_id,
        outcome.text,
        outcome.status,
        truncated=outcome.has_more,
        metadata_only=True,
        coverage=outcome.coverage,
    )
    # Siblings of the strict shared receipt, like ``items`` and ``offer``: the
    # caller persists the list position for "show more" and, when the memory is
    # not ready, proposes the generated Open Receipts action to One.
    result["receipt_cursor"] = {"action": outcome.cursor_action, "value": outcome.cursor}
    if outcome.propose_open_receipts:
        result["directive"] = {
            "type": "receipts_open_proposal",
            "actionId": OPEN_RECEIPTS_ACTION_ID,
            "slots": {},
        }
    return result


async def run_delegated_mail_read(
    *,
    gmail: Any,
    user_id: str,
    consent_token: str,
    conversation_id: str,
    message: str,
    require_access: RequireAccess,
    timezone: str = "UTC",
    message_ids: tuple[str, ...] = (),
    offer_mailbox: str = "inbox",
    expect_account: str = "",
    receipt_memory: object | None = None,
    receipt_cursor: str | None = None,
    receipt_reads: bool = False,
    read_offer: dict[str, Any] | None = None,
    require_explicit_latest: bool = False,
    gene_runner: Callable[..., Awaitable[dict[str, Any]]] = run_email_gene,
    reader_factory: Callable[..., GmailMetadataReader] = GmailMetadataReader,
    personal_assessor: Callable[
        [dict[str, Any]], Awaitable[SensitiveRequestAssessment]
    ] = _assess_personal_row,
    clock: Callable[[], datetime] = lambda: datetime.now(datetime_timezone.utc),
) -> dict[str, Any]:
    # No history, chat store, provider credentials or user IDs enter the model
    # prompt. One already owns the outer conversation and its encrypted answer.
    await require_access()
    if not message.strip() or len(message.encode("utf-8")) > 8000:
        return _result(conversation_id, _ERRORS["invalid_argument"], "input_required")
    zone = _owner_zone(timezone)
    # Relative dates ("this week", "since Monday") need the person's clock.
    time_context = {
        "current_time_utc": clock().astimezone(datetime_timezone.utc).isoformat(),
        "user_timezone": zone.key,
    }
    current_offer = current_mail_read_offer(
        read_offer, owner_id=user_id, conversation_id=conversation_id
    )
    stage = "planning"
    analysis_categories: tuple[AnalysisCategory, ...] = ()
    try:
        async with asyncio.timeout(105):
            read_ids = message_ids
            read_mailbox = offer_mailbox
            read_account = expect_account
            selected_ordinal: int | None = None
            if message_ids:
                # The person named a position in a list this server minted, so
                # there is nothing to plan: the operation and its target are both
                # already decided. The planner is skipped rather than asked and
                # overruled, and `plan_source` records that it was skipped -- an
                # unrecorded skip is indistinguishable from a planned read.
                plan = MailReadPlan(operation="read_message", mailbox=offer_mailbox)
                logger.info("one_voice.mail.latency stage=%s ms=%d status=%s", "plan", 0, "skipped")
            else:
                with mail_latency("plan"):
                    plan = MailReadPlan.model_validate(
                        await gene_runner(
                            gene_id="agent_email_read_planner",
                            prompt=json.dumps(
                                {
                                    "user_request": message,
                                    "offered_message_count": (
                                        len(current_offer.message_ids) if current_offer else 0
                                    ),
                                    **time_context,
                                },
                                ensure_ascii=False,
                            ),
                            user_id=user_id,
                            consent_token=consent_token,
                            output_schema=MailReadPlan,
                            timeout_seconds=20,
                        )
                    )
            await require_access()
            if plan.operation == "clarify":
                return _result(
                    conversation_id,
                    plan.clarification or "What would you like to find in your inbox?",
                    "input_required",
                )
            if plan.operation == "read_receipts":
                # Receipt questions are answered from the saved receipt memory
                # only. There is deliberately no branch from here to the reader.
                if plan.ordinal is not None or plan.target_origin is not None:
                    raise GmailMetadataError("invalid_argument")
                return _answer_from_receipt_memory(
                    conversation_id=conversation_id,
                    plan=plan,
                    receipt_memory=receipt_memory,
                    receipt_cursor=receipt_cursor,
                    receipt_reads=receipt_reads,
                    zone=zone,
                    now=clock(),
                )
            if plan.has_receipt_fields:
                raise GmailMetadataError("invalid_argument")
            operation = plan.operation
            if operation == "read_offered":
                if plan.query.strip() or plan.target_origin == "newest":
                    raise GmailMetadataError("invalid_argument")
                if plan.ordinal is None or current_offer is None:
                    return _result(
                        conversation_id,
                        "Please show me the mail list again, then tell me which message to read.",
                        "input_required",
                    )
                offered_id = current_offer.message_id_at(plan.ordinal)
                if offered_id is None:
                    return _result(
                        conversation_id,
                        f"That list has {len(current_offer.message_ids)} messages. Which one did you mean?",
                        "input_required",
                    )
                read_ids = (offered_id,)
                read_mailbox = current_offer.mailbox
                read_account = current_offer.account
                selected_ordinal = plan.ordinal
                operation = "read_message_by_id"
            elif plan.ordinal is not None or plan.target_origin == "offered":
                # An ordinal on another operation cannot turn into a fresh search.
                raise GmailMetadataError("invalid_argument")
            if operation == "analyze_mail":
                if not plan.categories or len(set(plan.categories)) != len(plan.categories):
                    raise GmailMetadataError("invalid_argument")
                analysis_categories = tuple(plan.categories)
            elif plan.categories:
                raise GmailMetadataError("invalid_argument")
            if operation == "search_inbox" and not plan.query.strip():
                # A search with no criteria is a request for the newest inbox
                # page ("my last 10 emails"). Decided from the plan's shape,
                # never from request words; the reader still refuses an empty
                # search expression.
                operation = "list_recent"
            elif operation in {"list_recent", "list_needs_reply"} and plan.query:
                raise GmailMetadataError("invalid_argument")
            if (
                require_explicit_latest
                and operation == "read_message"
                and not plan.query.strip()
                and plan.target_origin != "newest"
            ):
                return _result(
                    conversation_id,
                    "Do you mean your newest email, or one from the list I showed you?",
                    "input_required",
                )
            arguments: dict[str, Any] = {"mailbox": read_mailbox if read_ids else plan.mailbox}
            if read_ids:
                operation = "read_message_by_id"
                arguments["message_ids"] = list(read_ids)
            elif operation == "read_message":
                # Reading bodies is bounded tighter than listing; a larger plan
                # limit is normalized to that bound, never widened.
                arguments["limit"] = min(plan.limit or 1, MAX_BODY_MESSAGES)
            elif operation == "analyze_mail":
                arguments["limit"] = min(plan.limit or 10, MAX_ANALYSIS_MESSAGES)
            elif operation != "read_thread":
                arguments["limit"] = plan.limit or 10
            if (
                operation in {"search_inbox", "read_message", "read_thread", "analyze_mail"}
                and plan.query
            ):
                arguments["query"] = _epoch_date_terms(plan.query, zone)
            reader = reader_factory(
                gmail=gmail,
                user_id=user_id,
                require_access=require_access,
                # Ids resolved in one mailbox are meaningless in another, so a
                # reconnect to a different Google account refuses the read
                # rather than reading whatever now holds that position.
                expect_account=read_account,
            )
            stage = "retrieval"
            with mail_latency("fetch"):
                metadata = await reader.read(operation, arguments)
                await reader.require_current()
            if operation == "analyze_mail":
                stage = "analysis"
                rows = metadata["untrusted_external_content"]
                readable = [row for row in rows if str(row.get("body") or "").strip()]
                if rows and not readable:
                    return _result(
                        conversation_id,
                        "Mail was fetched, but its message text was unavailable for analysis.",
                        "unavailable",
                        failure_stage="analysis",
                        analysis_failed=analysis_categories,
                    )
                with mail_latency("analyze") as span:
                    findings, failed = await _analyze_rows(
                        rows=readable,
                        categories=plan.categories,
                        message=message,
                        time_context=time_context,
                        user_id=user_id,
                        consent_token=consent_token,
                        gene_runner=gene_runner,
                        personal_assessor=personal_assessor,
                    )
                    if failed:
                        span.status = "failed" if len(failed) == len(plan.categories) else "partial"
                await reader.require_current()
                if len(failed) == len(plan.categories):
                    return _result(
                        conversation_id,
                        "Mail was fetched, but I couldn't complete the requested analysis.",
                        "unavailable",
                        failure_stage="analysis",
                        analysis_failed=analysis_categories,
                    )
                coverage = dict(metadata.get("coverage") or {})
                coverage["assessed"] = len(readable)
                coverage["analysis_unassessable"] = len(rows) - len(readable)
                coverage["plan_source"] = "offer" if read_ids else "planner"
                coverage["analysis_requested"] = list(plan.categories)
                coverage["analysis_failed"] = failed
                for category in _ANALYSIS_CATEGORIES:
                    if category in plan.categories and category not in failed:
                        coverage[f"findings_{category}"] = sum(
                            finding["category"] == category for finding in findings
                        )
                by_ref: dict[str, list[dict[str, Any]]] = {}
                for finding in findings:
                    by_ref.setdefault(finding["source_ref"], []).append(finding)
                items = [{**row, "analysis": by_ref.get(row["source_ref"], [])} for row in rows]
                lines = [f"I checked {len(readable)} Mail messages in this bounded page."]
                for category in plan.categories:
                    title = _CATEGORY_TITLES[category]
                    if category in failed:
                        lines.append(f"I couldn't complete the {title} analysis.")
                        continue
                    matches = [item for item in findings if item["category"] == category]
                    if not matches:
                        lines.append(f"No {title}s found among the messages checked.")
                    else:
                        finding_title = (
                            (
                                "meeting finding in Mail"
                                if len(matches) == 1
                                else "meeting findings in Mail"
                            )
                            if category == "meetings"
                            else title + ("" if len(matches) == 1 else "s")
                        )
                        lines.append(f"{len(matches)} {finding_title} found:")
                        lines.extend(
                            f"• {item['detail']} (email {item['source_ref'].split(':')[1]}; {item['state']})"
                            for item in matches
                        )
                if "meetings" in plan.categories:
                    lines.append("These are findings from Mail, not a check of your Calendar.")
                if coverage.get("matches_beyond_page") or coverage.get("items_omitted"):
                    lines.append("More matching mail may be outside this page.")
                if coverage.get("content_shortened"):
                    lines.append(
                        "Some message text was shortened; open the original for the full text."
                    )
                if coverage["analysis_unassessable"]:
                    lines.append("Some messages had no readable text and were not analyzed.")
                cited = list(
                    dict.fromkeys(
                        ref
                        for item in findings
                        for ref in [item["source_ref"], *item["update_refs"]]
                    )
                )
                coverage["cited"] = len(cited)
                offered_ids = reader.offered_message_ids()
                return _result(
                    conversation_id,
                    "\n\n".join(lines),
                    "ok",
                    sources=[
                        {"source_ref": ref, "label": "Mail", "kind": "message"} for ref in cited
                    ],
                    truncated=metadata["truncated"],
                    metadata_only=False,
                    items=items,
                    coverage=coverage,
                    analysis_failed=tuple(failed),
                    offer=(
                        {
                            "message_ids": list(offered_ids),
                            "account": reader.account,
                            "mailbox": arguments["mailbox"],
                            **({"selected_ordinal": selected_ordinal} if selected_ordinal else {}),
                        }
                        if offered_ids
                        else None
                    ),
                )
            # Coverage is server bookkeeping, not evidence. Handing counts to the
            # interpreter would invite it to author its own totals in prose, and
            # the whole point of computing them here is that prose cannot be
            # trusted with a number. Its prompt stays exactly what it was.
            coverage = dict(metadata.get("coverage") or {})
            evidence = {k: v for k, v in metadata.items() if k != "coverage"}
            stage = "interpretation"
            with mail_latency("interpret"):
                answer = MailReadAnswer.model_validate(
                    await gene_runner(
                        gene_id="agent_email_read_interpreter",
                        prompt=json.dumps(
                            {
                                "user_request": message,
                                "retrieved_metadata": evidence,
                                **time_context,
                            },
                            ensure_ascii=False,
                        ),
                        user_id=user_id,
                        consent_token=consent_token,
                        output_schema=MailReadAnswer,
                        timeout_seconds=20,
                    )
                )
            # A disconnected/superseded grant cannot release an answer prepared
            # while interpretation was running, even when no further tool ran.
            await reader.require_current()
            rows = metadata["untrusted_external_content"]
            known_refs = {item["source_ref"] for item in rows}
            if set(answer.source_refs) - known_refs or (known_refs and not answer.source_refs):
                raise ValueError("invalid_mail_sources")
            # A gist is a claim about what a message says, so it may exist only
            # where the message's text was supplied. Without this a metadata row
            # -- subject and sender and nothing else -- could acquire a summary
            # the model wrote from the subject alone, which reads exactly like a
            # grounded one and is not.
            text_refs = {item["source_ref"] for item in rows if str(item.get("body") or "").strip()}
            gist_refs = [item.source_ref for item in answer.item_summaries]
            if (
                len(gist_refs) != len(set(gist_refs))
                or len(gist_refs) > len(rows)
                or set(gist_refs) - text_refs
            ):
                raise ValueError("invalid_mail_sources")
            kind = "metadata" if metadata["metadata_only"] else "message"
            sources = [
                {"source_ref": ref, "label": "Mail", "kind": kind}
                for ref in dict.fromkeys(answer.source_refs)
            ]
            # How many the interpreter chose to cite is a fact about the
            # interpreter. It is never how many messages were found.
            coverage["cited"] = len(sources)
            coverage["plan_source"] = "offer" if read_ids else "planner"
            coverage["summarized"] = len(gist_refs)
            offered_ids = reader.offered_message_ids()
            # Merged onto the rows the surface already renders, rather than sent
            # as a parallel list the caller would have to join by hand.
            gist_by_ref = {item.source_ref: item.gist for item in answer.item_summaries}
            items = [
                {**row, "gist": gist_by_ref[row["source_ref"]]}
                if row["source_ref"] in gist_by_ref
                else row
                for row in rows
            ]
            text = answer.answer
            if operation == "list_needs_reply":
                text += (
                    "\n\nThese are possible replies based on sender metadata; "
                    "I have not confirmed each needs a response."
                )
            matches_cut = bool(coverage.get("matches_beyond_page") or coverage.get("items_omitted"))
            text_cut = bool(coverage.get("content_shortened"))
            if not coverage.get("operation") and metadata["truncated"]:
                # A reader that reported truncation without saying which kind
                # still reported a limitation. Degrade to the general statement
                # rather than dropping it, which would read as a complete result.
                matches_cut = bool(metadata["metadata_only"])
                text_cut = not metadata["metadata_only"]
            if matches_cut:
                text += "\n\nThis is a bounded inbox result; some matches were left out."
            if text_cut:
                text += (
                    "\n\nSome text was shortened to fit; open the email in Gmail for the "
                    "full version."
                )
            return _result(
                conversation_id,
                text,
                "ok",
                sources=sources,
                truncated=metadata["truncated"],
                metadata_only=metadata["metadata_only"],
                items=items,
                coverage=coverage,
                offer=(
                    {
                        "message_ids": list(offered_ids),
                        "account": reader.account,
                        "mailbox": arguments["mailbox"],
                        **({"selected_ordinal": selected_ordinal} if selected_ordinal else {}),
                    }
                    if offered_ids
                    else None
                ),
            )
    except GmailMetadataError as exc:
        return _result(
            conversation_id,
            _ERRORS.get(exc.code, "Mail is temporarily unavailable. Please try again."),
            (
                exc.code
                if exc.code in _ERRORS
                and exc.code not in {"quota_exceeded", "domain_policy", "retryable"}
                else "unavailable"
            ),
            failure_stage=stage,
            analysis_failed=analysis_categories if stage == "analysis" else (),
        )
    except PermissionError:
        raise
    except Exception:
        # Provider exceptions may contain prompts/headers. Do not log them or
        # let partial metadata masquerade as a successful inbox read.
        return _result(
            conversation_id,
            "Mail is temporarily unavailable. Please try again.",
            "unavailable",
            failure_stage=stage,
            analysis_failed=analysis_categories if stage == "analysis" else (),
        )
