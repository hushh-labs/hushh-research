"""Nonpersisting, two-stage Mail read orchestration for One's conversation.

The planner sees only the person's request. A separate tool-less interpreter
sees the bounded metadata, or bounded message text when the person asked to
read mail. No model that has read external content may select another
operation in this hop. The existing Email/ADK genes own all semantics.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from datetime import datetime
from datetime import timezone as datetime_timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.agents.email.runtime import run_email_gene
from hushh_mcp.services.gmail_metadata_reader import (
    MAX_BODY_MESSAGES,
    GmailMetadataError,
    GmailMetadataReader,
    MailOperation,
    RequireAccess,
)


class MailReadPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: Literal[
        "list_needs_reply", "list_recent", "search_inbox", "read_message", "read_thread", "clarify"
    ]
    query: str = Field(default="", max_length=512)
    # Omitted means the operation's default: ten listed, one message read.
    limit: int | None = Field(default=None, ge=1, le=25)
    mailbox: Literal["inbox", "sent", "anywhere"] = "inbox"
    clarification: str = Field(default="", max_length=500)


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
    try:
        async with asyncio.timeout(65):
            if message_ids:
                # The person named a position in a list this server minted, so
                # there is nothing to plan: the operation and its target are both
                # already decided. The planner is skipped rather than asked and
                # overruled, and `plan_source` records that it was skipped -- an
                # unrecorded skip is indistinguishable from a planned read.
                plan = MailReadPlan(operation="read_message", mailbox=offer_mailbox)
            else:
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
            elif operation != "read_thread":
                arguments["limit"] = plan.limit or 10
            if operation in {"search_inbox", "read_message", "read_thread"} and plan.query:
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
            metadata = await reader.read(operation, arguments)
            await reader.require_current()
            # Coverage is server bookkeeping, not evidence. Handing counts to the
            # interpreter would invite it to author its own totals in prose, and
            # the whole point of computing them here is that prose cannot be
            # trusted with a number. Its prompt stays exactly what it was.
            coverage = dict(metadata.get("coverage") or {})
            evidence = {k: v for k, v in metadata.items() if k != "coverage"}
            answer = MailReadAnswer.model_validate(
                await gene_runner(
                    gene_id="agent_email_read_interpreter",
                    prompt=json.dumps(
                        {"user_request": message, "retrieved_metadata": evidence, **time_context},
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
        )
    except PermissionError:
        raise
    except Exception:
        # Provider exceptions may contain prompts/headers. Do not log them or
        # let partial metadata masquerade as a successful inbox read.
        return _result(
            conversation_id, "Mail is temporarily unavailable. Please try again.", "unavailable"
        )
