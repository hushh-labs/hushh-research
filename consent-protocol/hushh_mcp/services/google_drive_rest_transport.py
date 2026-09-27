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
from hushh_mcp.services.drive_document_parser import ParseError

# The live lane parses what the selected lane does, plus CSV (a Google Sheets
# export or an uploaded .csv). Bound to this name so the read path is unchanged.
from hushh_mcp.services.drive_document_parser import parse_live_document as parse_document
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

# Parse failures the owner can act on (unlock, use a text PDF, split a file,
# re-save a damaged or mis-encoded file). Only these codes leave the transport;
# every other one stays unsupported.
PARSE_REASONS = frozenset(
    {"encrypted_document", "no_extractable_text", "file_too_large", "invalid_document"}
)
_MAX_ARGUMENT_BYTES = 4_096
_MAX_QUERY_CHARS = 1_800
# A search may only rank by a file time, newest first; anything else is refused.
_SEARCH_ORDERS = frozenset({"modifiedTime desc", "createdTime desc"})
_TITLE = re.compile(r"\btitle (contains|=|!=) ")
# Drive refuses any orderBy on a query with a fullText term ("Sorting is not
# supported for queries with fullText terms. Results are always in descending
# relevance order."), so such a search sends no orderBy at all.
_FULL_TEXT = re.compile(r"\bfullText\b")


def has_full_text_term(query: str) -> bool:
    return _FULL_TEXT.search(query) is not None


def _newest_first(files: list[Any], order: str) -> list[Any]:
    """Sort one relevance-ordered page by the requested file time, newest first.

    Only the returned page is reordered; Drive still chooses which files make
    the page, by relevance. Items without the time sort last, never dropped.
    """
    field = order.split(" ", 1)[0]

    def key(item: Any) -> tuple[bool, str]:
        value = item.get(field) if isinstance(item, dict) else None
        return (isinstance(value, str) and bool(value), value if isinstance(value, str) else "")

    return sorted(files, key=key, reverse=True)


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
        # One method per operation. A new operation is one entry in
        # _OPERATIONS plus its method; read_tool's owner, grant and
        # generation checks wrap every entry without change.
        operation = getattr(self, _OPERATIONS[tool_name])
        result: dict = await operation(arguments, token)
        return result

    async def _read_file_content(self, arguments: dict[str, Any], token: str) -> dict:
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
            parsed = parse_document(content, mime_type)
            text = "\n\n".join(parsed.pages)
        except ParseError as error:
            code = str(error)
            if code in PARSE_REASONS:
                return {"textFormattingNotSupported": True, "reason": code}
            return {"textFormattingNotSupported": True}
        return {
            "fileContent": text,
            **({"contentTruncated": True} if parsed.truncated else {}),
        }

    async def _list_recent_files(self, arguments: dict[str, Any], token: str) -> dict:
        page_size, page_token = _page_arguments(arguments)
        page = await self.adapter.list_files(
            access_token=token,
            query="trashed = false",
            page_size=page_size,
            page_token=page_token,
            order_by="recency desc",
        )
        return _project_page(page, _page_files(page))

    async def _search_files(self, arguments: dict[str, Any], token: str) -> dict:
        page_size, page_token = _page_arguments(arguments)
        query = arguments.get("query")
        order = arguments.get("orderBy", "modifiedTime desc")
        if (
            not isinstance(query, str)
            or not 1 <= len(query) <= _MAX_QUERY_CHARS
            or not isinstance(order, str)
            or order not in _SEARCH_ORDERS
        ):
            raise DriveOAuthError("invalid_argument", status_code=400)
        # A metadata-only search keeps the requested file-time order on the
        # provider side, so the page cut itself is newest first. Drive rejects
        # orderBy with a fullText term and ranks those by relevance; that page
        # is then reordered locally by file time.
        full_text = has_full_text_term(query)
        page = await self.adapter.list_files(
            access_token=token,
            query=rest_query(query),
            page_size=page_size,
            page_token=page_token,
            order_by=None if full_text else order,
        )
        files = _page_files(page)
        return _project_page(page, _newest_first(files, order) if full_text else files)


# Tool name -> transport method. REST_TOOLS is derived from it so the admitted
# set and the implemented set cannot drift apart.
_OPERATIONS = {
    "search_files": "_search_files",
    "list_recent_files": "_list_recent_files",
    "read_file_content": "_read_file_content",
}
REST_TOOLS = frozenset(_OPERATIONS)


def _page_arguments(arguments: dict[str, Any]) -> tuple[int, str | None]:
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
    return page_size, page_token


def _page_files(page: dict[str, Any]) -> list[Any]:
    files = page.get("files", [])
    if not isinstance(files, list):
        raise DriveReadError("provider_response_invalid")
    return files


def _project_page(page: dict[str, Any], files: list[Any]) -> dict:
    projected: dict = _search_metadata(
        {
            "files": [_as_mcp_file(item) for item in files if isinstance(item, dict)],
            "nextPageToken": page.get("nextPageToken"),
        }
    )
    return projected
