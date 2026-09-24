"""Bounded, uncached Drive MCP discovery for an owner who enabled live access.

The result is untrusted document text for the existing Documents suggestion
agent. Only encrypted source observations, never file contents, may be saved by
the sharing store. No selected-file row or indexing operation is involved.
"""

from __future__ import annotations

import hashlib
import json
import re
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
            actual = await self.adapter.get_metadata(
                file_id=observed["file_id"],
                access_token=credential["accessToken"],
                require_app_authorized=False,
                require_genai_eligibility=False,
            )
            if actual.version != observed["source_version"] or actual.name != observed["name"]:
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

    async def search(self, *, query: list[str]) -> dict:
        if (
            not isinstance(query, list)
            or not 1 <= len(query) <= 3
            or any(
                not isinstance(term, str) or not re.fullmatch(r"[\w -]{2,50}", term.strip())
                for term in query
            )
        ):
            raise DriveReadError("narrow_selection_required")
        credential = await self._credential()
        files = []
        truncated = False
        for term in dict.fromkeys(item.strip() for item in query):
            drive_query = f"(title contains '{term}' or fullText contains '{term}')"
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
        content: list[dict] = []
        self._rows = []
        for file_id in unique_files[:MAX_READS]:
            await self.require_access()
            try:
                metadata = await self.adapter.get_metadata(
                    file_id=file_id,
                    access_token=credential["accessToken"],
                    require_app_authorized=False,
                    require_genai_eligibility=False,
                )
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
                "page": 1,
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
