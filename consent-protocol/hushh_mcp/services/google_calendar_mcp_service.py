"""Owner-bound reads from Google's official Calendar MCP endpoint.

Calendar writes remain with the existing reviewed action authority. A provider
catalog cannot add a write tool to this adapter's exact read allowlist.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult, call_tool, list_tools
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
    get_google_connection_service,
)
from hushh_mcp.services.mcp_capability_policy import (
    admit_catalog,
    arguments_bounded,
    arguments_valid,
)
from hushh_mcp.services.mcp_catalog_cache import McpCatalogCache

GOOGLE_CALENDAR_MCP_ENDPOINT = "https://calendarmcp.googleapis.com/mcp/v1"
GOOGLE_CALENDAR_READ_TOOLS = frozenset({"get_event", "list_events", "suggest_time"})
_CATALOG_TTL_SECONDS = 300


class GoogleCalendarMcpService:
    def __init__(self, *, connections: GoogleConnectionService | None = None) -> None:
        self._connections = connections or get_google_connection_service()
        self._catalog = McpCatalogCache(ttl_seconds=_CATALOG_TTL_SECONDS)

    async def _catalog_for_token(self, token: str) -> list[dict[str, Any]]:
        cached = self._catalog.get(token)
        if cached is not None:
            return cached
        tools = await list_tools(
            endpoint=GOOGLE_CALENDAR_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {token}"},
        )
        result: list[dict[str, Any]] = admit_catalog(
            tools, allowed_names=GOOGLE_CALENDAR_READ_TOOLS
        )
        self._catalog.put(token, result)
        return result

    async def discover_read_tools(self, *, user_id: str) -> list[dict[str, Any]]:
        if not user_id:
            raise GoogleConnectionError("Connect Google Calendar first", status_code=403)
        token = await self._connections.access_token(
            user_id=user_id, service="calendar", access_level="read"
        )
        return await self._catalog_for_token(token)

    async def read_tool(
        self, *, user_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> ExternalMcpToolResult:
        if not user_id or tool_name not in GOOGLE_CALENDAR_READ_TOOLS:
            raise GoogleConnectionError("This Calendar operation is not available", status_code=403)
        if not arguments_bounded(arguments):
            raise GoogleConnectionError("Calendar request is invalid", status_code=400)
        token = await self._connections.access_token(
            user_id=user_id, service="calendar", access_level="read"
        )
        catalog = await self._catalog_for_token(token)
        capability = next((item for item in catalog if item["name"] == tool_name), None)
        if capability is None:
            raise GoogleConnectionError("This Calendar operation is unavailable", status_code=403)
        if not arguments_valid(capability, arguments):
            raise GoogleConnectionError("Calendar request is invalid", status_code=400)
        return await call_tool(
            tool_name,
            arguments,
            endpoint=GOOGLE_CALENDAR_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {token}"},
        )
