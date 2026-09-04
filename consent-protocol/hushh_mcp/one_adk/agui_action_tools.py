"""Stable AG-UI-safe names for generated Action Gateway contracts."""

from __future__ import annotations

import base64

_PREFIX = "hussh_action_"


def action_id_from_tool_name(tool_name: str) -> str | None:
    value = str(tool_name or "").strip()
    if not value.startswith(_PREFIX):
        return None
    encoded = value[len(_PREFIX) :]
    try:
        padding = "=" * (-len(encoded) % 4)
        return base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


__all__ = ["action_id_from_tool_name"]
