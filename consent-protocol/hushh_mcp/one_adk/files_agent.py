"""Manifest-owned Files task, shared by One delegation and bounded background jobs."""

from typing import Any, Literal

from google.adk.agents import LlmAgent
from google.genai import types

from hushh_mcp.hushh_adk.manifest import AgentManifestV2
from hushh_mcp.one_adk.files_tools import (
    create_folder,
    list_files,
    organize_file,
    read_file,
    search_files,
    write_file,
)
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    resolve_fleet_model_name,
    thinking_config_for,
)

_CHAT_MODE_INSTRUCTION_SUFFIX = (
    "\n\nYou are answering an interactive owner chat delegation about their private /one/files library. "
    "Use search_files, list_files, read_file, write_file, create_folder, or organize_file directly. "
    "Reply directly in plain text with the exact filenames, metadata, and grounded content found; "
    "finish_task is not used in this mode."
)


def build_files_agent(
    manifest: AgentManifestV2,
    *,
    model: Any = None,
    output_schema: Any = None,
    mode: Literal["task", "chat"] = "task",
) -> LlmAgent:
    from hushh_mcp.runtime_providers import build_managed_gemini_adk_model

    config = manifest.model_config_for_runtime()
    selected = (
        model
        if model is not None
        else build_managed_gemini_adk_model(resolve_fleet_model_name(config.name))
    )
    model_name = selected if isinstance(selected, str) else selected.model
    effective_mode: Literal["task", "chat"] = (
        "chat" if (mode == "chat" and output_schema is None) else "task"
    )
    instruction = manifest.system_instruction
    tools: list[Any] = [create_folder, list_files, read_file, organize_file]
    if effective_mode == "chat":
        instruction = f"{instruction}{_CHAT_MODE_INSTRUCTION_SUFFIX}"
        tools = [list_files, search_files, read_file, write_file, create_folder, organize_file]
    return LlmAgent(
        name="files",
        mode=effective_mode,
        model=selected,
        description=manifest.description,
        instruction=instruction,
        tools=tools,
        output_schema=output_schema,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            max_output_tokens=manifest.performance.max_output_tokens,
            thinking_config=thinking_config_for(model_name, config.thinking_level, types),
        ),
    )
