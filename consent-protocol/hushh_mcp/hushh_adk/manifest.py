"""
Hushh ADK Manifest

Defines the configuration schema for Hushh Agents.
This serves as the robust Source of Truth for:
1. ADK Agent Construction (Model, System Prompt)
2. MCP Server Capability Reporting
3. Frontend UI Capability Flags
"""

import os
from typing import List, Optional

import yaml
from pydantic import BaseModel, Field

from hushh_mcp.constants import GEMINI_MODEL


class AgentToolConfig(BaseModel):
    name: str
    description: str
    py_func: str  # Path to python function e.g. "hushh_mcp.operons.food.recommend"
    required_scope: str


class AgentInputConfig(BaseModel):
    name: str
    type: str


class AgentOutputConfig(BaseModel):
    name: str
    type: str


class AgentModelConfig(BaseModel):
    provider: str = "gemini"
    name: str = GEMINI_MODEL
    mode: str = "byok"
    credential_ref: str = "pkm:runtime_secrets.llm.gemini_api_key"


class AgentManifest(BaseModel):
    id: str
    name: str
    version: str = "1.0.0"
    description: str
    model: AgentModelConfig | str = Field(default_factory=AgentModelConfig)
    system_instruction: str

    required_scopes: List[str] = Field(default_factory=list)
    tools: List[AgentToolConfig] = Field(default_factory=list)
    inputs: List[AgentInputConfig] = Field(default_factory=list)
    outputs: List[AgentOutputConfig] = Field(default_factory=list)

    # Metadata for UI/Behavior
    ui_type: Optional[str] = "chat"  # chat, form, dashboard
    icon: Optional[str] = None

    def model_config_for_runtime(self) -> AgentModelConfig:
        if isinstance(self.model, str):
            return AgentModelConfig(name=self.model)
        return self.model


class ManifestLoader:
    @staticmethod
    def load(path: str) -> AgentManifest:
        """Load manifest from a YAML file."""
        if not os.path.exists(path):
            raise FileNotFoundError(f"Manifest not found at {path}")

        with open(path, "r") as f:
            data = yaml.safe_load(f)

        return AgentManifest(**data)
