"""Keep a pod turn admitted through the bridge's final background session write."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncGenerator, Callable
from contextlib import aclosing, asynccontextmanager
from typing import Any

from ag_ui.core import (
    BaseEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)

from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
from hushh_mcp.one_adk.mcp_turn_scope import McpTurnResources
from hushh_mcp.services.chat_key import current_request_chat_key, retain_request_chat_key
from hushh_mcp.services.pod_upgrade_admission import (
    ADMISSION,
    PodUpgradeInProgress,
    pod_incarnation,
)

logger = logging.getLogger(__name__)
_CLEANUP_TASKS: set[asyncio.Task] = set()
_POST_RUN_TASKS: set[asyncio.Task] = set()
_POST_RUN_LOCKS: dict[str, asyncio.Lock] = {}
_ACTIVE_THREADS: set[str] = set()
_THREAD_TERMINAL: set[str] = set()
_THREAD_SETTLED_EVENTS: dict[str, asyncio.Event] = {}


def _snapshot_has_assistant_text(event: BaseEvent) -> bool:
    for msg in getattr(event, "messages", None) or ():
        if getattr(msg, "role", None) != "assistant":
            continue
        content = getattr(msg, "content", None)
        if isinstance(content, str) and content.strip():
            return True
    return False


def _cleanup_finished(task: asyncio.Task) -> None:
    _CLEANUP_TASKS.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.error("pod_chat.cleanup_failed")


def _post_run_finished(task: asyncio.Task) -> None:
    _POST_RUN_TASKS.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.warning("pod_chat.post_run_failed")


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
        post_run: Any = None,
        mcp_owner_admission: Any = None,
    ) -> None:
        self._pod_require_access = require_access
        self._pod_runtime_scope = runtime_scope
        self._pod_background: set[asyncio.Task] = set()
        self._pod_hooks: set[asyncio.Task] = set()
        self._pod_started = False
        self._pod_before_run, self._pod_after_run, self._pod_post_run = (
            before_run,
            after_run,
            post_run,
        )
        self._pod_last_input: RunAgentInput | None = None
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
        from hushh_mcp.services.pod_owner_cloud import private_pod_runtime

        await self._pod_require_access()
        custody = await custody_configurations() if private_pod_runtime() else []
        await self._pod_require_access()
        admitted = (
            merge_turn_configurations(configurations or [], custody)
            if private_pod_runtime()
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
        permit_transferred = False
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

                post_run = getattr(self, "_pod_post_run", None)
                last_input = getattr(self, "_pod_last_input", None)
                if (
                    not cancel
                    and not self._pod_persistence_failed
                    and post_run is not None
                    and last_input is not None
                ):
                    holder = current_request_chat_key()
                    retained = holder.retain() if holder is not None else False
                    runtime_scope = self._pod_runtime_scope

                    async def _run_detached_post_run() -> None:
                        lock = _POST_RUN_LOCKS.setdefault(thread, asyncio.Lock())
                        try:
                            async with lock:
                                with runtime_scope():
                                    await post_run(last_input)
                        except Exception:
                            logger.warning("pod_chat.post_run_failed")
                        finally:
                            try:
                                await permit.release()
                            finally:
                                if retained and holder is not None:
                                    holder.release()
                                if not lock.locked() and _POST_RUN_LOCKS.get(thread) is lock:
                                    _POST_RUN_LOCKS.pop(thread, None)

                    try:
                        post_task = asyncio.create_task(_run_detached_post_run())
                    except BaseException:
                        if retained and holder is not None:
                            holder.release()
                        raise
                    _POST_RUN_TASKS.add(post_task)
                    post_task.add_done_callback(_post_run_finished)
                    permit_transferred = True
            finally:
                try:
                    if not permit_transferred:
                        await permit.release()
                finally:
                    _ACTIVE_THREADS.discard(thread)
                    _THREAD_TERMINAL.discard(thread)
                    settled_event = _THREAD_SETTLED_EVENTS.pop(thread, None)
                    if settled_event is not None:
                        settled_event.set()

    async def run(self, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        if self._pod_started:
            raise RuntimeError("Pod chat request cannot be reused.")
        self._pod_started = True
        self._pod_last_input = input
        await self._pod_require_access()
        if input.thread_id in _ACTIVE_THREADS and input.thread_id in _THREAD_TERMINAL:
            settled_event = _THREAD_SETTLED_EVENTS.get(input.thread_id)
            if settled_event is not None:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(settled_event.wait(), timeout=2.0)
        if input.thread_id in _ACTIVE_THREADS or len(_ACTIVE_THREADS) >= 8:
            yield RunErrorEvent(
                code="POD_CHAT_BUSY",
                message="Your private agent is finishing active work. Try again shortly.",
            )
            return
        _ACTIVE_THREADS.add(input.thread_id)
        _THREAD_TERMINAL.discard(input.thread_id)
        _THREAD_SETTLED_EVENTS[input.thread_id] = asyncio.Event()
        try:
            permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
        except PodUpgradeInProgress:
            _ACTIVE_THREADS.discard(input.thread_id)
            _THREAD_TERMINAL.discard(input.thread_id)
            ev = _THREAD_SETTLED_EVENTS.pop(input.thread_id, None)
            if ev is not None:
                ev.set()
            yield RunErrorEvent(
                code="POD_CHAT_UPDATING",
                message="Your private agent is updating. Check Software updates in Settings before trying again.",
            )
            return
        except BaseException:
            _ACTIVE_THREADS.discard(input.thread_id)
            _THREAD_TERMINAL.discard(input.thread_id)
            ev = _THREAD_SETTLED_EVENTS.pop(input.thread_id, None)
            if ev is not None:
                ev.set()
            raise
        terminal = False
        last_access_check = 0.0
        saw_run_started = False
        saw_assistant_text = False
        saw_server_tool_result = False
        saw_interrupt = False
        saw_error = False
        pending_tool_calls: set[str] = set()
        try:
            with self._pod_runtime_scope(), retain_request_chat_key():
                if self._pod_before_run is not None:
                    await self._run_hook(self._pod_before_run, input)
                async with aclosing(super().run(input)) as stream:
                    async for event in stream:
                        now = time.monotonic()
                        if (
                            last_access_check == 0.0
                            or event.type != EventType.TEXT_MESSAGE_CONTENT
                            or (now - last_access_check) >= 1.5
                        ):
                            await self._pod_require_access()
                            last_access_check = time.monotonic()
                        if event.type == EventType.RUN_STARTED:
                            saw_run_started = True
                        elif event.type in (
                            EventType.TEXT_MESSAGE_CONTENT,
                            EventType.TEXT_MESSAGE_CHUNK,
                        ):
                            if str(getattr(event, "delta", "") or ""):
                                saw_assistant_text = True
                        elif event.type == EventType.MESSAGES_SNAPSHOT:
                            if _snapshot_has_assistant_text(event):
                                saw_assistant_text = True
                        elif event.type == EventType.TOOL_CALL_START:
                            call_id = str(getattr(event, "tool_call_id", "") or "")
                            if call_id:
                                pending_tool_calls.add(call_id)
                        elif event.type == EventType.TOOL_CALL_RESULT:
                            saw_server_tool_result = True
                            call_id = str(getattr(event, "tool_call_id", "") or "")
                            pending_tool_calls.discard(call_id)
                        elif event.type == EventType.CUSTOM:
                            if "interrupt" in str(getattr(event, "name", "") or "").lower():
                                saw_interrupt = True
                        elif event.type == EventType.RUN_ERROR:
                            saw_error = True
                            _THREAD_TERMINAL.add(input.thread_id)
                        if event.type == EventType.RUN_FINISHED:
                            tasks = tuple(self._pod_background)
                            if tasks:
                                try:
                                    results = await asyncio.wait_for(
                                        asyncio.shield(
                                            asyncio.gather(*tasks, return_exceptions=True)
                                        ),
                                        timeout=10,
                                    )
                                    if any(isinstance(result, BaseException) for result in results):
                                        if saw_assistant_text:
                                            logger.warning(
                                                "pod_chat.background_degraded_after_stream"
                                            )
                                        else:
                                            self._pod_persistence_failed = True
                                except TimeoutError:
                                    if saw_assistant_text:
                                        logger.warning("pod_chat.background_timeout_after_stream")
                                    else:
                                        self._pod_persistence_failed = True
                            if self._pod_persistence_failed and not saw_assistant_text:
                                _THREAD_TERMINAL.add(input.thread_id)
                                yield RunErrorEvent(
                                    code="POD_CHAT_RECOVERY_FAILED",
                                    message="The answer could not be saved safely. Reconnect before continuing.",
                                )
                                return
                            if self._pod_after_run is not None:
                                if saw_assistant_text:
                                    try:
                                        await self._run_hook(self._pod_after_run, input)
                                    except Exception:  # noqa: BLE001 - never overwrite streamed answer
                                        logger.warning("pod_chat.after_run_degraded_after_stream")
                                else:
                                    await self._run_hook(self._pod_after_run, input)
                            if (
                                not saw_assistant_text
                                and not saw_error
                                and not saw_interrupt
                                and not pending_tool_calls
                                and (saw_server_tool_result or saw_run_started)
                            ):
                                fallback_id = f"msg_fallback_{input.run_id}"
                                fallback_text = (
                                    "I ran that step, but couldn't put together a final reply. "
                                    "Please try asking again."
                                )
                                yield TextMessageStartEvent(
                                    message_id=fallback_id, role="assistant"
                                )
                                yield TextMessageContentEvent(
                                    message_id=fallback_id, delta=fallback_text
                                )
                                yield TextMessageEndEvent(message_id=fallback_id)
                                saw_assistant_text = True
                            _THREAD_TERMINAL.add(input.thread_id)
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
