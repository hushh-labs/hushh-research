"""In-process A2A dispatch seam.

Slice 1: a Python call. To go network-A2A later, replace ``dispatch`` with an
HTTP client keyed by ``agent_id``; the contract (contract.py) is unchanged.
"""

from __future__ import annotations

from typing import Awaitable, Callable

from hushh_mcp.adk_bridge.contract import A2ATask, SpecialistTurnResult

SpecialistHandler = Callable[[A2ATask], Awaitable[SpecialistTurnResult]]

_REGISTRY: dict[str, SpecialistHandler] = {}


def register_specialist(agent_id: str, handler: SpecialistHandler) -> None:
    _REGISTRY[agent_id] = handler


def is_wired_specialist(agent_id: str) -> bool:
    return agent_id in _REGISTRY


async def dispatch(agent_id: str, task: A2ATask) -> SpecialistTurnResult:
    try:
        handler = _REGISTRY[agent_id]
    except KeyError as exc:
        raise KeyError(f"No A2A specialist registered for {agent_id!r}") from exc
    return await handler(task)
