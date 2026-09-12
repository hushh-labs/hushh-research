"""Public Location agent exports without eager ADK initialization.

The semantic command brain is a read-only model client and must remain safe to
import in the pre-traffic readiness job. The historical chat-agent exports
still load on demand for callers that use them.
"""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

_EXPORT_MODULES = {
    "LocationAgent": "agent",
    "get_location_chat_agent_v2": "agent",
}

__all__ = list(_EXPORT_MODULES)


def __getattr__(name: str) -> Any:
    module_name = _EXPORT_MODULES.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f"{__name__}.{module_name}"), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))


if TYPE_CHECKING:
    from .agent import (  # noqa: F401
        LocationAgent,
        get_location_chat_agent_v2,
    )
