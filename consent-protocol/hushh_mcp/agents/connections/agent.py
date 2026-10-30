"""Build the manifest-owned Connections read/proposal agent."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Sequence

from google.adk.agents import LlmAgent
from google.adk.tools.base_tool import BaseTool
from google.genai import types

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.turn import hushh_tool_error_callback
from hushh_mcp.runtime_providers import build_managed_gemini_adk_model
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    thinking_config_for,
)

TOOL_NAMES = frozenset(
    {
        "list_my_connections",
        "list_pending_requests",
        "find_people",
        "request_person_choice",
        "propose_send_request",
        "propose_accept_request",
        "propose_reject_request",
        "propose_remove_connection",
    }
)


def build_connections_agent(*, tools: Sequence[BaseTool], model: Any = None) -> LlmAgent:
    """Caller must supply only owner-bound, ingress-authorized read/proposal tools."""
    if len(tools) != len(TOOL_NAMES) or {tool.name for tool in tools} != TOOL_NAMES:
        raise ValueError("Connections requires exactly its eight read/proposal tools")
    manifest = ManifestLoader.load(str(Path(__file__).with_name("agent.yaml")))
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
    return LlmAgent(
        name="connections",
        description=manifest.description,
        instruction=manifest.system_instruction,
        model=resolved,
        mode=manifest.runtime.adk_mode,
        include_contents="default",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=list(tools),
        on_tool_error_callback=hushh_tool_error_callback,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            thinking_config=thinking_config_for(model_name, config.thinking_level, types),
        ),
    )
