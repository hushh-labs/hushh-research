"""Bounded reasoning and Browser phase codecs for ephemeral Azure ADK history."""

from __future__ import annotations

import json
from typing import Any

from google.genai import types

_PREFIX = b"azure-browser-message-v1:"
_MAX_BYTES = 256 * 1024


def _encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _browser_message(item: Any) -> tuple[dict, str]:
    """Bounded native assistant phase; used only in ephemeral Browser tasks."""
    if hasattr(item, "model_dump"):
        item = item.model_dump(mode="json", exclude_none=True)
    if (
        not isinstance(item, dict)
        or item.get("type") != "message"
        or item.get("role") != "assistant"
        or item.get("phase") not in {"commentary", "final_answer"}
        or item.get("status") not in {None, "completed"}
    ):
        raise ValueError("Invalid Azure browser message")
    text = []
    for segment in item.get("content", []):
        if (
            not isinstance(segment, dict)
            or segment.get("type") != "output_text"
            or not isinstance(segment.get("text"), str)
        ):
            raise ValueError("Invalid Azure browser message content")
        text.append(segment["text"])
    if not text or len(_encode(item).encode()) + len(_PREFIX) > _MAX_BYTES:
        raise ValueError("Azure browser message exceeds bounds")
    return item, "".join(text)


def restore_browser_message(part: types.Part, *, role: str, allowed: bool) -> dict | None:
    signature = part.thought_signature
    if not signature or not signature.startswith(_PREFIX):
        return None
    if not allowed or role != "assistant" or len(signature) > _MAX_BYTES:
        raise ValueError("Invalid Azure browser message history")
    item, text = _browser_message(json.loads(signature[len(_PREFIX) :]))
    if part.text != text or part.thought:
        raise ValueError("Azure browser message changed")
    return item


def browser_message_part(item: Any) -> types.Part:
    message, text = _browser_message(item)
    return types.Part(text=text, thought_signature=_PREFIX + _encode(message).encode())


_SIGNATURE_PREFIX = b"azure-responses-v1:"


def reasoning_part(item: Any) -> types.Part | None:
    if not isinstance(
        (
            item.get("encrypted_content")
            if isinstance(item, dict)
            else getattr(item, "encrypted_content", None)
        ),
        str,
    ):
        return None
    if hasattr(item, "model_dump"):
        item = item.model_dump(mode="json", exclude_none=True)
    if not isinstance(item, dict):
        raise ValueError("Invalid Azure reasoning item")
    signature = _SIGNATURE_PREFIX + _encode(item).encode()
    if len(signature) > _MAX_BYTES:
        raise ValueError("Azure reasoning history exceeds bounds")
    return types.Part(thought=True, thought_signature=signature)


def restore_reasoning(part: types.Part, *, role: str) -> dict | None:
    signature = part.thought_signature
    if not signature or not signature.startswith(_SIGNATURE_PREFIX):
        return None
    if role != "assistant" or len(signature) > _MAX_BYTES:
        raise ValueError("Invalid Azure reasoning history")
    item = json.loads(signature[len(_SIGNATURE_PREFIX) :])
    if not isinstance(item, dict) or item.get("type") != "reasoning":
        raise ValueError("Invalid Azure reasoning history")
    return item
