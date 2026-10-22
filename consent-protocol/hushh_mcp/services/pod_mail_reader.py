"""Credential-free Mail reader for the pod's existing scoped information door."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, RequireAccess, _arguments
from hushh_mcp.services.pod_mail_observation import MailObservation


class PodMailMetadataReader:
    def __init__(self, *, read: Callable[..., Awaitable[dict]], require_access: RequireAccess):
        self._read = read
        self._require_access = require_access
        self._observation: MailObservation | None = None
        self._used = False

    @property
    def account(self) -> str:
        """The pod cannot verify which Google account served the ids, so it names none."""
        return ""

    def offered_message_ids(self) -> tuple[str, ...]:
        """No positional offer from a pod read.

        The Gmail reader's documented degenerate case: an empty map makes a later
        "read the second one" refuse honestly, where a map the pod cannot vouch for
        could bind that request to the wrong mail.
        """
        return ()

    async def read(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self._used:
            raise GmailMetadataError("invalid_argument")
        _arguments(operation, arguments)
        self._used = True
        await self._require_access()
        result = await self._read(operation=operation, **arguments)
        self._observation = MailObservation.model_validate(result["observation"])
        metadata = result["metadata"]
        reads_body = operation in {"read_message", "read_thread"}
        if (
            not isinstance(metadata, dict)
            or metadata.get("metadata_only") is not (not reads_body)
            or (reads_body and metadata.get("operation") != operation)
            or len(json.dumps(metadata).encode("utf-8")) > 24000
        ):
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
