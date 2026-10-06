"""Manifest-owned native browser specialist. No ambient executor or model fallback."""

from __future__ import annotations

import os
from typing import Any, Literal

from google.adk.agents import LlmAgent
from google.adk.models import Gemini
from google.adk.tools.computer_use.computer_use_toolset import ComputerUseToolset
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.hushh_adk.manifest import AgentManifestV2
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    thinking_config_for,
)
from hushh_mcp.services.pod_browser.adk_computer import PodComputer
from hushh_mcp.services.pod_browser.contracts import BrowserRefused
from hushh_mcp.services.pod_browser.control import BrowserControl


class BrowserTaskResultV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["completed", "needs_owner", "unavailable", "outcome_uncertain", "cancelled"]
    summary: str = Field(min_length=1, max_length=2000)


def build_computer_use_agent(
    manifest: AgentManifestV2,
    *,
    control: BrowserControl,
    model: Any,
) -> LlmAgent:
    if os.getenv("POD_COMPUTER_USE_ENABLED", "").lower() not in {"1", "true"}:
        raise BrowserRefused("BROWSER_DISABLED")
    # This receipt is supplied by a trusted capability probe for the exact native
    # model transport. Function-only translation is insufficient. No ambient
    # One/Puppy model is substituted when ComputerUse configuration is unsupported.
    control.readiness.require_ready()
    if not isinstance(model, Gemini):
        raise BrowserRefused("BROWSER_MODEL_TRANSPORT_UNSUPPORTED")
    model_name = model.model
    transport = f"{type(model).__module__}.{type(model).__qualname__}"
    if control.readiness.model_name != model_name or control.readiness.model_transport != transport:
        raise BrowserRefused("BROWSER_MODEL_TRANSPORT_UNVERIFIED")
    if model_name not in {"gemini-3.7-flash", "gemini-3.6-flash"}:
        raise BrowserRefused("BROWSER_MODEL_UNSUPPORTED")
    config = manifest.model_config_for_runtime()
    return LlmAgent(
        name="computer_use",
        mode="task",
        model=model,
        description=manifest.description,
        instruction=manifest.system_instruction,
        tools=[
            ComputerUseToolset(
                computer=PodComputer(control),
                excluded_predefined_functions=["initialize", "search"],
            )
        ],
        output_schema=BrowserTaskResultV1,
        generate_content_config=build_generate_content_config(
            types,
            model_name,
            max_output_tokens=manifest.performance.max_output_tokens,
            thinking_config=thinking_config_for(
                model_name,
                config.thinking_level,
                types,
            ),
        ),
    )
