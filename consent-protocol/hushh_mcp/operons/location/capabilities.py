"""A generated view over the owning gateway, never a second action catalog."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def compile_location_capabilities(
    actions: list[dict[str, Any]],
) -> tuple[str, dict[str, dict[str, Any]]]:
    catalog = {}
    for action in actions:
        command = action.get("command") or {}
        if not (
            str(action.get("action_id", "")).startswith("location.")
            or command.get("domain") == "location"
        ):
            continue
        # Conversation adapters are not executable command capabilities.
        if (action.get("execution_target") or {}).get("path") == "voice_tool":
            continue
        catalog[action["action_id"]] = action
    canonical = json.dumps(catalog, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest(), catalog


def semantic_catalog(catalog: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Complete compact package, with no prompt-ranking cap hiding capabilities."""
    return [
        {
            "action_id": entry["action_id"],
            "meaning": entry.get("meaning") or entry.get("label"),
            "boundaries": entry.get("semantic_boundaries"),
            "inputs": (entry.get("goal") or {}).get("required_inputs", []),
            "workflow": (entry.get("goal") or {}).get("workflow_steps", []),
            "command": entry.get("command", {}),
            "execution_target": entry.get("execution_target"),
            "policy": entry.get("execution_policy"),
        }
        for entry in catalog.values()
    ]
