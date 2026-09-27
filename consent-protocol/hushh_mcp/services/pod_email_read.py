"""Bounded read-only Gmail projections for the existing owner-scoped broker."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.services.gmail_metadata_reader import GmailMetadataReader, RequireAccess
from hushh_mcp.services.pod_mail_observation import (
    MailObservation,
    MailObservationContext,
    issue_observation,
    verify_observation,
)


class EmailReadOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal[
        "nudges", "search", "list_recent", "list_needs_reply", "search_inbox", "validate"
    ] = "nudges"
    query: str | None = Field(default=None, min_length=1, max_length=512)
    limit: int = Field(default=10, ge=1, le=25)
    mailbox: Literal["inbox", "sent", "anywhere"] = "inbox"
    observation: MailObservation | None = None

    @model_validator(mode="after")
    def search_query(self) -> "EmailReadOptions":
        if self.operation in {"search", "search_inbox"} and not (self.query and self.query.strip()):
            raise ValueError("search query required")
        if self.operation not in {"search", "search_inbox"} and self.query is not None:
            raise ValueError("query requires search")
        if (self.operation == "validate") != (self.observation is not None):
            raise ValueError("observation requires validation")
        if self.operation not in {"search_inbox", "list_recent"} and self.mailbox != "inbox":
            raise ValueError("mailbox requires a metadata read")
        if self.operation == "validate" and self.limit != 10:
            raise ValueError("validation has no read limit")
        return self


class _MessageSummary(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    subject: str = Field(max_length=1000)
    sender: str = Field(alias="from", max_length=500)
    snippet: str = Field(max_length=200)
    received_at: str | None = Field(default=None, max_length=80)


async def read_email_metadata(
    owner_id: str,
    options: EmailReadOptions,
    *,
    service: Any = None,
    context: MailObservationContext | None = None,
    require_access: RequireAccess | None = None,
    reader_factory: Any = GmailMetadataReader,
) -> dict[str, Any]:
    if service is None:
        from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

        service = get_gmail_receipts_service()
    if options.operation not in {"nudges", "search"}:
        if context is None or context.owner_id != owner_id or require_access is None:
            raise PermissionError("Mail observation authority required")
        reader = reader_factory(gmail=service, user_id=owner_id, require_access=require_access)
        if options.operation == "validate":
            verify_observation(
                context, options.observation, await reader.current_grant_fingerprint()
            )
            await require_access()
            return {"current": True}
        arguments: dict[str, Any] = {"limit": options.limit, "mailbox": options.mailbox}
        if options.query is not None:
            arguments["query"] = options.query
        metadata = await reader.read(options.operation, arguments)
        await reader.require_current()
        observation = issue_observation(context, reader.observed_grant_fingerprint())
        await require_access()
        return {"metadata": metadata, "observation": observation.model_dump()}
    if options.operation == "search":
        raw = await asyncio.wait_for(
            service.search_inbox(user_id=owner_id, query=options.query, limit=options.limit),
            timeout=15,
        )
        if not isinstance(raw, list) or len(raw) > options.limit:
            raise ValueError("Email results exceed bounded read")
        return {
            "results": [
                _MessageSummary.model_validate(item).model_dump(by_alias=True) for item in raw
            ]
        }
    from hushh_mcp.services.pod_data_door import project_email_state

    raw = await asyncio.wait_for(
        service.list_nudges(user_id=owner_id, limit=options.limit), timeout=15
    )
    if not isinstance(raw, dict) or not isinstance(raw.get("nudges"), list):
        raise ValueError("Email nudges unavailable")
    if len(raw["nudges"]) > options.limit:
        raise ValueError("Email nudges exceed bounded read")
    return project_email_state(raw)
