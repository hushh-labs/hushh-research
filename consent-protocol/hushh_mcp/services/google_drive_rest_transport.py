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
from datetime import UTC, datetime
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
from hushh_mcp.services.google_drive_write_adapter import (
    MAX_COMMENT_CHARS,
    MAX_CONTENT_BYTES,
    MUTATION_SENT,
    DriveWriteError,
    GoogleDriveWriteAdapter,
    bounded_text,
    file_id,
    file_name,
)

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


# Friendly type names the model can use instead of exact MIME types.
MIME_FAMILIES = {
    "document": "mimeType = 'application/vnd.google-apps.document'",
    "spreadsheet": "mimeType = 'application/vnd.google-apps.spreadsheet'",
    "presentation": "mimeType = 'application/vnd.google-apps.presentation'",
    "folder": "mimeType = 'application/vnd.google-apps.folder'",
    "pdf": "mimeType = 'application/pdf'",
    "image": "mimeType contains 'image/'",
    "video": "mimeType contains 'video/'",
    "audio": "mimeType contains 'audio/'",
}
_MIME_TYPE = re.compile(r"[a-z]{1,32}/[A-Za-z0-9.+-]{1,120}\Z")
_OWNERS = {"me": "'me' in owners", "shared_with_me": "sharedWithMe = true", "any": None}
_MAX_TEXT_CHARS = 200


