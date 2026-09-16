"""Owner-bound read-only Email tools, including the former Gmail receipt lane."""

from __future__ import annotations

from typing import Any

from google.adk.tools import ToolContext

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service


def _gmail(tool_context: ToolContext):
    context = HushhContext.current()
    if context is None or not context.user_id:
        raise PermissionError("Email owner context is required")
    service = context.service_ports.get("gmail")
    return context.user_id, service or get_gmail_receipts_service()


async def list_needs_reply(tool_context: ToolContext, limit: int = 10) -> dict[str, Any]:
    """List inbound Gmail threads that appear to need the owner's reply."""
    user_id, gmail = _gmail(tool_context)
    result = await gmail.list_nudges(user_id=user_id, limit=min(int(limit or 10), 25))
    return {
        "nudges": [n for n in result.get("nudges", []) if n.get("type") == "needs_reply"],
        "account_email": result.get("account_email"),
    }


async def search_inbox(query: str, tool_context: ToolContext, limit: int = 10) -> dict[str, Any]:
    """Search the owner's Gmail and return bounded message summaries."""
    user_id, gmail = _gmail(tool_context)
    results = await gmail.search_inbox(
        user_id=user_id, query=query, limit=min(int(limit or 10), 25)
    )
    return {"results": results}


async def list_receipts(
    tool_context: ToolContext, page: int = 1, per_page: int = 25
) -> dict[str, Any]:
    """List synced purchase receipts, newest first, without mutating sync state."""
    user_id, gmail = _gmail(tool_context)
    return await gmail.list_receipts(
        user_id=user_id,
        page=max(1, int(page or 1)),
        per_page=min(max(1, int(per_page or 25)), 100),
    )


async def sync_status(tool_context: ToolContext) -> dict[str, Any]:
    """Report whether the owner's Gmail receipt sync is connected and healthy."""
    user_id, gmail = _gmail(tool_context)
    return await gmail.get_status(user_id=user_id)


EMAIL_TOOLS = [list_needs_reply, search_inbox, list_receipts, sync_status]
