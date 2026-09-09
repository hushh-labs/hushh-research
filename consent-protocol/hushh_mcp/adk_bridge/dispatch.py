"""One shared specialist registry with invocation-local runtime dependencies."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterator

from hushh_mcp.adk_bridge.contract import A2ATask, SpecialistTurnResult

SpecialistHandler = Callable[[A2ATask], Awaitable[SpecialistTurnResult]]
SpecialistServiceHandler = Callable[[A2ATask, Any], Awaitable[SpecialistTurnResult]]


@dataclass(frozen=True)
class SpecialistRuntime:
    """Dependencies bound by authenticated ingress, never by model arguments."""

    owner_user_id: str
    require_access: Callable[[], Awaitable[None]]
    service_for: Callable[[str], Awaitable[Any]]


@dataclass(frozen=True)
class _Registration:
    handler: SpecialistHandler
    service_handler: SpecialistServiceHandler | None


_REGISTRY: dict[str, _Registration] = {}
_RUNTIME: ContextVar[SpecialistRuntime | None] = ContextVar("specialist_runtime", default=None)


def specialist_runtime_bound() -> bool:
    return _RUNTIME.get() is not None


@contextmanager
def bind_specialist_runtime(runtime: SpecialistRuntime) -> Iterator[None]:
    if not runtime.owner_user_id.strip():
        raise ValueError("specialist owner identity required")
    token = _RUNTIME.set(runtime)
    try:
        yield
    finally:
        _RUNTIME.reset(token)


def register_specialist(
    agent_id: str,
    handler: SpecialistHandler,
    *,
    service_handler: SpecialistServiceHandler | None = None,
) -> None:
    _REGISTRY[agent_id] = _Registration(handler, service_handler)


def is_wired_specialist(agent_id: str) -> bool:
    return agent_id in _REGISTRY


async def dispatch(agent_id: str, task: A2ATask) -> SpecialistTurnResult:
    runtime = _RUNTIME.get()
    if runtime is not None:
        if task.user_id != runtime.owner_user_id:
            raise PermissionError("specialist owner mismatch")
        if (
            task.authority is None
            or not task.authority.is_active_for(task.user_id)
            or not task.authority.invocation_capabilities
        ):
            raise PermissionError("specialist invocation authority required")
        await runtime.require_access()
    try:
        registered = _REGISTRY[agent_id]
    except KeyError as exc:
        raise KeyError(f"No A2A specialist registered for {agent_id!r}") from exc
    if runtime is None:
        return await registered.handler(task)
    if registered.service_handler is None:
        raise RuntimeError("specialist runtime dependencies unavailable")
    service = await runtime.service_for(agent_id)
    if service is None:
        raise RuntimeError("specialist runtime dependencies unavailable")
    result = await registered.service_handler(task, service)
    await runtime.require_access()
    return result
