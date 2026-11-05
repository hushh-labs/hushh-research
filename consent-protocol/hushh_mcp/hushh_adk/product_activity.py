"""Payload-blind SDK observation plugin. No callback alters agent execution."""

from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace

from google.adk.plugins.base_plugin import BasePlugin

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services import product_activity as sink
from hushh_mcp.services.plg_catalog import action_descriptor, runtime_descriptor

_capacity = threading.BoundedSemaphore(4)


def _owner(context) -> str | None:
    """SDK session identifiers alone are not authenticated owner evidence."""
    host = HushhContext.current()
    if host and sink.enabled_for(host.user_id):
        from hushh_mcp.consent.token import validate_token

        valid, _, token = validate_token(host.consent_token)
        if valid and token is not None and token.user_id == host.user_id:
            return str(host.user_id)
    # The canonical AG-UI ingress replaces client state after vault-owner
    # validation. Anonymous/Firebase-only intro never receives this admission.
    if context.state.get("temp:hussh:workspace_chat_admission") is True:
        uid = context.state.get("hussh:user_id")
        if isinstance(uid, str) and uid == context.user_id and sink.enabled_for(uid):
            return uid
    return None


class ProductActivityPlugin(BasePlugin):
    def __init__(self, owner_agent_id: str | None = None):
        super().__init__(name="product_activity_observations")
        self.owner_agent_id = owner_agent_id
        self._runs: dict[tuple[str, str], tuple[float, str | None]] = {}

    async def before_run_callback(self, *, invocation_context):
        # Pin once before execution. Sibling callback tasks and late callbacks
        # must never discover a new epoch after an account reset.
        context = SimpleNamespace(
            user_id=invocation_context.user_id, state=invocation_context.session.state
        )
        try:
            uid = _owner(context)
            if not uid:
                return None
            now = time.monotonic()
            self._runs = {key: value for key, value in self._runs.items() if now - value[0] < 3600}
            key = (uid, invocation_context.invocation_id)
            if key in self._runs or len(self._runs) >= 512:
                return None
            self._runs[key] = (now, None)

            def admit():
                if not _capacity.acquire(blocking=False):
                    return None
                try:
                    return sink.admission(uid)
                finally:
                    _capacity.release()

            admitted = await asyncio.wait_for(asyncio.to_thread(admit), timeout=0.3)
            if admitted and key in self._runs:
                self._runs[key] = (now, admitted["generation"])
        except Exception:  # noqa: BLE001 - observation failures cannot change execution
            pass
        return None

    async def after_run_callback(self, *, invocation_context):
        invocation = invocation_context.invocation_id
        self._runs = {key: value for key, value in self._runs.items() if key[1] != invocation}

    async def _emit(self, context, phase: str, tool_name: str | None = None):
        # Check collection before resolving identity, catalogs or a database.
        if not sink.enabled_for(str(getattr(context, "user_id", ""))):
            host = HushhContext.current()
            if host is None or not sink.enabled_for(host.user_id):
                return
        try:
            uid = _owner(context)
            descriptor = runtime_descriptor(context.agent_name, tool_name)
            if descriptor is None and self.owner_agent_id:
                descriptor = action_descriptor(
                    ("runtime-tool:" if tool_name else "agent:") + self.owner_agent_id
                )
            if not uid or not descriptor:
                return
            captured = self._runs.get((uid, context.invocation_id))
            if captured is None or captured[1] is None:
                return

            def persist():
                if not _capacity.acquire(blocking=False):
                    return
                try:
                    operation = (
                        context.function_call_id if tool_name is not None else context.invocation_id
                    )
                    sink.observe(
                        uid,
                        captured[1],
                        descriptor["id"],
                        phase,
                        "execution_observed",
                        str(operation),
                    )
                finally:
                    _capacity.release()

            await asyncio.wait_for(asyncio.to_thread(persist), timeout=0.3)
        except Exception:  # noqa: BLE001 - best-effort metadata never changes product execution
            return

    async def before_agent_callback(self, *, agent, callback_context):
        await self._emit(callback_context, "started")
        return None

    async def after_agent_callback(self, *, agent, callback_context):
        await self._emit(callback_context, "returned")
        return None

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        await self._emit(tool_context, "started", tool.name)
        return None

    async def after_tool_callback(self, *, tool, tool_args, tool_context, result):
        # Returned means returned. Neither result contents nor model meaning
        # are inspected to claim that an external operation succeeded.
        await self._emit(tool_context, "returned", tool.name)
        return None

    async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error):
        await self._emit(tool_context, "failed", tool.name)
        return None

    async def on_model_error_callback(self, *, callback_context, llm_request, error):
        await self._emit(callback_context, "failed")
        return None


def product_activity_plugins(owner_agent_id: str | None = None) -> list[BasePlugin]:
    return [ProductActivityPlugin(owner_agent_id)]
