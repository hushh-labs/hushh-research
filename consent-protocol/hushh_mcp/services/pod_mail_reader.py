"""Credential-free Mail reader for the pod's existing scoped information door."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, RequireAccess
from hushh_mcp.services.pod_mail_observation import MailObservation


class PodMailMetadataReader:
    def __init__(self, *, read: Callable[..., Awaitable[dict]], require_access: RequireAccess):
        self._read = read
        self._require_access = require_access
        self._observation: MailObservation | None = None
        self._used = False

    async def read(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self._used or operation not in {"list_recent", "list_needs_reply", "search_inbox"}:
            raise GmailMetadataError("invalid_argument")
        self._used = True
        await self._require_access()
        result = await self._read(operation=operation, **arguments)
        self._observation = MailObservation.model_validate(result["observation"])
        metadata = result["metadata"]
        if not isinstance(metadata, dict) or metadata.get("metadata_only") is not True:
            raise GmailMetadataError("invalid_response")
        return metadata

    async def require_current(self) -> None:
        await self._require_access()
        if self._observation is None:
            raise GmailMetadataError("connection_changed")
        result = await self._read(operation="validate", observation=self._observation.model_dump())
        if result.get("current") is not True:
            raise GmailMetadataError("connection_changed")
        await self._require_access()
