"""Keep a pod turn admitted through the bridge's final background session write."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator, Callable
from contextlib import aclosing, asynccontextmanager
from typing import Any

from ag_ui.core import BaseEvent, EventType, RunAgentInput, RunErrorEvent

from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
from hushh_mcp.one_adk.mcp_turn_scope import McpTurnResources
from hushh_mcp.services.chat_key import retain_request_chat_key
from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

logger = logging.getLogger(__name__)
_CLEANUP_TASKS: set[asyncio.Task] = set()
_ACTIVE_THREADS: set[str] = set()


def _cleanup_finished(task: asyncio.Task) -> None:
    _CLEANUP_TASKS.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.error("pod_chat.cleanup_failed")


class PodTimedADKAgent(TimedADKAgent):
    """Request-scoped agent; no credentials or decrypted sessions survive it.

    The SDK sends its terminal event before runner cleanup and LRO persistence.
    Retain the existing turn permit until those tasks have settled, even if the
    browser closes immediately after the terminal event. Track the tasks directly:
    the SDK execution registry can remove them on an interrupted stream.
    """

    def configure_pod_turn(
        self,
        *,
        require_access: Any,
        runtime_scope: Callable,
        before_run: Any = None,
        after_run: Any = None,
        mcp_owner_admission: Any = None,
    ) -> None:
        self._pod_require_access = require_access
        self._pod_runtime_scope = runtime_scope
        self._pod_background: set[asyncio.Task] = set()
        self._pod_hooks: set[asyncio.Task] = set()
        self._pod_started = False
        self._pod_before_run, self._pod_after_run = before_run, after_run
        self._pod_persistence_failed = False
        self._pod_mcp_scope: McpTurnResources | None = None
        self._pod_mcp_owner_admission = mcp_owner_admission

    @asynccontextmanager
    async def _mcp_turn_resources(self, conversation_id: str, *, owner_id, configurations):
        from hushh_mcp.one_adk.mcp_turn_scope import McpTurnResources, bind_mcp_turn
        from hushh_mcp.one_adk.pod_custody_mcp import (
            custody_configuration_admissions,
            custody_configurations,
            merge_turn_configurations,
        )
        from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

        await self._pod_require_access()
        custody = await custody_configurations() if owner_cloud_agent() else []
        await self._pod_require_access()
        admitted = (
            merge_turn_configurations(configurations or [], custody)
            if owner_cloud_agent()
            else configurations or []
        )
        self._pod_mcp_scope = McpTurnResources(
            conversation_id,
            owner_id=owner_id,
            configurations=admitted,
            owner_admission=self._pod_mcp_owner_admission,
            configuration_admissions=custody_configuration_admissions(custody),
            vault_only=True,
        )
        with bind_mcp_turn(self._pod_mcp_scope):
            yield self._pod_mcp_scope
        # _settle closes after all producer tasks; closing on generator exit
        # could clear credentials while an admitted tool still uses them.

    async def _run_hook(self, callback: Any, input: RunAgentInput) -> None:
        async def admitted():
            with self._pod_runtime_scope(), retain_request_chat_key():
                await callback(input)

        task = asyncio.create_task(admitted())
        self._pod_hooks.add(task)
        # Memory Bank owns admitted external work and may shield its provider
        # acknowledgement. Preserve the whole hook until that receipt settles.
        await asyncio.shield(task)

    async def _run_adk_in_background(self, *args: Any, **kwargs: Any) -> Any:
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("Pod chat requires an active task.")
        self._pod_background.add(task)
        try:
            with self._pod_runtime_scope():
                await self._pod_require_access()
                return await super()._run_adk_in_background(*args, **kwargs)
        finally:
            self._pod_background.discard(task)

    async def _store_lro_id_remap(self, remap, session_id, app_name, user_id) -> None:
        # The SDK suppresses this write's exceptions. Use its existing session
        # contract and retain an explicit failure so RUN_FINISHED cannot lie.
        from google.adk.events import Event, EventActions

        try:
            await self._pod_require_access()
            session = await self._request_state_service.get_session(
                session_id=session_id, app_name=app_name, user_id=user_id
            )
            if session is None:
                raise RuntimeError("Pod conversation recovery unavailable.")
            existing = session.state.get("lro_tool_call_id_remap") or {}
            if not isinstance(existing, dict):
                raise RuntimeError("Pod conversation recovery invalid.")
            await self._request_state_service.append_event(
                session,
                Event(
                    author="user",
                    actions=EventActions(
                        state_delta={
                            "lro_tool_call_id_remap": {**existing, **remap},
                        }
                    ),
                ),
            )
        except Exception:
            self._pod_persistence_failed = True
            raise RuntimeError("Pod conversation recovery write failed.") from None

    async def _settle(self, *, cancel: bool, permit: Any, thread: str) -> None:
        with retain_request_chat_key():
            try:
                tasks = tuple(self._pod_background)
                if cancel:
                    for task in tasks:
                        task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                if self._pod_hooks:
                    await asyncio.gather(*self._pod_hooks, return_exceptions=True)
                if self._pod_mcp_scope is not None:
                    await self._pod_mcp_scope.close()
                await self.close()
            finally:
                try:
                    await permit.release()
                finally:
                    _ACTIVE_THREADS.discard(thread)

    async def run(self, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        if self._pod_started:
            raise RuntimeError("Pod chat request cannot be reused.")
        self._pod_started = True
        await self._pod_require_access()
        if input.thread_id in _ACTIVE_THREADS or len(_ACTIVE_THREADS) >= 8:
            yield RunErrorEvent(
                code="POD_CHAT_BUSY",
                message="Your private agent is finishing active work. Try again shortly.",
            )
            return
        _ACTIVE_THREADS.add(input.thread_id)
        try:
            permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
        except BaseException:
            _ACTIVE_THREADS.discard(input.thread_id)
            raise
        terminal = False
        try:
            with self._pod_runtime_scope(), retain_request_chat_key():
                if self._pod_before_run is not None:
                    await self._run_hook(self._pod_before_run, input)
                async with aclosing(super().run(input)) as stream:
                    async for event in stream:
                        await self._pod_require_access()
                        if event.type == EventType.RUN_FINISHED:
                            tasks = tuple(self._pod_background)
                            if tasks:
                                results = await asyncio.wait_for(
                                    asyncio.shield(asyncio.gather(*tasks, return_exceptions=True)),
                                    timeout=10,
                                )
                                if any(isinstance(result, BaseException) for result in results):
                                    self._pod_persistence_failed = True
                            if self._pod_persistence_failed:
                                yield RunErrorEvent(
                                    code="POD_CHAT_RECOVERY_FAILED",
                                    message="The answer could not be saved safely. Reconnect before continuing.",
                                )
                                return
                            if self._pod_after_run is not None:
                                await self._run_hook(self._pod_after_run, input)
                            terminal = True
                        yield event
        finally:
            cleanup = asyncio.create_task(
                self._settle(cancel=not terminal, permit=permit, thread=input.thread_id)
            )
            _CLEANUP_TASKS.add(cleanup)
            cleanup.add_done_callback(_cleanup_finished)
            try:
                await asyncio.wait_for(asyncio.shield(cleanup), timeout=10)
            except TimeoutError:
                # Keep the permit held while any cancellation-resistant producer
                # is still running. Update handoff must never report false idle.
                logger.error("pod_chat.cleanup_pending update_handoff=held")
