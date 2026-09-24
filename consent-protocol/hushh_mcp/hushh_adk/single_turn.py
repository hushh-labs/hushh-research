"""Shared runtime for manifest-owned, schema-constrained ADK genes.

Single-turn genes have no tools and receive one bounded prompt.  They use the
same runner, timeout and context rules as specialist turns so the repository
does not grow a second provider or retry implementation for small model calls.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from google.adk.agents import LlmAgent
from google.genai import types
from jsonschema import Draft202012Validator
from pydantic import BaseModel

from hushh_mcp.hushh_adk.manifest import AgentManifestV2, AgentModelConfig, AgentSubagentConfig
from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
from hushh_mcp.runtime_providers import build_managed_gemini_adk_model
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    resolve_fleet_model_name,
    thinking_config_for,
)


def _manifest_config(
    manifest_or_subagent: AgentManifestV2 | AgentSubagentConfig,
) -> AgentModelConfig:
    if isinstance(manifest_or_subagent, AgentManifestV2):
        return manifest_or_subagent.model_config_for_runtime()
    return manifest_or_subagent.model


def _manifest_instruction(manifest_or_subagent: AgentManifestV2 | AgentSubagentConfig) -> str:
    instruction = str(manifest_or_subagent.system_instruction or "").strip()
    if not instruction:
        raise ValueError("single-turn agent instruction is required")
    return instruction


def build_single_turn_agent(
    manifest_or_subagent: AgentManifestV2 | AgentSubagentConfig,
    *,
    output_schema: Any,
    model: Any | None = None,
) -> LlmAgent:
    """Build one manifest-owned ADK gene with a bounded structured response."""

    if output_schema is None:
        raise ValueError("single-turn output_schema is required")
    config = _manifest_config(manifest_or_subagent)
    configured_model = resolve_fleet_model_name(config.name)
    resolved = model if model is not None else build_managed_gemini_adk_model(configured_model)
    model_name = resolved if isinstance(resolved, str) else str(getattr(resolved, "model", ""))
    if not model_name:
        model_name = config.name
    agent_id = str(getattr(manifest_or_subagent, "id", "single_turn") or "single_turn")
    # ADK 2.9 requires a chat/task root for Runner execution.  The manifest's
    # single_turn declaration remains the product contract; this supported
    # runtime mode still creates a fresh session for every invocation.
    agent = LlmAgent(
        name=agent_id.replace("-", "_").replace(".", "_"),
        description=str(getattr(manifest_or_subagent, "description", "Single-turn gene")),
        instruction=_manifest_instruction(manifest_or_subagent),
        model=resolved,
        mode="chat",
        include_contents="none",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=[],
        output_schema=output_schema,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            response_mime_type="application/json",
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            max_output_tokens=manifest_or_subagent.performance.max_output_tokens,
            thinking_config=thinking_config_for(model_name, config.thinking_level, types),
        ),
    )
    return agent


def _prompt_text(prompt_parts: str | Sequence[Any]) -> str:
    if isinstance(prompt_parts, str):
        prompt = prompt_parts.strip()
    else:
        values = []
        for part in prompt_parts:
            text = str(part or "").strip()
            if text:
                values.append(text)
        prompt = "\n\n".join(values).strip()
    if not prompt:
        raise ValueError("single-turn prompt is required")
    return prompt


def _json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Normalize Gemini schema types without touching example/default payloads."""
    result = dict(schema)
    kind = result.get("type")
    if isinstance(kind, str):
        result["type"] = kind.lower()
    elif isinstance(kind, list):
        result["type"] = [value.lower() for value in kind]
    if result.pop("nullable", False):
        result = {"anyOf": [result, {"type": "null"}]}
    for key in ("properties", "$defs", "definitions", "patternProperties"):
        if isinstance(result.get(key), dict):
            result[key] = {name: _json_schema(value) for name, value in result[key].items()}
    for key in ("items", "additionalProperties", "not"):
        if isinstance(result.get(key), dict):
            result[key] = _json_schema(result[key])
    for key in ("anyOf", "oneOf", "allOf", "prefixItems"):
        if isinstance(result.get(key), list):
            result[key] = [_json_schema(value) for value in result[key]]
    return result


def _decode(text: str, schema: Any) -> Any:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("single-turn agent returned invalid JSON") from error
    if isinstance(schema, type) and issubclass(schema, BaseModel):
        return schema.model_validate(value)
    if not isinstance(value, dict):
        raise ValueError("single-turn agent returned a non-object response")
    if isinstance(schema, types.Schema):
        schema = schema.model_dump(exclude_none=True, by_alias=True)
    if isinstance(schema, dict):
        validator = Draft202012Validator(_json_schema(schema))
        if not validator.is_valid(value):
            raise ValueError("single-turn response does not match output schema")
    return value


async def run_single_turn(
    agent: LlmAgent,
    *,
    prompt_parts: str | Sequence[Any],
    user_id: str,
    consent_token: str,
    thinking_level: str | None = None,
    timeout_seconds: float | None = None,
    message_content: types.Content | None = None,
) -> Any:
    """Run one schema-constrained gene and return its validated result.

    ``thinking_level`` is accepted for callers that select a phase-level policy;
    manifest-authored configuration remains authoritative for the built agent.
    A caller cannot use this parameter to widen the response or call budget.
    """

    _ = thinking_level
    schema = agent.output_schema
    if schema is None:
        raise ValueError("single-turn agent requires an output schema")
    total_timeout = 90.0 if timeout_seconds is None else float(timeout_seconds)
    if total_timeout <= 0:
        raise ValueError("single-turn timeout must be positive")
    event_timeout = total_timeout
    if message_content is not None:
        if not isinstance(message_content, types.Content) or not message_content.parts:
            raise ValueError("single-turn message_content must contain parts")
        message: str | types.Content = message_content
    else:
        message = _prompt_text(prompt_parts)
    turn = await run_specialist_adk_turn(
        agent=agent,
        app_name=f"hushh_single_turn_{agent.name}",
        user_id=user_id,
        consent_token=consent_token,
        message=message,
        max_llm_calls=1,
        first_event_timeout_s=event_timeout,
        between_event_timeout_s=event_timeout,
        total_timeout_s=total_timeout,
    )
    text = turn.final_text.strip()
    if not text:
        raise ValueError("single-turn agent returned an empty response")
    return _decode(text, schema)


__all__ = ["build_single_turn_agent", "run_single_turn"]
