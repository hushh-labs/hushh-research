"""Manifest-owned Files task, shared by One delegation and bounded background jobs."""

from typing import Any

from google.adk.agents import LlmAgent
from google.genai import types

from hushh_mcp.hushh_adk.manifest import AgentManifestV2
from hushh_mcp.one_adk.files_tools import create_folder, list_files, organize_file, read_file
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    resolve_fleet_model_name,
    thinking_config_for,
)


def build_files_agent(
    manifest: AgentManifestV2, *, model: Any = None, output_schema: Any = None
) -> LlmAgent:
    from hushh_mcp.runtime_providers import build_managed_gemini_adk_model

    config = manifest.model_config_for_runtime()
    selected = (
        model
        if model is not None
        else build_managed_gemini_adk_model(resolve_fleet_model_name(config.name))
    )
    model_name = selected if isinstance(selected, str) else selected.model
    return LlmAgent(
        name="files",
        mode="task",
        model=selected,
        description=manifest.description,
        instruction=manifest.system_instruction,
        tools=[create_folder, list_files, read_file, organize_file],
        output_schema=output_schema,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            max_output_tokens=manifest.performance.max_output_tokens,
            thinking_config=thinking_config_for(model_name, config.thinking_level, types),
        ),
    )
