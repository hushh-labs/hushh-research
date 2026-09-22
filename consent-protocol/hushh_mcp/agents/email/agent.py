"""Manifest-backed Email Agent builder used by direct and delegated turns."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence

from google.adk.tools.base_tool import BaseTool

from hushh_mcp.hushh_adk.core import HushhAgent
from hushh_mcp.hushh_adk.manifest import ManifestLoader


class EmailAgent(HushhAgent):
    """The single Email specialist for inbox and synced Gmail receipts."""

    manifest: Any = None
    hushh_tools: Any = None

    def __init__(
        self, *, tools: Sequence[BaseTool] | None = None, model: Any | None = None
    ) -> None:
        manifest = ManifestLoader.load(str(Path(__file__).with_name("agent.yaml")))
        selected_tools = list(tools or [])
        super().__init__(
            name=manifest.name,
            model=model if model is not None else manifest.model,
            system_prompt=manifest.system_instruction,
            required_scopes=manifest.required_scopes,
            mode=manifest.runtime.adk_mode,
        )
        self.manifest = manifest
        self.hushh_tools = selected_tools


def build_email_agent(*, tools: Sequence[BaseTool], model: Any | None = None) -> EmailAgent:
    """Build Email with the caller's owner-bound, read-only tool set."""
    if not tools:
        raise ValueError("Email requires at least one owner-bound tool")
    return EmailAgent(tools=tools, model=model)
