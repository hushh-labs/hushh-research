"""Nonpersisting, two-stage Mail read orchestration for One's conversation.

The planner sees only the person's request. A separate tool-less interpreter
sees the bounded metadata. No model that has read external content may select
another operation in this hop. The existing Email/ADK genes own all semantics.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.agents.email.runtime import run_email_gene
from hushh_mcp.services.gmail_metadata_reader import (
    GmailMetadataError,
    GmailMetadataReader,
    RequireAccess,
)


class MailReadPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: Literal["list_needs_reply", "search_inbox", "clarify"]
    query: str = Field(default="", max_length=512)
    limit: int = Field(default=10, ge=1, le=25)
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
    "invalid_argument": "Please narrow your request to an inbox search or messages needing a reply.",
}


def _result(
    conversation_id: str, text: str, status: str, *, sources=(), truncated=False
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
            "metadata_only": True,
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
    gene_runner: Callable[..., Awaitable[dict[str, Any]]] = run_email_gene,
    reader_factory: Callable[..., GmailMetadataReader] = GmailMetadataReader,
) -> dict[str, Any]:
    # No history, chat store, provider credentials or user IDs enter the model
    # prompt. One already owns the outer conversation and its encrypted answer.
    await require_access()
    if not message.strip() or len(message.encode("utf-8")) > 8000:
        return _result(conversation_id, _ERRORS["invalid_argument"], "input_required")
    try:
        async with asyncio.timeout(65):
            plan = MailReadPlan.model_validate(
                await gene_runner(
                    gene_id="agent_email_read_planner",
                    prompt=json.dumps({"user_request": message}, ensure_ascii=False),
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
            arguments: dict[str, Any] = {"limit": plan.limit}
            if plan.operation == "search_inbox":
                arguments["query"] = plan.query
            elif plan.query:
                raise GmailMetadataError("invalid_argument")
            reader = reader_factory(gmail=gmail, user_id=user_id, require_access=require_access)
            metadata = await reader.read(plan.operation, arguments)
            await reader.require_current()
            answer = MailReadAnswer.model_validate(
                await gene_runner(
                    gene_id="agent_email_read_interpreter",
                    prompt=json.dumps(
                        {"user_request": message, "retrieved_metadata": metadata},
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
            sources = [
                {"source_ref": ref, "label": "Mail", "kind": "metadata"}
                for ref in dict.fromkeys(answer.source_refs)
            ]
            text = answer.answer
            if metadata["truncated"]:
                text += "\n\nThis is a bounded inbox result; some matches or metadata were omitted."
            return _result(
                conversation_id,
                text,
                "ok",
                sources=sources,
                truncated=metadata["truncated"],
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
