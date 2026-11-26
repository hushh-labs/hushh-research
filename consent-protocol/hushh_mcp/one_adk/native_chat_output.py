"""Browser-visible fields from a native ADK chat event."""

from __future__ import annotations

import json
import re
from typing import Any

from google.adk.events import Event

from hushh_mcp.services.chat_key import current_chat_key_markers

A2UI_TOOL_NAME = "send_a2ui_json_to_client"
STATE_NATIVE_VISUAL_CHAT = "temp:one_native_visual_chat"
_CATALOG = "hussh.ai:morphy-one/v1"
_VISUAL_UPDATES = ("updateComponents", "updateDataModel", "deleteSurface")
_CORRELATION_ID = re.compile(r"[A-Za-z0-9_.:-]{1,200}")
_BROWSER_TASK_ID = re.compile(r"browser_[a-f0-9]{32}")


def _browser_task_receipt(event: Event, response: Any) -> dict[str, Any] | None:
    """A discovery hint, never Browser execution or information authority."""
    result = response.response
    if not isinstance(result, dict) or result.get("status") != "accepted":
        return None
    binding = result.get("binding")
    if not isinstance(binding, dict):
        return None
    owner_id, task_id = binding.get("owner_id"), binding.get("task_id")
    if (
        not isinstance(owner_id, str)
        or not 0 < len(owner_id) <= 256
        or not isinstance(task_id, str)
        or not _BROWSER_TASK_ID.fullmatch(task_id)
        or not isinstance(event.invocation_id, str)
        or not _CORRELATION_ID.fullmatch(event.invocation_id)
        or not isinstance(response.id, str)
        or not _CORRELATION_ID.fullmatch(response.id)
    ):
        return None
    return {
        "invocationId": event.invocation_id,
        "toolCallId": response.id,
        "status": "accepted",
        "binding": {"owner_id": owner_id, "task_id": task_id},
    }


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

    parts: list[dict[str, Any]] = []
    frames: list[str] = []
    for part in event.content.parts or []:
        if part.thought:
            continue
        if event.content.role == "model" and part.text:
            parts.append({"text": part.text})
        response = part.function_response
        if event.partial or response is None:
            continue
        if response.name == "start_browser_task":
            if receipt := _browser_task_receipt(event, response):
                frames.append(
                    "event: browser_task\ndata: "
                    + json.dumps(receipt, allow_nan=False, separators=(",", ":"))
                    + "\n\n"
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

    if parts:
        frames.append(
            "data: "
            + json.dumps(
                {
                    "id": event.id,
                    "author": "one",
                    "partial": event.partial is True,
                    "content": {"parts": parts},
                },
                allow_nan=False,
                separators=(",", ":"),
            )
            + "\n\n"
        )
    payload = "".join(frames)
    if any(marker in payload for marker in current_chat_key_markers()):
        return b""
    return payload.encode()
