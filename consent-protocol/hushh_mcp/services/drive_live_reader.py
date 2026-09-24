"""Bounded, uncached Drive MCP discovery for an owner who enabled live access.

The result is untrusted document text for the existing Documents suggestion
agent. Only encrypted source observations, never file contents, may be saved by
the sharing store. No selected-file row or indexing operation is involved.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import (
    FILE_ID,
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
)
from hushh_mcp.services.google_drive_mcp_service import GoogleDriveMcpService

MAX_SEARCH_RESULTS = 25
MAX_READS = 8
MAX_CONTEXT_BYTES = 16 * 1024
SEARCH_PAGE_SIZE = 8
MAX_SEARCH_PAGES = 6
UTC_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")
SEARCH_TIME_FIELDS = frozenset({"modifiedTime", "createdTime"})


def _open_url(file_id: str, value: object) -> str:
    """Use Google's view URL only when it names this exact file on Drive/Docs."""
    fallback = f"https://drive.google.com/open?id={file_id}"
    if not isinstance(value, str) or not 1 <= len(value) <= 2048:
        return fallback
    try:
        parsed = urlsplit(value)
        invalid = (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.port
            or parsed.fragment
        )
    except ValueError:
        return fallback
    if invalid:
        return fallback
    path = parsed.path
    if parsed.hostname == "drive.google.com":
        if path == "/open" and parse_qs(parsed.query).get("id") == [file_id]:
            return value
        if re.fullmatch(rf"/file/d/{re.escape(file_id)}/(?:view|preview)", path):
            return value
        if re.fullmatch(rf"/drive(?:/u/\d+)?/folders/{re.escape(file_id)}", path):
            return value
    if parsed.hostname == "docs.google.com" and re.fullmatch(
        rf"/(?:document|spreadsheets|presentation|forms|drawings)/d/{re.escape(file_id)}/(?:edit|view|preview)",
        path,
    ):
        return value
    return fallback


