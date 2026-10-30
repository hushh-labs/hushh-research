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
        # One non-mutating Calendar adapter enters the existing conversation.
        # Its authored contract confers no RSVP or Mail execution capability.
        calendar_handoff = (
            action.get("action_id") == "calendar.invitation.review"
            and action.get("execution_policy") == "allow_direct"
            and (action.get("execution_target") or {}).get("target") == "continue_calendar_in_chat"
        )
        if not (
            calendar_handoff
            or str(action.get("action_id", "")).startswith("location.")
            or command.get("domain") == "location"
        ):
            continue
        # Conversation adapters are not executable command capabilities.
        if (action.get("execution_target") or {}).get(
            "path"
        ) == "voice_tool" and not calendar_handoff:
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
    """Complete model-facing catalog; execution authority stays in ``catalog``.

    The model chooses an action and its inputs. A Location action's single
    execution step and target repeat its ID and review route; sending all of
    that for every action makes the managed semantics request miss its deadline.
    Keep exceptional workflows and boundaries, and never drop an action.
    """

    def action_semantics(entry: dict[str, Any]) -> dict[str, Any]:
        action_id = entry["action_id"]
        command = entry.get("command") or {}
        result = {
            "action_id": action_id,
            "meaning": entry.get("meaning") or entry.get("label"),
            "inputs": (entry.get("goal") or {}).get("required_inputs", []),
            "command": command,
            "policy": entry.get("execution_policy"),
        }
        boundaries = entry.get("semantic_boundaries")
        if boundaries is not None:
            result["boundaries"] = boundaries
        steps = (entry.get("goal") or {}).get("workflow_steps", [])
        # Most authored workflows are a single execution of this same action.
        # The host retains the full workflow for validation and execution.
        if not (
            isinstance(steps, list)
            and len(steps) == 1
            and isinstance(steps[0], dict)
            and steps[0].get("type") == "action"
            and steps[0].get("action_id") == action_id
        ):
            result["workflow"] = steps
        # The Calendar conversation handoff has no Location review route and
        # its target is semantic information the model must retain.
        if not command and entry.get("execution_target"):
            result["execution_target"] = entry["execution_target"]
        return result

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
        else action_semantics(entry)
        for entry in catalog.values()
    ]
