"""Manifest-owned Nav parent and Consent child."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Sequence

from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from google.genai import types

from hushh_mcp.agents.nav.tools import list_active_consent_grants, list_previous_consent_grants
from hushh_mcp.hushh_adk.manifest import AgentManifestV2, ManifestLoader
from hushh_mcp.hushh_adk.turn import hushh_tool_error_callback
from hushh_mcp.runtime_providers import build_managed_gemini_adk_model
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    thinking_config_for,
)


def build_nav_agent(
    *,
    model: Any | None = None,
    manifest: AgentManifestV2 | None = None,
    connections_tools: Sequence[BaseTool] | None = None,
) -> LlmAgent:
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
    child = next(child for child in manifest.subagents if child.id == "consent")
    model_name = resolved if isinstance(resolved, str) else resolved.model
    common = dict(
        model=resolved,
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        on_tool_error_callback=hushh_tool_error_callback,
    )
    # AgentTool creates a separate Runner: ADK 2.9 rejects single_turn roots.
    # Both manifests therefore declare chat; the shared wrapper creates a fresh
    # session each invocation, preserving the adapter's stateless turn contract.
    consent = LlmAgent(
        name=child.id,
        description=child.description,
        instruction=child.system_instruction,
        mode=child.runtime.adk_mode,
        include_contents="none",
        tools=[list_active_consent_grants, list_previous_consent_grants],
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            thinking_config=thinking_config_for(model_name, child.model.thinking_level, types),
        ),
        **common,
    )
    tools = [AgentTool(agent=consent, skip_summarization=True)]
    if connections_tools is not None:
        from hushh_mcp.agents.connections.agent import build_connections_agent

        tools.append(
            AgentTool(
                agent=build_connections_agent(tools=connections_tools, model=resolved),
                skip_summarization=True,
            )
        )
    return LlmAgent(
        name="nav",
        description=manifest.description,
        instruction=manifest.system_instruction,
        mode=manifest.runtime.adk_mode,
        include_contents="default",
        tools=tools,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            thinking_config=thinking_config_for(model_name, config.thinking_level, types),
        ),
        **common,
    )
