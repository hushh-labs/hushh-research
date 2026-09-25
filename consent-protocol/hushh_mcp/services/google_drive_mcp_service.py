"""Read-only official Drive MCP adapter using the existing Google grant owner.

This is a provider boundary, not agent invocation authority: callers must derive
the owner from their authenticated, consent-checked context. Connecting Google
does not authorize onward sharing, PKM capture, or a delegated information read.
Do not register an unrestricted generic dispatcher in place of this adapter.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.external_mcp_client import (
    ExternalMcpAuthError,
    ExternalMcpError,
    ExternalMcpToolResult,
    call_tool,
    list_tools,
)
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH
from hushh_mcp.services.mcp_capability_policy import (
    admit_catalog,
    arguments_bounded,
    arguments_valid,
)
from hushh_mcp.services.mcp_catalog_cache import McpCatalogCache

logger = logging.getLogger(__name__)

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
_SEARCH_FIELDS = frozenset({"id", "title", "mimeType", "modifiedTime", "createdTime", "viewUrl"})
_LISTING_TOOLS = frozenset({"search_files", "list_recent_files"})


def _search_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop snippets/descriptions before the shared MCP response-size cap."""
    files = payload.get("files")
    if (
        files is None
        and set(payload) <= {"nextPageToken", "content"}
        and not (payload.get("nextPageToken") or payload.get("content"))
    ):
        files = []
    if not isinstance(files, list) or any(not isinstance(item, dict) for item in files):
        raise ExternalMcpError("Invalid Drive listing.", code="MCP_INVALID_RESULT")
    next_page = payload.get("nextPageToken")
    if next_page is not None and not isinstance(next_page, str):
        raise ExternalMcpError("Invalid Drive listing.", code="MCP_INVALID_RESULT")
    # Metadata fields are scalar strings, not a channel for nested content.
    if any(
        value is not None and not isinstance(value, str)
        for item in files
        for key, value in item.items()
        if key in _SEARCH_FIELDS
    ):
        raise ExternalMcpError("Invalid Drive listing.", code="MCP_INVALID_RESULT")
    return {
        "files": [
            {key: value for key, value in item.items() if key in _SEARCH_FIELDS}
            for item in files[:26]
        ],
        "nextPageToken": next_page,
        "overLimit": len(files) > 25,
    }


class GoogleDriveMcpService:
    def __init__(self, *, oauth=None) -> None:
        self._oauth = oauth or get_external_connector_oauth_service().drive()
        self._catalog = McpCatalogCache(ttl_seconds=_CATALOG_TTL_SECONDS)

    async def discover_read_tools(
        self, *, access_token: str | None = None, force_refresh: bool = False
    ) -> list[dict[str, Any]]:
        """Discover official tool descriptions/schemas without an owner grant.

        The public catalog is capability metadata. It supplies no execution
        authority, credential, or private file result.
        """

        async def discover() -> list[dict[str, Any]]:
            tools = await list_tools(
                endpoint=GOOGLE_DRIVE_MCP_ENDPOINT,
                headers={"Authorization": f"Bearer {access_token}"} if access_token else None,
            )
            return admit_catalog(tools, allowed_names=GOOGLE_DRIVE_READ_TOOLS)

        return await self._catalog.load(access_token, discover, force_refresh=force_refresh)

    async def discover_for_owner(
        self, *, user_id: str, force_refresh: bool = False
    ) -> list[dict[str, Any]]:
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
        result = await self.discover_read_tools(
            access_token=credential["accessToken"], force_refresh=force_refresh
        )
        current = await self._oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if not current or current["connection_generation"] != row["connection_generation"]:
            raise DriveOAuthError("connection_changed", status_code=409)
        return result

    async def probe_live_search(self, *, access_token: str) -> None:
        """Prove the granted owner can execute MCP search before verification."""
        try:
            catalog = await self.discover_read_tools(access_token=access_token)
            capabilities = {item["name"]: item for item in catalog}
            if not {"search_files", "read_file_content"} <= capabilities.keys():
                raise DriveOAuthError("connector_unavailable", status_code=502)
            arguments = {
                "query": "owner = 'me'",
                "pageSize": 1,
                "excludeContentSnippets": True,
            }
            if not arguments_valid(capabilities["search_files"], arguments):
                raise DriveOAuthError("connector_unavailable", status_code=502)
            outcome = await call_tool(
                "search_files",
                arguments,
                endpoint=GOOGLE_DRIVE_MCP_ENDPOINT,
                headers={"Authorization": f"Bearer {access_token}"},
                project=_search_metadata,
            )
        except ExternalMcpAuthError:
            logger.warning("drive_mcp.probe_failed reason=auth")
            raise DriveOAuthError("reconnect_required", status_code=401) from None
        except ExternalMcpError as error:
            logger.warning("drive_mcp.probe_failed reason=%s", type(error).__name__)
            raise DriveOAuthError("connector_unavailable", status_code=502) from None
        if (
            outcome.is_error
            or outcome.truncated
            or not isinstance(outcome.payload.get("files"), list)
        ):
            logger.warning(
                "drive_mcp.probe_failed is_error=%s truncated=%s",
                outcome.is_error,
                outcome.truncated,
            )
            raise DriveOAuthError("connector_unavailable", status_code=502)

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
            **({"project": _search_metadata} if tool_name in _LISTING_TOOLS else {}),
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
