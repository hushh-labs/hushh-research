"""
Hushh ADK Manifest

Defines the configuration schema for Hushh Agents.
This serves as the robust Source of Truth for:
1. ADK Agent Construction (Model, System Prompt)
2. MCP Server Capability Reporting
3. Frontend UI Capability Flags
"""

import os
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, Field, ValidationError

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


class AgentManifest(BaseModel):
    id: str
    name: str
    version: str = "1.0.0"
    description: str
    model: str = GEMINI_MODEL  # Standardized default model
    system_instruction: str

    required_scopes: List[str] = Field(default_factory=list)
    tools: List[AgentToolConfig] = Field(default_factory=list)
    inputs: List[AgentInputConfig] = Field(default_factory=list)
    outputs: List[AgentOutputConfig] = Field(default_factory=list)

    # Metadata for UI/Behavior
    ui_type: Optional[str] = "chat"  # chat, form, dashboard
    icon: Optional[str] = None

    def tool_py_funcs(self) -> List[str]:
        """Return the list of dotted Python import paths for all declared tools."""
        return [t.py_func for t in self.tools]

    def required_scope_strings(self) -> List[str]:
        """Return deduplicated required_scopes from both the agent and its tools."""
        seen: set[str] = set()
        out: list[str] = []
        for scope in self.required_scopes:
            if scope not in seen:
                seen.add(scope)
                out.append(scope)
        for tool in self.tools:
            if tool.required_scope not in seen:
                seen.add(tool.required_scope)
                out.append(tool.required_scope)
        return out


class ManifestLoader:
    @staticmethod
    def load(path: str) -> AgentManifest:
        """
        Load an AgentManifest from a YAML file.

        Raises:
            FileNotFoundError: if the file does not exist.
            ValueError: if the YAML is malformed or fails schema validation.
        """
        if not os.path.exists(path):
            raise FileNotFoundError(f"Manifest not found at {path}")

        try:
            with open(path, "r") as f:
                data = yaml.safe_load(f)
        except yaml.YAMLError as exc:
            raise ValueError(f"Malformed YAML in manifest '{path}': {exc}") from exc

        if not isinstance(data, dict):
            raise ValueError(
                f"Manifest '{path}' must be a YAML mapping at the top level, "
                f"got {type(data).__name__}"
            )

        return ManifestLoader.load_from_dict(data, source=path)

    @staticmethod
    def load_from_dict(data: Dict[str, Any], *, source: str = "<dict>") -> AgentManifest:
        """
        Construct an AgentManifest from a plain dictionary.

        Useful for testing and for loading manifests that arrive as JSON/dict
        payloads rather than from the filesystem.

        Args:
            data: A dict whose keys match the AgentManifest schema.
            source: Human-readable label used in error messages (e.g. file path).

        Raises:
            ValueError: if the dict fails Pydantic schema validation.
        """
        try:
            return AgentManifest(**data)
        except (ValidationError, TypeError) as exc:
            raise ValueError(f"Invalid manifest data from '{source}': {exc}") from exc
