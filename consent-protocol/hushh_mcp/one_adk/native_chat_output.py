"""Browser-visible fields from a native ADK chat event."""

from __future__ import annotations

import json
import os
from typing import Any
from uuid import uuid4

from google.adk.events import Event
from pydantic import ValidationError

from hushh_mcp.adk_bridge.contract import SpecialistReadResult
from hushh_mcp.one_adk.location_chat_proposal import TOOL_NAME, location_chat_proposal_from_result
from hushh_mcp.services.chat_key import current_chat_key_markers
from hushh_mcp.services.email_mail_brief import MailBrief

A2UI_TOOL_NAME = "send_a2ui_json_to_client"
STATE_NATIVE_VISUAL_CHAT = "temp:one_native_visual_chat"
_CATALOG = "hussh.ai:morphy-one/v1"
_VISUAL_UPDATES = ("updateComponents", "updateDataModel", "deleteSurface")


def _read_only_visual_message(value: Any) -> bool:
    if not isinstance(value, dict) or len(value) != 2 or value.get("version") != "1.0":
        return False
    if "createSurface" in value:
        surface = value["createSurface"]
        return (
            isinstance(surface, dict)
            and surface.get("catalogId") == _CATALOG
            and surface.get("sendDataModel", False) is False
        )
    return any(isinstance(value.get(operation), dict) for operation in _VISUAL_UPDATES)


def _mail_brief_surface(result: Any) -> dict[str, Any] | None:
    """Compose cited, read-only rows from the specialist's owner-screen brief."""
    if os.getenv("HUSHH_DEPLOY_ENV") != "dev" or not isinstance(result, dict):
        return None
    if result.get("status") != "ok" or result.get("is_complete") is not True:
        return None
    try:
        provenance = SpecialistReadResult.model_validate(result.get("structured"))
        brief = MailBrief.model_validate(result.get("mail_brief"))
    except ValidationError:
        return None
    if provenance.connector != "mail" or provenance.status != "ok" or provenance.metadata_only:
        return None
    refs = {source.source_ref for source in provenance.sources if source.kind == "message"}
    rows = [
        [item.subject or "Mail", item.detail or item.state, item.source_ref]
        for item in brief.items
        if item.source_ref in refs
    ]
    if not rows:
        return None
    return {
        "version": "1.0",
        "createSurface": {
            "surfaceId": uuid4().hex,
            "catalogId": _CATALOG,
            "components": [
                {"id": "root", "component": "SurfaceCard", "children": ["findings"]},
                {
                    "id": "findings",
                    "component": "DataTable",
                    "label": "Mail findings",
                    "columns": ["Email", "Finding", "Source"],
                    "rows": rows,
                    "previewRows": 3,
                },
            ],
        },
    }


def encode_native_chat_output(event: Event, *, location_chat_review: bool = False) -> bytes:
    """Project an admitted One event without exposing provider or session state."""
    if event.author != "one" or event.content is None:
        return b""

    parts: list[dict[str, Any]] = []
    for part in event.content.parts or []:
        if part.thought:
            continue
        if event.content.role == "model" and part.text:
            parts.append({"text": part.text})
        response = part.function_response
        if event.partial or response is None:
            continue
        if location_chat_review and response.name == TOOL_NAME:
            proposal = location_chat_proposal_from_result(response.response)
            if proposal:
                parts.append({"functionResponse": {"name": TOOL_NAME, "response": proposal}})
            continue
        if response.name == "ask_email_agent":
            surface = _mail_brief_surface(response.response)
            if surface:
                parts.append(
                    {
                        "functionResponse": {
                            "name": A2UI_TOOL_NAME,
                            "response": {"validated_a2ui_json": [surface]},
                        }
                    }
                )
            continue
        if response.name != A2UI_TOOL_NAME:
            continue
        messages = (response.response or {}).get("validated_a2ui_json")
        if not isinstance(messages, list) or not 0 < len(messages) <= 24:
            continue
        if all(_read_only_visual_message(message) for message in messages):
            parts.append(
                {
                    "functionResponse": {
                        "name": A2UI_TOOL_NAME,
                        "response": {"validated_a2ui_json": messages},
                    }
                }
            )

    if not parts:
        return b""
    payload = json.dumps(
        {
            "id": event.id,
            "author": "one",
            "partial": event.partial is True,
            "content": {"parts": parts},
        },
        allow_nan=False,
        separators=(",", ":"),
    )
    if any(marker in payload for marker in current_chat_key_markers()):
        return b""
    return f"data: {payload}\n\n".encode()
