"""Browser-visible fields from a native ADK chat event."""

from __future__ import annotations

import json
from typing import Any

from google.adk.events import Event

from hushh_mcp.services.chat_key import current_chat_key_markers

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


def encode_native_chat_output(event: Event) -> bytes:
    """Project an admitted One event without exposing provider or session state."""
    if event.author != "one" or event.content is None:
        return b""

    parts = []
    for part in event.content.parts or []:
        if part.thought:
            continue
        if event.content.role == "model" and part.text:
            parts.append({"text": part.text})
        response = part.function_response
        if event.partial or response is None or response.name != A2UI_TOOL_NAME:
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
