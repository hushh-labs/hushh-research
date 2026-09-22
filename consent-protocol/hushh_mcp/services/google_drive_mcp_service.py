"""Read-only official Drive MCP adapter using the existing Google grant owner.

This is a provider boundary, not agent invocation authority: callers must derive
the owner from their authenticated, consent-checked context. Connecting Google
does not authorize onward sharing, PKM capture, or a delegated information read.
Do not register an unrestricted generic dispatcher in place of this adapter.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult, call_tool
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
    get_google_connection_service,
)

GOOGLE_DRIVE_MCP_ENDPOINT = "https://drivemcp.googleapis.com/mcp/v1"
# Explicit reviewed capabilities, not server-supplied annotations, names with
# read-like prefixes, or model assertions. Cumulative Google tokens can contain
# other permissions, so OAuth read scopes alone are not execution policy.
GOOGLE_DRIVE_READ_TOOLS = frozenset(
    {
        "download_file_content",
        "get_file_metadata",
        "get_file_permissions",
        "list_recent_files",
        "read_file_content",
        "search_files",
    }
)


class GoogleDriveMcpService:
    def __init__(self, *, connections: GoogleConnectionService | None = None) -> None:
        self._connections = connections or get_google_connection_service()

    async def read_tool(
        self, *, user_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> ExternalMcpToolResult:
        if not user_id or tool_name not in GOOGLE_DRIVE_READ_TOOLS:
            raise GoogleConnectionError("This Drive operation is not available", status_code=403)
        # No bearer is accepted from a model/client and none is returned to it.
        access_token = await self._connections.access_token(
            user_id=user_id, service="drive", access_level="read"
        )
        # Contents are untrusted information, never instructions or mutation
        # authority. The shared MCP client bounds the response and request time;
        # this adapter has no result cache, persistence, or automatic retries.
        return await call_tool(
            tool_name,
            arguments,
            endpoint=GOOGLE_DRIVE_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {access_token}"},
        )
