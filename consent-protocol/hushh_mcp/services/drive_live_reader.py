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
    LIVE_PARTIAL_EXPORTS,
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
)
from hushh_mcp.services.google_drive_rest_transport import PARSE_REASONS, GoogleDriveRestTransport

MAX_SEARCH_RESULTS = 25
MAX_READS = 8
MAX_CONTEXT_BYTES = 16 * 1024
EXCERPT_CHARS = 4000
SEARCH_PAGE_SIZE = 8
MAX_SEARCH_PAGES = 6
UTC_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")
SEARCH_TIME_FIELDS = frozenset({"modifiedTime", "createdTime"})
TITLE_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
# A found file that could not be read is reported with exactly one of these.
UNREADABLE = frozenset({"source_unavailable", "unsupported_format"}) | PARSE_REASONS
MAX_TITLE_DATES = 3
# Drive MCP: file types belong in mimeType clauses, never title/fullText words.
MIME_CLAUSES = {
    "document": (
        "(mimeType = 'application/vnd.google-apps.document'"
        " or mimeType = 'application/msword' or mimeType contains 'wordprocessingml')"
    ),
    "spreadsheet": (
        "(mimeType = 'application/vnd.google-apps.spreadsheet'"
        " or mimeType contains 'spreadsheetml' or mimeType = 'text/csv')"
    ),
    "presentation": (
        "(mimeType = 'application/vnd.google-apps.presentation'"
        " or mimeType contains 'presentationml')"
    ),
    "pdf": "mimeType = 'application/pdf'",
    "image": "mimeType contains 'image/'",
    "video": "mimeType contains 'video/'",
    "audio": "mimeType contains 'audio/'",
    "folder": "mimeType = 'application/vnd.google-apps.folder'",
}


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


def _json_size(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False).encode())


def _fitted_excerpt(entry: dict, body: str, *, limit: int) -> str:
    """Longest excerpt whose whole entry fits ``limit`` JSON UTF-8 bytes.

    Measured, not estimated: Hindi text, escaped newlines and control
    characters cost more bytes per character than English.
    """
    text = body[:EXCERPT_CHARS]
    if _json_size({**entry, "text": text}) <= limit:
        return text
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if _json_size({**entry, "text": text[:middle]}) <= limit:
            low = middle
        else:
            high = middle - 1
    return text[:low]


