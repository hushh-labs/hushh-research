"""Bounded read-only Gmail projections for the existing owner-scoped broker."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class EmailReadOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["nudges", "search"] = "nudges"
    query: str | None = Field(default=None, min_length=1, max_length=500)
    limit: int = Field(default=10, ge=1, le=25)

    @model_validator(mode="after")
    def search_query(self) -> "EmailReadOptions":
        if self.operation == "search" and not (self.query and self.query.strip()):
            raise ValueError("search query required")
        if self.operation != "search" and self.query is not None:
            raise ValueError("query requires search")
        return self


class _MessageSummary(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    subject: str = Field(max_length=1000)
    sender: str = Field(alias="from", max_length=500)
    snippet: str = Field(max_length=200)
    received_at: str | None = Field(default=None, max_length=80)


async def read_email_metadata(
    owner_id: str, options: EmailReadOptions, *, service: Any = None
) -> dict[str, Any]:
    if service is None:
        from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

        service = get_gmail_receipts_service()
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
