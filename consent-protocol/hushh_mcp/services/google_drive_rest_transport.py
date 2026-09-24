"""Live Drive reads over the GA Drive REST API, shaped like the Drive MCP tools.

Google's Drive MCP server is a Workspace developer preview. For this project it
lists tools but refuses every call ("The caller does not have permission"), so
no live grant on UAT ever passed verification, while the selected-file lane kept
working over the REST API. This transport keeps the live reader's contract (the
tool names, arguments and payload shapes) and the same owner, grant and
generation checks, and reads through that REST API.
"""

from __future__ import annotations

import json
import re
from typing import Any

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_parser import ParseError, parse_document
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import (
    FILE_ID,
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
)
from hushh_mcp.services.google_drive_mcp_service import _search_metadata

REST_TOOLS = frozenset({"search_files", "list_recent_files", "read_file_content"})
_MAX_ARGUMENT_BYTES = 4_096
_MAX_QUERY_CHARS = 1_800
_TITLE = re.compile(r"\btitle (contains|=|!=) ")


def rest_query(query: str) -> str:
    """Translate the Drive MCP query dialect to Drive REST v3 ``q``.

    The live reader only compiles title, fullText, mimeType, sharedWithMe and
    time clauses from validated terms, so only ``title`` and ``owner`` differ.
    """
    translated = _TITLE.sub(lambda match: f"name {match.group(1)} ", query)
    translated = translated.replace("owner = 'me'", "'me' in owners")
    return f"({translated}) and trashed = false"


def _as_mcp_file(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "title": item.get("name"),
        "mimeType": item.get("mimeType"),
        "modifiedTime": item.get("modifiedTime"),
        "createdTime": item.get("createdTime"),
        "viewUrl": item.get("webViewLink"),
    }


class GoogleDriveRestTransport:
    def __init__(self, *, oauth=None, adapter=None) -> None:
        self._oauth = oauth or get_external_connector_oauth_service().drive()
        self.adapter = adapter or GoogleDriveAdapter()

    async def probe(self, *, access_token: str) -> None:
        """Prove the granted owner can search Drive before the grant is verified."""
        try:
            page = await self.adapter.list_files(
                access_token=access_token, query="trashed = false", page_size=1
            )
        except DriveReadError as error:
            code = "reconnect_required" if str(error) == "reconnect_required" else None
            raise DriveOAuthError(
                code or "connector_unavailable", status_code=401 if code else 502
            ) from None
        # An account with no files still proves search works: zero files is fine.
        if not isinstance(page.get("files", []), list):
            raise DriveOAuthError("connector_unavailable", status_code=502)

    async def read_tool(
        self, *, user_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> ExternalMcpToolResult:
        if not user_id or not isinstance(tool_name, str) or tool_name not in REST_TOOLS:
            raise DriveOAuthError("connector_unavailable", status_code=403)
        if not isinstance(arguments, dict):
            raise DriveOAuthError("invalid_argument", status_code=400)
        try:
            if len(json.dumps(arguments, allow_nan=False).encode("utf-8")) > _MAX_ARGUMENT_BYTES:
                raise ValueError("oversized")
        except (TypeError, ValueError, RecursionError):
            raise DriveOAuthError("invalid_argument", status_code=400) from None
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
        payload = await self._call(tool_name, arguments, credential["accessToken"])
        current = await self._oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if (
            not current
            or current["connection_generation"] != row["connection_generation"]
            or current["status"] != "connected"
            or current["verified_policy_hash"] != LIVE_POLICY_HASH
        ):
            raise DriveOAuthError("connection_changed", status_code=409)
        return ExternalMcpToolResult(is_error=False, payload=payload, truncated=False)

    async def _call(self, tool_name: str, arguments: dict[str, Any], token: str) -> dict:
        if tool_name == "read_file_content":
            file_id = arguments.get("fileId")
            if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                raise DriveOAuthError("invalid_argument", status_code=400)
            metadata = await self.adapter.get_metadata(
                file_id=file_id,
                access_token=token,
                require_app_authorized=False,
                require_genai_eligibility=False,
            )
            mime_type, content = await self.adapter.read_live_bytes(
                file_id=file_id, mime_type=metadata.mime_type, access_token=token
            )
            try:
                text = "\n\n".join(page for page in parse_document(content, mime_type).pages)
            except ParseError:
                return {"textFormattingNotSupported": True}
            return {"fileContent": text}
        page_size = arguments.get("pageSize", 8)
        page_token = arguments.get("pageToken")
        if (
            not isinstance(page_size, int)
            or isinstance(page_size, bool)
            or not 1 <= page_size <= 25
            or page_token is not None
            and not isinstance(page_token, str)
        ):
            raise DriveOAuthError("invalid_argument", status_code=400)
        if tool_name == "list_recent_files":
            page = await self.adapter.list_files(
                access_token=token,
                query="trashed = false",
                page_size=page_size,
                page_token=page_token,
                order_by="recency",
            )
        else:
            query = arguments.get("query")
            if not isinstance(query, str) or not 1 <= len(query) <= _MAX_QUERY_CHARS:
                raise DriveOAuthError("invalid_argument", status_code=400)
            page = await self.adapter.list_files(
                access_token=token,
                query=rest_query(query),
                page_size=page_size,
                page_token=page_token,
            )
        files = page.get("files", [])
        if not isinstance(files, list):
            raise DriveReadError("provider_response_invalid")
        return _search_metadata(
            {
                "files": [_as_mcp_file(item) for item in files if isinstance(item, dict)],
                "nextPageToken": page.get("nextPageToken"),
            }
        )