def quote_literal(value: str) -> str:
    """One Drive ``q`` string literal: backslash and quote escaped, nothing else."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _rfc3339(value: object) -> str:
    if not isinstance(value, str) or not 10 <= len(value) <= 40:
        raise DriveOAuthError("invalid_argument", status_code=400)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise DriveOAuthError("invalid_argument", status_code=400) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def structured_query(arguments: dict[str, Any]) -> list[str]:
    """Drive REST ``q`` clauses from typed filters. Every value is escaped or enumerated.

    The model never has to write query syntax to filter by words, type, owner,
    folder or modified time; a raw ``query`` remains for the live reader.
    """
    clauses: list[str] = []
    text = arguments.get("text")
    if text is not None:
        if not isinstance(text, str) or not text.strip() or len(text) > _MAX_TEXT_CHARS:
            raise DriveOAuthError("invalid_argument", status_code=400)
        literal = quote_literal(" ".join(text.split()))
        clauses.append(f"(name contains {literal} or fullText contains {literal})")
    mime = arguments.get("mimeType")
    if mime is not None:
        if isinstance(mime, str) and mime in MIME_FAMILIES:
            clauses.append(MIME_FAMILIES[mime])
        elif isinstance(mime, str) and _MIME_TYPE.fullmatch(mime):
            clauses.append(f"mimeType = {quote_literal(mime)}")
        else:
            raise DriveOAuthError("invalid_argument", status_code=400)
    owner = arguments.get("owner")
    if owner is not None:
        if not isinstance(owner, str) or owner not in _OWNERS:
            raise DriveOAuthError("invalid_argument", status_code=400)
        if _OWNERS[owner]:
            clauses.append(str(_OWNERS[owner]))
    for key, operator in (("modifiedAfter", ">="), ("modifiedBefore", "<")):
        if arguments.get(key) is not None:
            clauses.append(f"modifiedTime {operator} {quote_literal(_rfc3339(arguments[key]))}")
    folder = arguments.get("folderId")
    if folder is not None:
        if not isinstance(folder, str) or not FILE_ID.fullmatch(folder):
            raise DriveOAuthError("invalid_argument", status_code=400)
        clauses.append(f"{quote_literal(folder)} in parents")
    return clauses


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
    def __init__(self, *, oauth=None, adapter=None, writer=None) -> None:
        self._oauth = oauth or get_external_connector_oauth_service().drive()
        self.adapter = adapter or GoogleDriveAdapter()
        self.writer = writer or GoogleDriveWriteAdapter()

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
        return await self._fenced(user_id, tool_name, arguments, _OPERATIONS, _MAX_ARGUMENT_BYTES)

    async def write_tool(
        self,
        *,
        user_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        expected_generation: int | None = None,
    ) -> ExternalMcpToolResult:
        """One owner write through the same live-grant fence as every read.

        Callers own review: sharing and trashing reach here only from the
        reviewed-proposal executor, never from a model tool call, and pass the
        connection generation the owner reviewed under. Once the request has
        left for Google, any failure is an unknown outcome, never a plain
        error, so nothing downstream retries it into a duplicate.
        """
        sent = {"sent": False}
        marker = MUTATION_SENT.set(sent)
        try:
            return await self._fenced(
                user_id,
                tool_name,
                arguments,
                _WRITE_OPERATIONS,
                _MAX_WRITE_ARGUMENT_BYTES,
                expected_generation=expected_generation,
            )
        except DriveWriteError as error:
            if sent["sent"] and not error.outcome_unknown and not error.provider_answered:
                raise DriveWriteError("write_outcome_unknown", outcome_unknown=True) from None
            raise
        except Exception:
            if sent["sent"]:
                raise DriveWriteError("write_outcome_unknown", outcome_unknown=True) from None
            raise
        finally:
            MUTATION_SENT.reset(marker)

    async def _fenced(
        self,
        user_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        operations: dict[str, str],
        max_bytes: int,
        *,
        expected_generation: int | None = None,
    ) -> ExternalMcpToolResult:
        if not user_id or not isinstance(tool_name, str) or tool_name not in operations:
            raise DriveOAuthError("connector_unavailable", status_code=403)
        if not isinstance(arguments, dict):
            raise DriveOAuthError("invalid_argument", status_code=400)
        try:
            if (
                len(json.dumps(arguments, allow_nan=False, ensure_ascii=False).encode("utf-8"))
                > max_bytes
            ):
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
        if expected_generation is not None and row["connection_generation"] != expected_generation:
            # Reviewed under another Drive connection: refuse before sending.
            raise DriveOAuthError("connection_changed", status_code=409)
        # One method per operation. A new operation is one entry in its table
        # plus its method; these owner, grant and generation checks wrap every
        # entry without change.
        operation = getattr(self, operations[tool_name])
        payload: dict = await operation(arguments, credential["accessToken"])
        current = await self._oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        if (
            not current
            or current["connection_generation"] != row["connection_generation"]
            or current["status"] != "connected"
            or current["verified_policy_hash"] != LIVE_POLICY_HASH
        ):
            if operations is _WRITE_OPERATIONS:
                # The write was sent under the grant that was current then. Do
                # not call it failed: "reconnect and retry" could repeat it.
                raise DriveWriteError("write_outcome_unknown", outcome_unknown=True)
            raise DriveOAuthError("connection_changed", status_code=409)
        return ExternalMcpToolResult(is_error=False, payload=payload, truncated=False)

    async def _read_file_content(self, arguments: dict[str, Any], token: str) -> dict:
        file_id = arguments.get("fileId")
        if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
            raise DriveOAuthError("invalid_argument", status_code=400)
        try:
            metadata = await self.adapter.get_metadata(
                file_id=file_id,
                access_token=token,
                require_app_authorized=False,
                require_genai_eligibility=False,
            )
        except DriveReadError as error:
            if str(error) != "unsupported_format":
                raise
            # A video, image, archive, folder or other file with no text:
            # what it is and where to open it, never its bytes.
            return {
                "textFormattingNotSupported": True,
                "metadataOnly": True,
                "file": await self.adapter.get_file_facts(file_id=file_id, access_token=token),
            }
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

    async def _get_file_metadata(self, arguments: dict[str, Any], token: str) -> dict:
        target = arguments.get("fileId")
        if (
            set(arguments) != {"fileId"}
            or not isinstance(target, str)
            or not FILE_ID.fullmatch(target)
        ):
            raise DriveOAuthError("invalid_argument", status_code=400)
        return {"file": await self.adapter.get_file_facts(file_id=target, access_token=token)}

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
            query is not None
            and (not isinstance(query, str) or not 1 <= len(query) <= _MAX_QUERY_CHARS)
            or not isinstance(order, str)
            or order not in _SEARCH_ORDERS
        ):
            raise DriveOAuthError("invalid_argument", status_code=400)
        # The raw dialect (the live reader's compiled query) is translated as
        # before; typed filters are compiled here with every value escaped.
        clauses = [rest_query(query)] if query is not None else []
        clauses.extend(structured_query(arguments))
        if not clauses:
            raise DriveOAuthError("invalid_argument", status_code=400)
        q = " and ".join(clauses)
        if query is None:
            q += " and trashed = false"
        # A metadata-only search keeps the requested file-time order on the
        # provider side, so the page cut itself is newest first. Drive rejects
        # orderBy with a fullText term and ranks those by relevance; that page
        # is then reordered locally by file time.
        full_text = has_full_text_term(q)
        page = await self.adapter.list_files(
            access_token=token,
            query=q,
            page_size=page_size,
            page_token=page_token,
            order_by=None if full_text else order,
        )
        files = _page_files(page)
        return _project_page(page, _newest_first(files, order) if full_text else files)

    async def _private_destination(self, folder: object, token: str) -> str:
        """A folder only the owner can see. Filing into any other folder shares the file.

        Sharing is a reviewed write, so a direct create, copy or move may not
        change who can see a file by choosing where it goes.
        """
        target = file_id(folder)
        facts = await self.writer.facts(target=target, access_token=token)
        if not facts.private_folder:
            raise DriveWriteError("destination_shared")
        return target

    async def _create_file(self, arguments: dict[str, Any], token: str) -> dict:
        _only(arguments, {"name", "kind", "content", "contentFormat", "folderId"})
        kind = arguments.get("kind")
        content = arguments.get("content", "")
        content_format = arguments.get(
            "contentFormat", "csv" if kind == "spreadsheet" else "markdown"
        )
        if kind not in {"document", "spreadsheet", "folder"} or (kind == "folder" and content):
            raise DriveWriteError("invalid_argument")
        folder = arguments.get("folderId")
        parent = await self._private_destination(folder, token) if folder is not None else None
        created = await self.writer.create(
            access_token=token,
            name=file_name(arguments.get("name")),
            kind=kind,
            parent=parent,
            content=bounded_text(content, limit=MAX_CONTENT_BYTES, allow_empty=True),
            content_format=content_format,
        )
        return {"file": created}

    async def _copy_file(self, arguments: dict[str, Any], token: str) -> dict:
        _only(arguments, {"fileId", "name", "folderId"})
        folder = arguments.get("folderId")
        name = arguments.get("name")
        return {
            "file": await self.writer.copy(
                access_token=token,
                source=file_id(arguments.get("fileId")),
                name=file_name(name) if name is not None else None,
                parent=await self._private_destination(folder, token)
                if folder is not None
                else None,
            )
        }

    async def _move_file(self, arguments: dict[str, Any], token: str) -> dict:
        """Move into a private folder, rename, or both, in one update."""
        _only(arguments, {"fileId", "folderId", "name"})
        target = file_id(arguments.get("fileId"))
        folder, name = arguments.get("folderId"), arguments.get("name")
        if folder is None and name is None:
            raise DriveWriteError("invalid_argument")
        destination, current = None, ()
        if folder is not None:
            destination = await self._private_destination(folder, token)
            current = (await self.writer.facts(target=target, access_token=token)).parents
        return {
            "file": await self.writer.update(
                access_token=token,
                target=target,
                name=file_name(name) if name is not None else None,
                add_parent=destination,
                remove_parents=tuple(item for item in current if item != destination),
            )
        }

    async def _add_comment(self, arguments: dict[str, Any], token: str) -> dict:
        _only(arguments, {"fileId", "text"})
        return {
            "comment": await self.writer.comment(
                access_token=token,
                target=file_id(arguments.get("fileId")),
                text=bounded_text(arguments.get("text"), limit=MAX_COMMENT_CHARS),
            )
        }

    async def _share_file(self, arguments: dict[str, Any], token: str) -> dict:
        # Reached only from the reviewed-proposal executor (write_tool's caller).
        _only(arguments, {"fileId", "email", "role", "notify", "message"})
        return {
            "shared": await self.writer.share(
                access_token=token,
                target=file_id(arguments.get("fileId")),
                email=arguments.get("email"),
                role=arguments.get("role"),
                notify=arguments.get("notify", True),
                message=arguments.get("message", ""),
            )
        }

    async def _trash_file(self, arguments: dict[str, Any], token: str) -> dict:
        # Reached only from the reviewed-proposal executor (write_tool's caller).
        _only(arguments, {"fileId"})
        return {
            "file": await self.writer.update(
                access_token=token, target=file_id(arguments.get("fileId")), trash=True
            )
        }


def _only(arguments: dict[str, Any], allowed: set[str]) -> None:
    if not set(arguments) <= allowed:
        raise DriveWriteError("invalid_argument")


# Tool name -> transport method. REST_TOOLS is derived from it so the admitted
# set and the implemented set cannot drift apart.
_OPERATIONS = {
    "search_files": "_search_files",
    "list_recent_files": "_list_recent_files",
    "read_file_content": "_read_file_content",
    "get_file_metadata": "_get_file_metadata",
}
REST_TOOLS = frozenset(_OPERATIONS)
# Owner writes. Create, copy, move/rename and comment run when the owner's agent
# calls them; share and trash run only after the owner reviews the exact call.
_WRITE_OPERATIONS = {
    "create_file": "_create_file",
    "copy_file": "_copy_file",
    "move_file": "_move_file",
    "add_comment": "_add_comment",
    "share_file": "_share_file",
    "trash_file": "_trash_file",
}
REVIEWED_WRITE_TOOLS = frozenset({"share_file", "trash_file"})
DIRECT_WRITE_TOOLS = frozenset(_WRITE_OPERATIONS) - REVIEWED_WRITE_TOOLS
_MAX_WRITE_ARGUMENT_BYTES = MAX_CONTENT_BYTES + 8_192


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
