"""Public ADK exports without eager runtime-security initialization.

Manifest-only consumers, such as the synthetic PKM evaluator, must not load
the consent-token runtime merely by importing :mod:`hushh_mcp.hushh_adk`.
"""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .context import HushhContext
    from .core import HushhAgent
    from .manifest import AgentManifest, AgentManifestV2, ManifestLoader
    from .tools import hushh_tool

__all__ = [
    "HushhAgent",
    "HushhContext",
    "hushh_tool",
    "ManifestLoader",
    "AgentManifest",
    "AgentManifestV2",
]

_EXPORT_MODULES = {
    "HushhAgent": ".core",
    "HushhContext": ".context",
    "hushh_tool": ".tools",
    "ManifestLoader": ".manifest",
    "AgentManifest": ".manifest",
    "AgentManifestV2": ".manifest",
}


def __getattr__(name: str) -> Any:
    """Resolve public exports only when the caller needs that surface."""
    module_name = _EXPORT_MODULES.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module_name, __name__), name)
    globals()[name] = value
    return value
