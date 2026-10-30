"""Pinned native ADK task runner with ephemeral events and fresh handback context."""

from __future__ import annotations

import asyncio
from contextlib import aclosing
from dataclasses import dataclass
from uuid import uuid4

from google.adk.agents import LlmAgent
from google.adk.agents.run_config import RunConfig
from google.adk.models import Gemini
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.hushh_adk.manifest import AgentManifestV2
from hushh_mcp.hushh_adk.telemetry import private_telemetry
from hushh_mcp.one_adk.computer_use_agent import BrowserTaskResultV1, build_computer_use_agent
from hushh_mcp.runtime_providers.azure_browser_adk import AzureBrowserAdkModel
from hushh_mcp.runtime_providers.lifecycle import close_owned_adk_model

from .adk_history import require_completed_calls
from .contracts import BrowserRefused
from .control import BrowserControl
from .information import BrowserModelProcessing


@dataclass
class _NativeTask:
    control: BrowserControl
    sessions: InMemorySessionService
    session_id: str
    runner: Runner
    calls: int = 0
    segments: int = 0


class NativeAdkBrowserModel:
    """Model transport supplied by trusted native-model qualification wiring.

    Constructing this adapter does not qualify a provider or a cloud sandbox.
    Task runtime verifies the exact receipt before calling it. Explicit owner
    handback retains the same memory-only session at a completed call boundary,
    using a fresh invocation and observation. It never resubmits the goal or
    enables ADK's unanswered-tool replay. No manual-login observation reaches
    this session, One's transcript or the hub.
    """

    def __init__(self, manifest: AgentManifestV2, model: Gemini | AzureBrowserAdkModel) -> None:
        self._manifest, self._model = manifest, model
        self.model_name = model.model
        self.transport = f"{type(model).__module__}.{type(model).__qualname__}"
        self._tasks: dict[str, _NativeTask] = {}

    async def run(
        self, *, control: BrowserControl, processing: BrowserModelProcessing, goal: str
    ) -> BrowserTaskResultV1:
        if processing.task_goal != goal:
            raise BrowserRefused("BROWSER_PROCESSING_TERMS_MISMATCH")
        try:
            telemetry = private_telemetry().model_copy(
                update={"adk_experimental_telemetry_opt_in": False}
            )
        except ValueError:
            raise BrowserRefused("BROWSER_TELEMETRY_CONTENT_REFUSED") from None
        owner_id = control.binding.owner_id
        task_id = control.binding.task_id
        context = self._tasks.get(task_id)
        if context is None:
            agent = build_computer_use_agent(
                self._manifest,
                control=control,
                model=self._model,
                processing=processing,
                close_control=False,
            )
            sessions = InMemorySessionService()
            session_id = "browser_" + uuid4().hex
            await sessions.create_session(
                app_name="pod_browser", user_id=owner_id, session_id=session_id
            )
            context = _NativeTask(
                control,
                sessions,
                session_id,
                Runner(agent=agent, app_name="pod_browser", session_service=sessions),
            )
            self._tasks[task_id] = context
        if context.control is not control or context.calls >= 60:
            raise BrowserRefused("BROWSER_CONTINUATION_LIMIT")
        runner, sessions, session_id = context.runner, context.sessions, context.session_id
        retained_agent = runner.agent
        if not isinstance(retained_agent, LlmAgent):
            raise BrowserRefused("BROWSER_TASK_COMPOSITION_UNAVAILABLE")
        message = (
            await self._continuation_message(context, processing, retained_agent)
            if context.segments
            else types.Content(role="user", parts=[types.Part(text=goal)])
        )
        context.segments += 1
        result: BrowserTaskResultV1 | None = None
        try:
            with suppress_instrumentation():
                async with asyncio.timeout(900):
                    async with aclosing(
                        runner.run_async(
                            user_id=owner_id,
                            session_id=session_id,
                            # Explicit fresh ID prevents ADK from selecting an
                            # unfinished invocation and replaying its tool call.
                            invocation_id="browser_segment_" + uuid4().hex,
                            new_message=message,
                            run_config=RunConfig(
                                max_llm_calls=60 - context.calls, telemetry=telemetry
                            ),
                        )
                    ) as events:
                        async for event in events:
                            if (
                                event.content
                                and event.content.role == "model"
                                and not event.partial
                            ):
                                context.calls += 1
                            # Pinned ADK task completion is event.output,
                            # validated by finish_task. Drain the terminal event
                            # before closing so ADK releases its caller context.
                            if event.author == retained_agent.name and event.output is not None:
                                await control.require_model_observation()
                                result = BrowserTaskResultV1.model_validate(event.output)
            if result is None:
                raise BrowserRefused("BROWSER_MODEL_RESULT_MISSING")
            if result.outcome != "needs_owner":
                await self.release_task(control.binding)
            return result
        except asyncio.CancelledError:
            # The iterator joins before takeover can acknowledge. Keep history
            # for explicit handback at a completed-call boundary only.
            raise
        except BrowserRefused as exc:
            if exc.code not in {
                "BROWSER_MODEL_OBSERVATION_PAUSED",
                "BROWSER_OWNER_APPROVAL_REQUIRED",
            }:
                await self.release_task(control.binding)
            raise
        except Exception:
            await self.release_task(control.binding)
            raise

    async def _continuation_message(
        self, context: _NativeTask, processing: BrowserModelProcessing, agent: LlmAgent
    ) -> types.Content:
        control = context.control
        session = await context.sessions.get_session(
            app_name="pod_browser", user_id=control.binding.owner_id, session_id=context.session_id
        )
        if session is None:
            raise BrowserRefused("BROWSER_CONTINUATION_UNAVAILABLE")
        require_completed_calls(session.events)
        epoch = await control.require_model_observation()
        await processing.require()
        await control.require_model_observation(expected_epoch=epoch)
        frame = control.latest_frame
        if frame is None or frame.sequence != control.next_sequence - 1:
            raise BrowserRefused("BROWSER_CONTINUATION_UNAVAILABLE")
        for toolset in agent.tools:
            prepare = getattr(toolset, "prepare_continuation", None)
            if prepare is not None:
                await prepare()
        return types.Content(
            role="user",
            parts=[
                types.Part(
                    text="The owner has handed back this same browser task. Inspect the fresh screen, continue unfinished work, and do not repeat completed actions. Previously unanswered or uncertain effects are not authorized for replay."
                ),
                types.Part.from_bytes(data=frame.png, mime_type="image/png"),
            ],
        )

    async def release_task(self, binding) -> None:
        context = self._tasks.get(binding.task_id)
        if context is None:
            return
        if context.control.binding != binding:
            raise BrowserRefused("BROWSER_BINDING_REFUSED")
        try:
            async with asyncio.timeout(10):
                await context.runner.close()
                await context.sessions.delete_session(
                    app_name="pod_browser", user_id=binding.owner_id, session_id=context.session_id
                )
                await close_owned_adk_model(self._model)
        except BaseException:
            raise BrowserRefused("BROWSER_MODEL_STOP_UNCONFIRMED") from None
        self._tasks.pop(binding.task_id, None)
