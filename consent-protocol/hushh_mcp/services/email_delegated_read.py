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


class MailReadAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    answer: str = Field(min_length=1, max_length=4000)
    source_refs: list[str] = Field(default_factory=list, max_length=25)


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
    except (ValueError, ZoneInfoNotFoundError):
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
) -> dict[str, Any]:
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
            if operation == "read_message":
                # Reading bodies is bounded tighter than listing; a larger plan
                # limit is normalized to that bound, never widened.
                arguments["limit"] = min(plan.limit or 1, MAX_BODY_MESSAGES)
            elif operation != "read_thread":
                arguments["limit"] = plan.limit or 10
            if operation in {"search_inbox", "read_message", "read_thread"} and plan.query:
                arguments["query"] = _epoch_date_terms(plan.query, zone)
            reader = reader_factory(gmail=gmail, user_id=user_id, require_access=require_access)
            metadata = await reader.read(operation, arguments)
            await reader.require_current()
            answer = MailReadAnswer.model_validate(
                await gene_runner(
                    gene_id="agent_email_read_interpreter",
                    prompt=json.dumps(
                        {"user_request": message, "retrieved_metadata": metadata, **time_context},
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
            known_refs = {item["source_ref"] for item in metadata["untrusted_external_content"]}
            if set(answer.source_refs) - known_refs or (known_refs and not answer.source_refs):
                raise ValueError("invalid_mail_sources")
            kind = "metadata" if metadata["metadata_only"] else "message"
            sources = [
                {"source_ref": ref, "label": "Mail", "kind": kind}
                for ref in dict.fromkeys(answer.source_refs)
            ]
            text = answer.answer
            if metadata["truncated"] and metadata["metadata_only"]:
                text += "\n\nThis is a bounded inbox result; some matches or metadata were omitted."
            elif metadata["truncated"]:
                text += (
                    "\n\nLong or older messages were shortened to fit; open the email in "
                    "Gmail for the full text."
                )
            return _result(
                conversation_id,
                text,
                "ok",
                sources=sources,
                truncated=metadata["truncated"],
                metadata_only=metadata["metadata_only"],
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
