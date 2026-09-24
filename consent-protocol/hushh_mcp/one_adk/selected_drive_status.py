"""Owner-bound, metadata-only status of files selected through Drive Picker."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_selection_service import DriveSelectionService

PRIVATE_SOURCE = "google_drive_selected_status"
MAX_MATCHES = 3


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


async def inspect_selected_drive_files(file_name: str, tool_context: ToolContext) -> dict[str, Any]:
    """Check the owner's current Drive connection and selected-file status.

    For general Drive access or selection questions, pass file_name="". That
    returns only connection state and selected count, without any filenames.
    For a named file, pass only its name, not a recipient or action. Resolve
    "it" or "that file" only from an unambiguous name in this conversation;
    never guess a name from another chat or the selected-file catalog.
    This reads only the owner's selected metadata. It cannot search all of
    Drive, read contents, identify a recipient, create a draft, or share.
    """
    owner = await _owner(tool_context)
    if owner is None:
        return {"status": "blocked", "message": "Unlock One to check selected Drive files."}
    if not isinstance(file_name, str) or len(file_name) > 200:
        return {"status": "unavailable", "message": "Name a shorter file to check."}
    try:
        service = _service()
        before = await service.oauth.lifecycle.read(user_id=owner, connector_id="google_drive")
        documents = await service.documents(user_id=owner) if before else []
        after = await service.oauth.lifecycle.read(user_id=owner, connector_id="google_drive")
        # Selection, removal and processing changes do not advance the OAuth
        # generation. Recheck the catalog after the first read before naming a
        # file, and fail closed when the two snapshots differ.
        latest_documents = await service.documents(user_id=owner) if after else []
        final = await service.oauth.lifecycle.read(user_id=owner, connector_id="google_drive")
    except Exception:  # noqa: BLE001 - never surface provider or storage diagnostics
        # Provider, database and encrypted-metadata diagnostics stay private.
        return {"status": "unavailable", "message": "Drive status could not be checked."}
    if await _owner(tool_context) != owner:
        return {"status": "blocked", "message": "The Drive session changed. Try again."}
    if documents != latest_documents:
        return {"status": "unavailable", "message": "Selected files changed. Try again."}
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
        return {"status": "unavailable", "message": "The Drive connection changed. Try again."}
    connection = (
        "disconnected"
        if not final or final["status"] == "revoked"
        else "connected"
        if final["status"] == "connected"
        else "reconnect_required"
    )
    selected = documents if connection == "connected" else []
    # The empty name is the aggregate status request. Never enumerate selected
    # filenames merely to answer whether Drive is connected or has selections.
    matches = _matches(selected, file_name) if file_name.strip() else []
    return {
        "source": PRIVATE_SOURCE,
        "status": "ok",
        "connection": connection,
        "selectedCount": len(selected),
        "matchCount": len(matches),
        "matches": [
            {"name": item["name"], "status": item["status"]} for item in matches[:MAX_MATCHES]
        ],
        "matchesTruncated": len(matches) > MAX_MATCHES,
    }
