"""Shared AG-UI construction with explicit session and runtime ownership."""

from __future__ import annotations

import inspect
import os
from collections.abc import Callable
from typing import Any

from ag_ui_adk.request_state_service import RequestStateSessionService
from ag_ui_adk.session_manager import SessionManager
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.google_llm import Gemini
from google.genai import types as genai_types

from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent

try:
    from google.adk.agents.context_cache_config import ContextCacheConfig
except ImportError:  # pragma: no cover - older google-adk runtimes lack ContextCacheConfig
    ContextCacheConfig = None  # type: ignore[assignment,misc]

_APP_ACCEPTS_CONTEXT_CACHE = "context_cache_config" in inspect.signature(App).parameters


def _adk_context_cache_config(root_agent: Any) -> Any | None:
    """Enable ADK implicit prompt/tool context caching only when supported on native Gemini."""
    if ContextCacheConfig is None or not _APP_ACCEPTS_CONTEXT_CACHE:
        return None
    if os.getenv("HUSHH_ADK_CONTEXT_CACHE_DISABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return None
    if os.getenv("PYTEST_CURRENT_TEST") and os.getenv("HUSHH_ADK_CONTEXT_CACHE_FORCE_TEST") != "1":
        return None
    model = getattr(root_agent, "model", None)
    supports_gemini_cache = (isinstance(model, str) and model.startswith("gemini-")) or (
        type(model) is Gemini and not getattr(model, "use_interactions_api", False)
    )
    if not supports_gemini_cache:
        return None
    params = inspect.signature(ContextCacheConfig).parameters
    kwargs: dict[str, Any] = {
        "min_tokens": 4096,
        "ttl_seconds": 1800,
        "cache_intervals": 10,
        "create_http_options": genai_types.HttpOptions(timeout=5000),
    }
    return ContextCacheConfig(**{k: v for k, v in kwargs.items() if k in params})


class _DurableSessionManager(SessionManager):
    """ag_ui_adk session manager without its idle-session sweeper.

    The library default re-reads every tracked session every five minutes from a
    background task, copies idle ones into an in-memory memory service, and then
    deletes them from storage twenty minutes after their last turn. For durable,
    person-key history that is both a background reader with no person present and
    a silent deletion of the person's history, so it never starts here.
    """

    async def _find_session_by_thread_id(
        self, app_name: str, user_id: str, thread_id: str
    ) -> Any | None:
        """Recover the exact owner-bound row without scanning encrypted history."""
        return await self.get_session(thread_id, app_name, user_id)

    def _start_cleanup_task(self) -> None:
        return None


_authenticated_capabilities = {
    "identity": {
        "name": "Agent One",
        "type": "google-adk",
        "description": "Hussh private agent",
        "version": "1.0.0",
        "provider": "Hussh",
    },
    "transport": {"streaming": True, "websocket": False, "httpBinary": False, "resumable": True},
    "tools": {"supported": True, "parallelCalls": False, "clientProvided": True},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": True},
    "multiAgent": {"supported": True, "delegation": True, "handoffs": False},
    "reasoning": {"supported": True, "streaming": True, "encrypted": False},
    "humanInTheLoop": {
        "supported": True,
        "approvals": True,
        "interventions": True,
        "feedback": False,
        "interrupts": True,
        "approveWithEdits": False,
    },
}


def build_authenticated_agui(
    root_agent: Any,
    session_service: Any,
    *,
    app_name: str,
    user_id_extractor: Any,
    agent_class: type[TimedADKAgent] = TimedADKAgent,
    max_concurrent_executions: int = 64,
    memory_service: Any = None,
    plugins: list | None = None,
) -> TimedADKAgent:
    cache_config = _adk_context_cache_config(root_agent)
    app_kwargs: dict[str, Any] = {
        "name": app_name,
        "root_agent": root_agent,
        "plugins": plugins or [],
        "resumability_config": ResumabilityConfig(is_resumable=True),
    }
    if cache_config is not None and _APP_ACCEPTS_CONTEXT_CACHE:
        app_kwargs["context_cache_config"] = cache_config
    return agent_class.from_app(
        App(**app_kwargs),
        head=HEAD_ONE,
        user_id_extractor=user_id_extractor,
        max_concurrent_executions=max_concurrent_executions,
        execution_timeout_seconds=200,
        session_manager=_DurableSessionManager(
            session_service=RequestStateSessionService(session_service),
            delete_session_on_cleanup=False,
            save_session_to_memory_on_cleanup=False,
            use_thread_id_as_session_id=True,
        ),
        use_in_memory_services=True,
        **({"memory_service": memory_service} if memory_service is not None else {}),
        use_thread_id_as_session_id=True,
        emit_messages_snapshot=True,
        capabilities=_authenticated_capabilities,
    )


class FirstUseAgent:
    """Stands in for an ``ADKAgent`` and builds the real one on first attribute use.

    ``add_adk_fastapi_endpoint`` takes a fallback agent at registration. A route
    whose resolver always selects a head never uses it, and this keeps registration
    from building one, and resolving its model, while the module is imported.
    """

    def __init__(self, build: Callable[[], Any]) -> None:
        self._build = build

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__") or name == "_build":  # protocol probes never build
            raise AttributeError(name)
        return getattr(self._build(), name)
