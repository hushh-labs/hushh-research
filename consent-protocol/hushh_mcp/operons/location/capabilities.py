"""A generated view over the owning gateway, never a second action catalog."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def compile_location_capabilities(
    actions: list[dict[str, Any]],
    workflows: list[dict[str, Any]] | None = None,
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
    for workflow in workflows or []:
        if workflow.get("capability_id") == "workflow.setup.location":
            catalog[workflow["capability_id"]] = {
                "workflow_id": workflow["capability_id"],
                "workflow": workflow,
            }
            # A workflow may expose a separately authored navigation entry. Keep
            # that route action available for explicit opening without treating
            # it as a Location mutation or folding it into completion.
            entry_action_id = str(workflow.get("entry_action_id") or "")
            if entry_action_id:
                entry_action = next(
                    (item for item in actions if item.get("action_id") == entry_action_id),
                    None,
                )
                if entry_action is not None:
                    catalog[entry_action_id] = entry_action
    canonical = json.dumps(catalog, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest(), catalog


def semantic_catalog(catalog: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Complete compact package, with no prompt-ranking cap hiding capabilities."""
    return [
        {
            "workflow_id": entry["workflow_id"],
            "workflow": {
                "label": entry["workflow"].get("label"),
                "description": entry["workflow"].get("description"),
                "knowledge_projection": entry["workflow"].get("knowledge_projection"),
                "entry_action_id": entry["workflow"].get("entry_action_id"),
                "command_completion_action_ids": entry["workflow"].get(
                    "command_completion_action_ids", []
                ),
                "completion": (entry["workflow"].get("plan") or {}).get("completion"),
            },
        }
        if "workflow_id" in entry
        else {
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
