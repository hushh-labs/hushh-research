"""Manifest-owned Connected Systems ADK parent.

The parent plans CRM work from public schema metadata and typed action
metadata.  It never receives owner records or fills record values; the app
does that after the owner reviews the resulting directive.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.function_tool import FunctionTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.manifest import AgentManifestV2, ManifestLoader
from hushh_mcp.hushh_adk.turn import hushh_tool_error_callback
from hushh_mcp.runtime_providers import build_managed_gemini_adk_model
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    thinking_config_for,
)

DIRECTIVE_STATE_KEY = "hussh:specialist_directive"
PLAN_STATE_KEY = "hussh:connected_systems_plan"
_ACTIONS = frozenset(
    {
        "connected_system.crm.read",
        "connected_system.crm.create.propose",
        "connected_system.crm.update.propose",
        "connected_system.crm.delete",
    }
)
_SAFE_SLOT_KEYS = frozenset({"systemId", "objectType", "scope", "fieldNames"})
_VALUE_KEYS = frozenset(
    {
        "email",
        "phone",
        "firstName",
        "lastName",
        "fullName",
        "address",
        "recordId",
        "record_id",
        "values",
        "fieldValues",
        "additionalFieldsJson",
    }
)


def _text(value: Any, *, limit: int = 160) -> str:
    return " ".join(str(value or "").split())[:limit]


def _service_from_context() -> Any:
    context = HushhContext.current()
    if context is not None:
        service = context.service_ports.get("connected_systems")
        if service is not None:
            return service
    from hushh_mcp.services.connected_systems_service import ConnectedSystemsService

    return ConnectedSystemsService()


async def describe_crm_fields(
    tool_context: ToolContext, system_id: str, object_type: str = "Contact"
) -> dict[str, Any]:
    """Return only the registered CRM's public field catalogue.

    The service may return a stale display-only catalogue while refreshing it;
    callers must treat ``effectiveActions`` and ``freshness`` as authoritative.
    """

    system = _text(system_id, limit=128)
    object_name = _text(object_type, limit=96) or "Contact"
    if not system:
        return {"status": "invalid", "error": "system_id_required"}
    try:
        schema = await _service_from_context().get_schema(
            system_id=system, object_type=object_name, require_fresh=False
        )
    except Exception:
        return {"status": "unavailable", "error": "crm_schema_unavailable"}
    fields = []
    for raw in schema.get("fields") or []:
        if not isinstance(raw, dict):
            continue
        key = _text(raw.get("key"), limit=128)
        if not key:
            continue
        fields.append(
            {
                "key": key,
                "label": _text(raw.get("label") or key, limit=160),
                "dataType": _text(raw.get("dataType") or "string", limit=48),
                "required": raw.get("required") is True,
                "constraints": raw.get("constraints")
                if isinstance(raw.get("constraints"), dict)
                else {},
                "createable": raw.get("createable"),
                "immutable": raw.get("immutable"),
            }
        )
    if not fields:
        return {"status": "unavailable", "error": "crm_schema_unavailable"}
    return {
        "status": "ready",
        "systemId": system,
        "objectType": _text(schema.get("objectType") or object_name, limit=96),
        "objectMetadata": schema.get("objectMetadata")
        if isinstance(schema.get("objectMetadata"), dict)
        else {},
        "fields": fields[:256],
        "supportedFields": [field["key"] for field in fields[:256]],
        "effectiveActions": schema.get("effectiveActions")
        if isinstance(schema.get("effectiveActions"), dict)
        else {},
        "freshness": schema.get("freshness"),
    }


def _safe_plan(raw: Any) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(raw, dict):
        return None, "plan_object_required"
    action_id = _text(raw.get("action_id") or raw.get("actionId"), limit=128)
    if action_id not in _ACTIONS:
        return None, "unsupported_crm_action"
    slots = raw.get("slots")
    if not isinstance(slots, dict):
        return None, "plan_slots_required"
    if any(key in _VALUE_KEYS for key in slots):
        return None, "record_values_must_be_app_bound"
    system_id = _text(slots.get("systemId"), limit=128)
    object_type = _text(slots.get("objectType") or "Contact", limit=96)
    if not system_id or not object_type:
        return None, "crm_system_and_object_required"
    safe_slots: dict[str, Any] = {"systemId": system_id, "objectType": object_type}
    scope = _text(slots.get("scope"), limit=96)
    if scope:
        safe_slots["scope"] = scope
    field_names = slots.get("fieldNames")
    if field_names is None:
        field_names = slots.get("fields")
    if field_names is not None:
        if not isinstance(field_names, list) or len(field_names) > 32:
            return None, "field_names_invalid"
        normalized = [_text(value, limit=128) for value in field_names]
        if any(not value for value in normalized) or len(set(normalized)) != len(normalized):
            return None, "field_names_invalid"
        safe_slots["fieldNames"] = normalized
    execution = "blocked" if action_id == "connected_system.crm.delete" else "frontend"
    reason = "crm_delete_manual_only" if execution == "blocked" else None
    label = {
        "connected_system.crm.read": "Read CRM Record",
        "connected_system.crm.create.propose": "Propose CRM Create",
        "connected_system.crm.update.propose": "Propose CRM Update",
        "connected_system.crm.delete": "Blocked CRM Delete",
    }[action_id]
    message = {
        "connected_system.crm.read": "Opening Connected Systems for the CRM read.",
        "connected_system.crm.create.propose": "Opening Connected Systems so you can review and approve the CRM create.",
        "connected_system.crm.update.propose": "Opening Connected Systems so you can review and approve the CRM update.",
        "connected_system.crm.delete": "CRM deletion is unavailable and must be completed manually.",
    }[action_id]
    return (
        {
            "call_id": _text(raw.get("call_id") or raw.get("callId"), limit=128) or "crm_plan",
            "action_id": action_id,
            "label": label,
            "execution": execution,
            "slots": safe_slots,
            "message": message,
            "reason": reason,
        },
        None,
    )


def validate_crm_plan(planned_action: dict[str, Any], tool_context: ToolContext) -> dict[str, Any]:
    """Validate a typed CRM plan and park its safe directive for the app.

    Values, record identifiers and model-authored messages are deliberately
    rejected so a model cannot turn chat text into a CRM write.
    """

    plan, error = _safe_plan(planned_action)
    if plan is None:
        return {"status": "invalid", "error": error or "invalid_crm_plan"}
    tool_context.state[PLAN_STATE_KEY] = plan
    tool_context.state[DIRECTIVE_STATE_KEY] = {
        "kind": "action",
        "payload": {
            "planned_action": plan,
            "execution": plan["execution"],
        },
    }
    return {"status": "validated", "planned_action": plan}


def build_connected_systems_agent(
    *, model: Any | None = None, manifest: AgentManifestV2 | None = None
) -> LlmAgent:
    """Build the dormant Connected Systems parent from its manifest."""

    manifest = manifest or ManifestLoader.load(str(Path(__file__).with_name("agent.yaml")))
    config = manifest.model_config_for_runtime()
    resolved = (
        model
        if model is not None
        else (
            config.name
            if os.getenv("TESTING", "").lower() in {"1", "true", "yes"}
            else build_managed_gemini_adk_model(config.name)
        )
    )
    model_name = resolved if isinstance(resolved, str) else resolved.model
    child_config = next(
        (child for child in manifest.subagents if child.id == "crm_schema_mapper"), None
    )
    if child_config is None:
        raise ValueError("Connected Systems requires its manifest-owned CRM schema mapper")
    child = LlmAgent(
        name=child_config.id,
        description=child_config.description,
        instruction=child_config.system_instruction,
        model=resolved,
        # ADK AgentTool creates a Runner, whose root must use chat/task even
        # though the manifest records this leaf's single-turn contract.
        mode="chat",
        include_contents="none",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            thinking_config=thinking_config_for(
                model_name, child_config.model.thinking_level, types
            ),
        ),
        on_tool_error_callback=hushh_tool_error_callback,
    )
    tools = [
        FunctionTool(func=validate_crm_plan),
        FunctionTool(func=describe_crm_fields),
        AgentTool(agent=child, skip_summarization=True),
    ]
    return LlmAgent(
        name="connected_systems",
        description=manifest.description,
        instruction=manifest.system_instruction,
        model=resolved,
        mode=manifest.runtime.adk_mode,
        include_contents="default",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=tools,
        on_tool_error_callback=hushh_tool_error_callback,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            thinking_config=thinking_config_for(model_name, config.thinking_level, types),
        ),
    )


__all__ = [
    "DIRECTIVE_STATE_KEY",
    "PLAN_STATE_KEY",
    "build_connected_systems_agent",
    "describe_crm_fields",
    "validate_crm_plan",
]