class DriveLiveReader:
    def __init__(self, *, user_id, require_access, oauth=None, mcp=None, adapter=None):
        self.user_id = user_id
        self.require_access = require_access
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        # The GA REST API, not the preview Drive MCP server, which refuses tool
        # calls for this project. Same tool contract, so nothing else changes.
        self.mcp = mcp or GoogleDriveRestTransport(oauth=self.oauth)
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
            reason = result.payload.get("reason")
            raise DriveReadError(reason if reason in PARSE_REASONS else "unsupported_format")
        value = result.payload.get("fileContent")
        if isinstance(value, str):
            if value.strip():
                return value
            raise DriveReadError("no_extractable_text")
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
        file_kind: str = "any",
        shared_with_me: bool = False,
        recent: bool = False,
        title_dates: list[str] | tuple[str, ...] = (),
    ) -> dict:
        """Search bounded file metadata; no content read, selection, or index.

        Terms must all match first (Drive's own multi-word behaviour); any term
        may match only when that finds nothing. A file type is a mimeType clause.
        """
        date_bounded = time_field is not None or start_time is not None or end_time is not None
        if file_kind not in MIME_CLAUSES and file_kind != "any":
            raise DriveReadError("narrow_selection_required")
        # Meet names recordings and notes in the meeting's own timezone, so a day
        # can also be matched by the date in the title (checked exactly below).
        if len(title_dates) > MAX_TITLE_DATES or (title_dates and not date_bounded):
            raise DriveReadError("narrow_selection_required")
        if any(not isinstance(day, str) or not TITLE_DATE.fullmatch(day) for day in title_dates):
            raise DriveReadError("narrow_selection_required")
        filtered = date_bounded or file_kind != "any" or shared_with_me
        terms = self._validate_query(query, date_bounded=filtered or recent)
        base = [MIME_CLAUSES[file_kind]] if file_kind != "any" else []
        if shared_with_me:
            base.append("sharedWithMe = true")
        untimed = list(base)
        if date_bounded:
            base.append(
                self._search_query(
                    None, time_field=time_field, start_time=start_time, end_time=end_time
                )
            )
        term_clauses = [
            f"(title contains '{term}' or fullText contains '{term}')" for term in terms
        ]
        # A date window ranks by that file time, so the result cut keeps the newest.
        order = {"orderBy": f"{time_field} desc"} if date_bounded else {}
        requests: list[tuple[str, dict]] = []
        if term_clauses:
            requests.append(
                ("search_files", {"query": " and ".join([*term_clauses, *base]), **order})
            )
            if len(term_clauses) > 1:
                either = "(" + " or ".join(term_clauses) + ")"
                requests.append(("search_files", {"query": " and ".join([either, *base]), **order}))
        elif base:
            requests.append(("search_files", {"query": " and ".join(base), **order}))
        elif recent:
            requests.append(("list_recent_files", {"orderBy": "recency"}))
        else:
            raise DriveReadError("narrow_selection_required")
        await self._credential()
        matches: list[dict] = []
        seen: set[str] = set()
        truncated = False
        pages = 0
        for tool_name, request in requests:
            page_token = None
            while pages < MAX_SEARCH_PAGES and len(matches) < MAX_SEARCH_RESULTS:
                await self.require_access()
                arguments = {
                    **request,
                    "pageSize": SEARCH_PAGE_SIZE,
                    "excludeContentSnippets": True,
                }
                if page_token:
                    arguments["pageToken"] = page_token
                result = await self.mcp.read_tool(
                    user_id=self.user_id, tool_name=tool_name, arguments=arguments
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
                    match = self._match(candidate)
                    if match is None:
                        truncated = True
                        continue
                    if match["file_id"] not in seen:
                        seen.add(match["file_id"])
                        matches.append(match)
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
            if matches:
                # All terms matched; the broader any-term search is only a fallback.
                break
        dated: list[dict] = []
        title_pages = 0
        for day in title_dates:
            token = day.replace("-", "/")
            page_token = None
            while title_pages < MAX_SEARCH_PAGES:
                await self.require_access()
                arguments = {
                    "query": " and ".join([*term_clauses, *untimed, f"title contains '{token}'"]),
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
                    or len(result.payload["files"]) > SEARCH_PAGE_SIZE
                    or result.payload.get("overLimit") is True
                ):
                    raise DriveReadError("provider_response_invalid")
                title_pages += 1
                for candidate in result.payload["files"]:
                    match = self._match(candidate)
                    if match is None:
                        truncated = True
                        continue
                    # Drive tokenizes the title search loosely; keep only exact dates.
                    exact = token in match["name"] or day in match["name"]
                    if exact and match["file_id"] not in seen:
                        seen.add(match["file_id"])
                        dated.append(match)
                next_token = result.payload.get("nextPageToken")
                if next_token is not None and (
                    not isinstance(next_token, str) or len(next_token) > 1024
                ):
                    raise DriveReadError("provider_response_invalid")
                if not next_token:
                    break
                if next_token == page_token:
                    raise DriveReadError("provider_response_invalid")
                page_token = next_token
            else:
                truncated = True
        if dated:
            matches = [*dated, *matches][:MAX_SEARCH_RESULTS]
        if recent and tool_name == "search_files":
            field = "created_time" if time_field == "createdTime" else "modified_time"
            matches.sort(key=lambda item: item.get(field) or "", reverse=True)
        await self.require_current()
        return {"matches": matches, "truncated": truncated}

    @staticmethod
    def _match(candidate: object) -> dict | None:
        if not isinstance(candidate, dict):
            return None
        file_id = candidate.get("id")
        title = candidate.get("title")
        mime = candidate.get("mimeType")
        modified = candidate.get("modifiedTime")
        created = candidate.get("createdTime")
        if (
            not isinstance(file_id, str)
            or not FILE_ID.fullmatch(file_id)
            or not isinstance(title, str)
            or not 1 <= len(title) <= 1024
            or mime is not None
            and (not isinstance(mime, str) or len(mime) > 200)
            or any(
                value is not None and (not isinstance(value, str) or len(value) > 64)
                for value in (modified, created)
            )
        ):
            return None
        return {
            "file_id": file_id,
            "name": title,
            "mime_type": mime or "",
            "modified_time": modified,
            "created_time": created,
            "source_ref": "document:" + hashlib.sha256(str(uuid4()).encode()).hexdigest()[:32],
            "open_url": _open_url(file_id, candidate.get("viewUrl")),
        }

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
            match_refs={item["file_id"]: item.get("source_ref") for item in chosen},
        )

    async def _read_file_ids(
        self,
        *,
        file_ids: list[str],
        credential: dict,
        truncated: bool,
        expected_names: dict[str, str] | None = None,
        match_refs: dict[str, str | None] | None = None,
    ) -> dict:
        """Read bounded text; report each file that could not be read, with why.

        ``unreadable`` entries carry the found name, an allowlisted reason and
        the match's source_ref. They are owner-private: callers pass only
        counts to anything whose output can reach another person.
        """
        content: list[dict] = []
        unreadable: list[dict] = []
        self._rows = []
        # Every chosen file gets an equal share of what is left of the context,
        # so six monthly statements all reach the model instead of three in
        # full and none of the rest; an unreadable or short file leaves its
        # share to the files after it. The budget check below stays the hard
        # limit.
        for position, file_id in enumerate(file_ids):
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
                if str(error) in UNREADABLE:
                    unreadable.append(
                        {
                            "name": (expected_names or {}).get(file_id),
                            "reason": str(error),
                            "source_ref": (match_refs or {}).get(file_id),
                        }
                    )
                    truncated = True
                    continue
                raise
            document_id = str(uuid4())
            entry = {
                "source_ref": "document:" + hashlib.sha256(document_id.encode()).hexdigest()[:32],
                "document_ref": document_id,
                "name": metadata.name,
                "page": None,
                "text": "",
                "source_version": metadata.version,
            }
            # Two bytes for the list separator; the list's brackets are in used.
            share = (MAX_CONTEXT_BYTES - _json_size(content)) // (len(file_ids) - position) - 2
            entry["text"] = _fitted_excerpt(entry, body, limit=share)
            if not entry["text"]:
                # No room left for even a fragment of this file.
                truncated = True
                break
            if len(entry["text"]) < len(body) or metadata.mime_type in LIVE_PARTIAL_EXPORTS:
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
        return {
            "untrusted_external_content": content,
            "truncated": truncated,
            "unreadable": unreadable,
        }
