"""Read-only official Drive MCP adapter using the existing Google grant owner.

This is a provider boundary, not agent invocation authority: callers must derive
the owner from their authenticated, consent-checked context. Connecting Google
does not authorize onward sharing, PKM capture, or a delegated information read.
Do not register an unrestricted generic dispatcher in place of this adapter.
"""

from __future__ import annotations

import time
from copy import deepcopy
from typing import Any

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult, call_tool, list_tools
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH
from hushh_mcp.services.mcp_capability_policy import (
    admit_catalog,
    arguments_bounded,
    arguments_valid,
)

GOOGLE_DRIVE_MCP_ENDPOINT = "https://drivemcp.googleapis.com/mcp/v1"
# Explicit reviewed capabilities, not server-supplied annotations, names with
# read-like prefixes, or model assertions. Cumulative Google tokens can contain
# other permissions, so OAuth read scopes alone are not execution policy.
GOOGLE_DRIVE_READ_TOOLS = frozenset(
    {
        "get_file_metadata",
        "get_file_permissions",
        "list_recent_files",
        "read_file_content",
        "search_files",
    }
)
_CATALOG_TTL_SECONDS = 300


class GoogleDriveMcpService:
    def __init__(self, *, oauth=None) -> None:
        self._oauth = oauth or get_external_connector_oauth_service().drive()
        self._catalog: tuple[float, list[dict[str, Any]]] | None = None

    async def discover_read_tools(self, *, access_token: str | None = None) -> list[dict[str, Any]]:
        """Discover official tool descriptions/schemas without an owner grant.

        The public catalog is capability metadata. It supplies no execution
        authority, credential, or private file result.
        """
        if self._catalog is not None and self._catalog[0] > time.monotonic():
            return deepcopy(self._catalog[1])
        tools = await list_tools(
            endpoint=GOOGLE_DRIVE_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {access_token}"} if access_token else None,
        )
        result = admit_catalog(tools, allowed_names=GOOGLE_DRIVE_READ_TOOLS)
        self._catalog = (time.monotonic() + _CATALOG_TTL_SECONDS, result)
        return deepcopy(result)

    async def discover_for_owner(self, *, user_id: str) -> list[dict[str, Any]]:
        if not connector_feature_enabled("google_drive_live", user_id):
            raise DriveOAuthError("connector_unavailable", status_code=403)
        row, credential = await self._oauth.current_credential(
            user_id=user_id, required_profile="live"
        )
        if (
            row["status"] != "connected"
            or row["validation_state"] != "verified"
            or row["verified_policy_hash"] != LIVE_POLICY_HASH
        ):
            raise DriveOAuthError("reconnect_required", status_code=401)
        result = await self.discover_read_tools(access_token=credential["accessToken"])
        current = await self._oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if not current or current["connection_generation"] != row["connection_generation"]:
            raise DriveOAuthError("connection_changed", status_code=409)
        return result

    async def read_tool(
        self, *, user_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> ExternalMcpToolResult:
        if (
            not user_id
            or not isinstance(tool_name, str)
            or tool_name not in GOOGLE_DRIVE_READ_TOOLS
        ):
            raise DriveOAuthError("connector_unavailable", status_code=403)
        if not arguments_bounded(arguments):
            raise DriveOAuthError("invalid_argument", status_code=400)
        # No bearer is accepted from a model/client and none is returned to it.
        if not connector_feature_enabled("google_drive_live", user_id):
            raise DriveOAuthError("connector_unavailable", status_code=403)
        row, credential = await self._oauth.current_credential(
            user_id=user_id, required_profile="live"
        )
        if (
            row["status"] != "connected"
            or row["validation_state"] != "verified"
            or row["verified_policy_hash"] != LIVE_POLICY_HASH
        ):
            raise DriveOAuthError("reconnect_required", status_code=401)
        catalog = await self.discover_read_tools(access_token=credential["accessToken"])
        capability = next((item for item in catalog if item["name"] == tool_name), None)
        if capability is None:
            raise DriveOAuthError("connector_unavailable", status_code=403)
        if not arguments_valid(capability, arguments):
            raise DriveOAuthError("invalid_argument", status_code=400) from None
        # Contents are untrusted information, never instructions or mutation
        # authority. The shared MCP client bounds the response and request time;
        # this adapter has no result cache, persistence, or automatic retries.
        result = await call_tool(
            tool_name,
            arguments,
            endpoint=GOOGLE_DRIVE_MCP_ENDPOINT,
            headers={"Authorization": f"Bearer {credential['accessToken']}"},
        )
        current = await self._oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if (
            not current
            or current["connection_generation"] != row["connection_generation"]
            or current["status"] != "connected"
            or current["verified_policy_hash"] != LIVE_POLICY_HASH
        ):
            raise DriveOAuthError("connection_changed", status_code=409)
        return result
