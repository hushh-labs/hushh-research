"""Owner-bound, metadata-only status of files selected through Drive Picker."""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_selection_service import DriveSelectionService
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH

PRIVATE_SOURCE = "google_drive_selected_status"
MAX_MATCHES = 3
logger = logging.getLogger(__name__)


def _service() -> DriveSelectionService:
    return DriveSelectionService()


def _key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = re.sub(r"(?<=\w)['’]s\b", "", normalized)
    return "".join(character for character in normalized if character.isalnum())


def _matches(documents: list[dict[str, Any]], file_name: str) -> list[dict[str, Any]]:
    query = _key(file_name)
    if len(query) < 3:
        return []
    exact = [
        document
        for document in documents
        if query in {_key(document["name"]), _key(document["name"].rsplit(".", 1)[0])}
    ]
    if exact:
        return exact
    return [document for document in documents if query in _key(document["name"].rsplit(".", 1)[0])]


async def _owner(tool_context: ToolContext) -> str | None:
    user_id = str(tool_context.state.get("hussh:user_id") or "").strip()
    if (
        tool_context.state.get(STATE_EXECUTION_SURFACE) != "typed_chat"
        or not user_id
        or tool_context.user_id != user_id
        or not connector_feature_enabled("google_drive_chat_reads", user_id)
    ):
        return None
    token = resolve_request_secret(tool_context.state.get("hussh:consent_token"))
    return user_id if await validate_first_party_owner_token(user_id, token) else None


async def inspect_selected_drive_files(
    file_name: str = "", tool_context: ToolContext | None = None
) -> dict[str, Any]:
    """Check the owner's current Drive connection and selected-file status.

    For general Drive access or selection questions, omit file_name or pass file_name="". That
    returns only connection state and selected count, without any filenames.
    For a named file, pass only its name, not a recipient or action. Resolve
    "it" or "that file" only from an unambiguous name in this conversation;
    never guess a name from another chat or the selected-file catalog.
    This reads only the owner's selected metadata. It cannot search all of
    Drive, read contents, identify a recipient, create a draft, or share.
    """
    started = time.monotonic()

    def finish(result: dict[str, Any], reason: str, error_type: str = "none") -> dict[str, Any]:
        # Authored enums and elapsed time only: no owner, filename, token,
        # provider diagnostics or selected metadata enter telemetry.
        logger.info(
            "drive_status.check status=%s reason=%s error_type=%s duration_ms=%.2f",
            result["status"],
            reason,
            error_type,
            (time.monotonic() - started) * 1000,
        )
        return result

    owner = await _owner(tool_context) if tool_context is not None else None
    if tool_context is None or owner is None:
        return finish(
            {
                "status": "blocked",
                "message": "Unlock One to check Drive status. This does not mean Drive is disconnected.",
            },
            "owner_not_admitted",
        )
    if not isinstance(file_name, str) or len(file_name) > 200:
        return finish(
            {"status": "unavailable", "message": "Name a shorter file to check."},
            "invalid_file_name",
        )
    try:
        service = _service()
        before = await service.oauth.lifecycle.read(user_id=owner, connector_id="google_drive")
        live = bool(before and before.get("verified_policy_hash") == LIVE_POLICY_HASH)
        documents = await service.documents(user_id=owner) if before and not live else []
        after = await service.oauth.lifecycle.read(user_id=owner, connector_id="google_drive")
        # Selection, removal and processing changes do not advance the OAuth
        # generation. Recheck the catalog after the first read before naming a
        # file, and fail closed when the two snapshots differ.
        latest_documents = await service.documents(user_id=owner) if after and not live else []
        final = await service.oauth.lifecycle.read(user_id=owner, connector_id="google_drive")
    except Exception as error:  # noqa: BLE001 - never surface provider or storage diagnostics
        # Provider, database and encrypted-metadata diagnostics stay private.
        return finish(
            {
                "status": "unavailable",
                "message": "Drive status could not be checked. This does not mean Drive is disconnected.",
            },
            "status_read_failed",
            type(error).__name__,
        )
    if await _owner(tool_context) != owner:
        return finish(
            {"status": "blocked", "message": "The Drive session changed. Try again."},
            "owner_changed",
        )
    if documents != latest_documents:
        return finish(
            {"status": "unavailable", "message": "Selected files changed. Try again."},
            "selection_changed",
        )
    if (
        (before is None) != (after is None)
        or (after is None) != (final is None)
        or (
            before
            and after
            and final
            and (
                before["connection_generation"] != after["connection_generation"]
                or after["connection_generation"] != final["connection_generation"]
                or before["status"] != after["status"]
                or after["status"] != final["status"]
            )
        )
    ):
        return finish(
            {"status": "unavailable", "message": "The Drive connection changed. Try again."},
            "connection_changed",
        )
    connection = (
        "disconnected"
        if not final or final["status"] == "revoked"
        else "connected"
        if final["status"] == "connected"
        else "reconnect_required"
    )
    if live:
        return finish(
            {
                "source": PRIVATE_SOURCE,
                "status": "ok",
                "connection": connection,
                "accessMode": "live",
                "liveReadAvailable": connection == "connected"
                and connector_feature_enabled("google_drive_live", owner),
                "message": (
                    "Use ask_documents_agent to find or read files. No file selection is required."
                    if connection == "connected"
                    and connector_feature_enabled("google_drive_live", owner)
                    else "Live Drive reading is unavailable. Check the connection."
                ),
            },
            connection,
        )
    selected = documents if connection == "connected" else []
    # The empty name is the aggregate status request. Never enumerate selected
    # filenames merely to answer whether Drive is connected or has selections.
    matches = _matches(selected, file_name) if file_name.strip() else []
    return finish(
        {
            "source": PRIVATE_SOURCE,
            "status": "ok",
            "connection": connection,
            "selectedCount": len(selected),
            "matchCount": len(matches),
            "matches": [
                {"name": item["name"], "status": item["status"]} for item in matches[:MAX_MATCHES]
            ],
            "matchesTruncated": len(matches) > MAX_MATCHES,
        },
        connection,
    )
