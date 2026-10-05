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
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.agents.email.runtime import run_email_gene
from hushh_mcp.services.gmail_metadata_reader import (
    MAX_ANALYSIS_MESSAGES,
    MAX_BODY_MESSAGES,
    GmailMetadataError,
    GmailMetadataReader,
    MailOperation,
    RequireAccess,
)
from hushh_mcp.services.gmail_personal_information_request_service import (
    SensitiveRequestAssessment,
    get_personal_gmail_information_request_service,
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
        "analyze_mail",
        "clarify",
    ]
    query: str = Field(default="", max_length=512)
    # Omitted means the operation's default: ten listed, one message read.
    limit: int | None = Field(default=None, ge=1, le=25)
    mailbox: Literal["inbox", "sent", "anywhere"] = "inbox"
    clarification: str = Field(default="", max_length=500)
    categories: list[AnalysisCategory] = Field(default_factory=list, max_length=3)


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
    try:
        return ZoneInfo(name or "UTC")
    except (ValueError, ZoneInfoNotFoundError, OSError):
        # OSError is what ZoneInfo raises for an over-long or unusable name.
        # A bad zone degrades to UTC; it never breaks the read.
        return ZoneInfo("UTC")


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
    stage = "planning"
    analysis_categories: tuple[AnalysisCategory, ...] = ()
    try:
        async with asyncio.timeout(105):
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
                                {"user_request": message, **time_context}, ensure_ascii=False
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
            operation: MailOperation = plan.operation
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
            arguments: dict[str, Any] = {"mailbox": plan.mailbox}
            if message_ids:
                operation = "read_message_by_id"
                arguments["message_ids"] = list(message_ids)
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
                expect_account=expect_account,
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
                coverage["plan_source"] = "planner"
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
                            "mailbox": plan.mailbox,
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
            coverage["plan_source"] = "offer" if message_ids else "planner"
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
                        "mailbox": plan.mailbox,
                    }
                    if offered_ids
                    else None
                ),
            )
    except GmailMetadataError as exc:
        return _result(
            conversation_id,
            _ERRORS.get(exc.code, "Mail is temporarily unavailable. Please try again."),
            exc.code if exc.code in _ERRORS else "unavailable",
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