class DriveLiveReader:
    def __init__(self, *, user_id, require_access, oauth=None, mcp=None, adapter=None):
        self.user_id = user_id
        self.require_access = require_access
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.mcp = mcp or GoogleDriveMcpService(oauth=self.oauth)
        self.adapter = adapter or GoogleDriveAdapter()
        self._rows: list[dict] = []
        self._generation: int | None = None

    async def _credential(self):
        await self.require_access()
        row, credential = await self.oauth.current_credential(
            user_id=self.user_id, required_profile="live"
        )
        if (
            row["status"] != "connected"
            or row["validation_state"] != "verified"
            or row["verified_policy_hash"] != LIVE_POLICY_HASH
            or self._generation is not None
            and row["connection_generation"] != self._generation
        ):
            raise DriveReadError("connection_changed")
        self._generation = row["connection_generation"]
        return credential

    async def require_current(self):
        credential = await self._credential()
        for observed in self._rows:
            await self.require_access()
            if observed.get("metadata_only"):
                actual = await self.adapter.get_share_metadata(
                    file_id=observed["file_id"],
                    access_token=credential["accessToken"],
                )
            else:
                actual = await self.adapter.get_metadata(
                    file_id=observed["file_id"],
                    access_token=credential["accessToken"],
                    require_app_authorized=False,
                    require_genai_eligibility=False,
                )
            if actual.version != observed["source_version"] or actual.name != observed["name"]:
                raise DriveReadError("source_changed")
            if observed.get("metadata_only") and not self._in_time_bounds(
                actual,
                time_field=observed.get("time_field"),
                start_time=observed.get("start_time"),
                end_time=observed.get("end_time"),
            ):
                raise DriveReadError("source_changed")
        await self.require_access()

    @staticmethod
    def _content(result):
        if result.is_error or result.truncated:
            raise DriveReadError("provider_response_invalid")
        if result.payload.get("textFormattingNotSupported") is True:
            raise DriveReadError("unsupported_format")
        value = result.payload.get("fileContent")
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, dict):
            for key in ("text", "content"):
                if isinstance(value.get(key), str) and value[key].strip():
                    return value[key]
        raise DriveReadError("unsupported_format")

    @staticmethod
    def _validate_query(query: list[str], *, date_bounded: bool = False) -> list[str]:
        if (
            not isinstance(query, list)
            or not (0 if date_bounded else 1) <= len(query) <= 3
            or any(
                not isinstance(term, str) or not re.fullmatch(r"[\w -]{2,50}", term.strip())
                for term in query
            )
        ):
            raise DriveReadError("narrow_selection_required")
        return list(dict.fromkeys(item.strip() for item in query))

    @staticmethod
    def _search_query(
        term: str | None,
        *,
        time_field: str | None,
        start_time: str | None,
        end_time: str | None,
    ) -> str:
        if time_field is None and start_time is None and end_time is None:
            if term is None:
                raise DriveReadError("narrow_selection_required")
            return f"(title contains '{term}' or fullText contains '{term}')"
        if time_field not in SEARCH_TIME_FIELDS or not all(
            isinstance(value, str) and UTC_TIMESTAMP.fullmatch(value)
            for value in (start_time, end_time)
        ):
            raise DriveReadError("narrow_selection_required")
        try:
            start = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
            end = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
        except ValueError:
            raise DriveReadError("narrow_selection_required") from None
        if start >= end:
            raise DriveReadError("narrow_selection_required")
        date_clause = f"({time_field} >= '{start_time}' and {time_field} < '{end_time}')"
        if term is None:
            return date_clause
        return f"(title contains '{term}' or fullText contains '{term}') and {date_clause}"

    @classmethod
    def _in_time_bounds(
        cls,
        metadata,
        *,
        time_field: str | None,
        start_time: str | None,
        end_time: str | None,
    ) -> bool:
        cls._search_query(None, time_field=time_field, start_time=start_time, end_time=end_time)
        timestamp = (
            metadata.modified_time if time_field == "modifiedTime" else metadata.created_time
        )
        try:
            observed_time = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            raise DriveReadError("provider_response_invalid") from None
        if observed_time.tzinfo is None:
            raise DriveReadError("provider_response_invalid")
        start = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
        return start <= observed_time < end

    async def find(
        self,
        *,
        query: list[str],
        time_field: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> dict:
        """Search bounded file metadata; no content read, selection, or index."""
        date_bounded = time_field is not None or start_time is not None or end_time is not None
        terms = self._validate_query(query, date_bounded=date_bounded)
        searches = [
            self._search_query(
                term, time_field=time_field, start_time=start_time, end_time=end_time
            )
            for term in (terms or [None])
        ]
        await self._credential()
        matches: list[dict] = []
        seen: set[str] = set()
        truncated = False
        pages = 0
        for drive_query in searches:
            page_token = None
            while pages < MAX_SEARCH_PAGES and len(matches) < MAX_SEARCH_RESULTS:
                await self.require_access()
                arguments = {
                    "query": drive_query,
                    "pageSize": SEARCH_PAGE_SIZE,
                    "excludeContentSnippets": True,
                }
                if page_token:
                    arguments["pageToken"] = page_token
                result = await self.mcp.read_tool(
                    user_id=self.user_id, tool_name="search_files", arguments=arguments
                )
                if (
                    result.is_error
                    or result.truncated
                    or not isinstance(result.payload.get("files"), list)
                    or result.payload.get("overLimit") is True
                ):
                    raise DriveReadError("provider_response_invalid")
                candidates = result.payload["files"]
                if len(candidates) > SEARCH_PAGE_SIZE:
                    raise DriveReadError("provider_response_invalid")
                for candidate in candidates:
                    if len(matches) >= MAX_SEARCH_RESULTS:
                        truncated = True
                        break
                    if not isinstance(candidate, dict):
                        truncated = True
                        continue
                    file_id = candidate.get("id")
                    title = candidate.get("title")
                    mime = candidate.get("mimeType")
                    modified = candidate.get("modifiedTime")
                    if (
                        not isinstance(file_id, str)
                        or not FILE_ID.fullmatch(file_id)
                        or not isinstance(title, str)
                        or not 1 <= len(title) <= 1024
                        or mime is not None
                        and (not isinstance(mime, str) or len(mime) > 200)
                        or modified is not None
                        and (not isinstance(modified, str) or len(modified) > 64)
                    ):
                        truncated = True
                        continue
                    if file_id not in seen:
                        seen.add(file_id)
                        matches.append(
                            {
                                "file_id": file_id,
                                "name": title,
                                "mime_type": mime or "",
                                "modified_time": modified,
                                "source_ref": "document:"
                                + hashlib.sha256(str(uuid4()).encode()).hexdigest()[:32],
                                "open_url": _open_url(file_id, candidate.get("viewUrl")),
                            }
                        )
                pages += 1
                next_token = result.payload.get("nextPageToken")
                if next_token is not None and (
                    not isinstance(next_token, str) or len(next_token) > 1024
                ):
                    raise DriveReadError("provider_response_invalid")
                if not next_token:
                    page_token = None
                    break
                if next_token == page_token:
                    raise DriveReadError("provider_response_invalid")
                page_token = next_token
            if page_token:
                truncated = True
            if pages >= MAX_SEARCH_PAGES or len(matches) >= MAX_SEARCH_RESULTS:
                truncated = True
                break
        await self.require_current()
        return {"matches": matches, "truncated": truncated}

    async def search(
        self,
        *,
        query: list[str],
        time_field: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> dict:
        date_bounded = time_field is not None or start_time is not None or end_time is not None
        terms = self._validate_query(query, date_bounded=date_bounded)
        searches = [
            self._search_query(
                term, time_field=time_field, start_time=start_time, end_time=end_time
            )
            for term in (terms or [None])
        ]
        credential = await self._credential()
        files = []
        truncated = False
        for drive_query in searches:
            result = await self.mcp.read_tool(
                user_id=self.user_id,
                tool_name="search_files",
                arguments={
                    "query": drive_query,
                    "pageSize": MAX_SEARCH_RESULTS,
                    "excludeContentSnippets": True,
                },
            )
            if (
                result.is_error
                or result.truncated
                or not isinstance(result.payload.get("files"), list)
            ):
                raise DriveReadError("provider_response_invalid")
            candidates = result.payload["files"]
            if len(candidates) > MAX_SEARCH_RESULTS:
                raise DriveReadError("provider_response_invalid")
            files.extend(candidates)
            truncated = truncated or bool(result.payload.get("nextPageToken"))
        unique_files: list[str] = []
        seen: set[str] = set()
        for candidate in files:
            file_id = candidate.get("id") if isinstance(candidate, dict) else None
            if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                truncated = True
            elif file_id not in seen:
                seen.add(file_id)
                unique_files.append(file_id)
        truncated = truncated or len(unique_files) > MAX_READS
        return await self._read_file_ids(
            file_ids=unique_files[:MAX_READS], credential=credential, truncated=truncated
        )

    async def bind_matches(
        self,
        *,
        matches: list[dict],
        truncated: bool = False,
        time_field: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> dict:
        """Bind a recent-file preview to verified metadata without reading contents."""
        if not isinstance(matches, list) or len(matches) > MAX_SEARCH_RESULTS:
            raise DriveReadError("narrow_selection_required")
        self._search_query(None, time_field=time_field, start_time=start_time, end_time=end_time)
        credential = await self._credential()
        content: list[dict] = []
        self._rows = []
        seen: set[str] = set()
        truncated = truncated or len(matches) > MAX_READS
        for match in matches[:MAX_READS]:
            if not isinstance(match, dict):
                truncated = True
                continue
            file_id, name = match.get("file_id"), match.get("name")
            if (
                not isinstance(file_id, str)
                or not FILE_ID.fullmatch(file_id)
                or not isinstance(name, str)
                or not 1 <= len(name) <= 1024
                or file_id in seen
            ):
                truncated = True
                continue
            seen.add(file_id)
            if match.get("mime_type") == "application/vnd.google-apps.folder":
                truncated = True
                continue
            await self.require_access()
            try:
                metadata = await self.adapter.get_share_metadata(
                    file_id=file_id,
                    access_token=credential["accessToken"],
                )
            except DriveReadError as error:
                if str(error) in {"source_unavailable", "unsupported_format"}:
                    truncated = True
                    continue
                raise
            if metadata.name != name or metadata.mime_type == "application/vnd.google-apps.folder":
                truncated = True
                continue
            if not self._in_time_bounds(
                metadata, time_field=time_field, start_time=start_time, end_time=end_time
            ):
                truncated = True
                continue
            document_id = str(uuid4())
            entry = {
                "source_ref": "document:" + hashlib.sha256(document_id.encode()).hexdigest()[:32],
                "document_ref": document_id,
                "name": metadata.name,
                "page": None,
                "text": f"File metadata only: {metadata.name}. Modified: {metadata.modified_time}.",
                "source_version": metadata.version,
                "metadata_only": True,
            }
            if len(json.dumps(content + [entry], ensure_ascii=False).encode()) > MAX_CONTEXT_BYTES:
                truncated = True
                break
            content.append(entry)
            self._rows.append(
                {
                    "document_id": document_id,
                    "file_id": metadata.file_id,
                    "name": metadata.name,
                    "source_version": metadata.version,
                    "content_fingerprint": None,
                    "connection_generation": self._generation,
                    "metadata_only": True,
                    "time_field": time_field,
                    "start_time": start_time,
                    "end_time": end_time,
                    "_live": True,
                }
            )
        await self.require_current()
        return {"untrusted_external_content": content, "truncated": truncated}

    async def read_matches(self, *, matches: list[dict], truncated: bool = False) -> dict:
        """Read only the already-found, supported files for an explicit read request."""
        if not isinstance(matches, list) or len(matches) > MAX_SEARCH_RESULTS:
            raise DriveReadError("narrow_selection_required")
        credential = await self._credential()
        chosen = matches[:MAX_READS]
        expected = {item["file_id"]: item["name"] for item in chosen}
        return await self._read_file_ids(
            file_ids=list(expected),
            credential=credential,
            truncated=truncated or len(matches) > MAX_READS,
            expected_names=expected,
        )

    async def _read_file_ids(
        self,
        *,
        file_ids: list[str],
        credential: dict,
        truncated: bool,
        expected_names: dict[str, str] | None = None,
    ) -> dict:
        content: list[dict] = []
        self._rows = []
        for file_id in file_ids:
            if not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id):
                raise DriveReadError("provider_response_invalid")
            await self.require_access()
            try:
                metadata = await self.adapter.get_metadata(
                    file_id=file_id,
                    access_token=credential["accessToken"],
                    require_app_authorized=False,
                    require_genai_eligibility=False,
                )
                if expected_names is not None and metadata.name != expected_names[file_id]:
                    raise DriveReadError("source_changed")
                read = await self.mcp.read_tool(
                    user_id=self.user_id,
                    tool_name="read_file_content",
                    arguments={"fileId": file_id},
                )
                body = self._content(read)
                await self.require_access()
                after = await self.adapter.get_metadata(
                    file_id=file_id,
                    access_token=credential["accessToken"],
                    require_app_authorized=False,
                    require_genai_eligibility=False,
                )
                if after != metadata:
                    raise DriveReadError("source_changed")
            except DriveReadError as error:
                if str(error) in {"source_unavailable", "unsupported_format", "file_too_large"}:
                    truncated = True
                    continue
                raise
            document_id = str(uuid4())
            entry = {
                "source_ref": "document:" + hashlib.sha256(document_id.encode()).hexdigest()[:32],
                "document_ref": document_id,
                "name": metadata.name,
                "page": None,
                "text": body[:4000],
                "source_version": metadata.version,
            }
            if len(body) > 4000:
                truncated = True
            if len(json.dumps(content + [entry], ensure_ascii=False).encode()) > MAX_CONTEXT_BYTES:
                truncated = True
                break
            content.append(entry)
            self._rows.append(
                {
                    "document_id": document_id,
                    "file_id": metadata.file_id,
                    "name": metadata.name,
                    "source_version": metadata.version,
                    "content_fingerprint": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                    "connection_generation": self._generation,
                    "_live": True,
                }
            )
        await self.require_current()
        return {"untrusted_external_content": content, "truncated": truncated}
