"""Pinned native ADK task runner with ephemeral events and fresh handback context."""

from __future__ import annotations

import asyncio
import logging
from contextlib import aclosing
from uuid import uuid4

from google.adk.agents.run_config import RunConfig
from google.adk.models import Gemini
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.telemetry.context import ContentCapturingMode, TelemetryConfig
from google.genai import types
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.hushh_adk.manifest import AgentManifestV2
from hushh_mcp.one_adk.computer_use_agent import BrowserTaskResultV1, build_computer_use_agent

from .contracts import BrowserRefused
from .control import BrowserControl
from .information import BrowserModelProcessing


class NativeAdkBrowserModel:
    """Model transport supplied by trusted native-model qualification wiring.

    Constructing this adapter does not qualify a provider or a cloud sandbox.
    Task runtime verifies the exact receipt before calling it. A fresh ADK
    session on each explicit continuation drops buffered login/previous-epoch
    screenshots. No screenshot, event, URL or provider exception reaches One's
    durable conversational session.
    """

    def __init__(self, manifest: AgentManifestV2, model: Gemini) -> None:
        self._manifest, self._model = manifest, model
        self.model_name = model.model
        self.transport = f"{type(model).__module__}.{type(model).__qualname__}"

    async def run(
        self, *, control: BrowserControl, processing: BrowserModelProcessing, goal: str
    ) -> BrowserTaskResultV1:
        if processing.task_goal != goal:
            raise BrowserRefused("BROWSER_PROCESSING_TERMS_MISMATCH")
        telemetry = TelemetryConfig(
            capture_message_content=ContentCapturingMode.NO_CONTENT,
            adk_experimental_telemetry_opt_in=False,
        )
        if any(
            (
                telemetry.should_add_content_to_logs,
                telemetry.should_add_content_to_legacy_spans,
                telemetry.should_add_content_to_experimental_spans,
            )
        ) or any(
            logging.getLogger(name).isEnabledFor(logging.DEBUG)
            for name in (
                "google.adk.models.google_llm",
                "google_adk.google.adk.models.google_llm",
                "google.genai._api_client",
                "google_genai._api_client",
                "google_genai.models",
                "httpx",
                "httpcore",
            )
        ):
            raise BrowserRefused("BROWSER_TELEMETRY_CONTENT_REFUSED")
        agent = build_computer_use_agent(
            self._manifest,
            control=control,
            model=self._model,
            processing=processing,
            close_control=False,
        )
        sessions = InMemorySessionService()
        session_id = "browser_" + uuid4().hex
        app_name = "pod_browser"
        owner_id = control.binding.owner_id
        await sessions.create_session(app_name=app_name, user_id=owner_id, session_id=session_id)
        runner = Runner(agent=agent, app_name=app_name, session_service=sessions)
        result: BrowserTaskResultV1 | None = None
        try:
            with suppress_instrumentation():
                async with asyncio.timeout(900):
                    async with aclosing(
                        runner.run_async(
                            user_id=owner_id,
                            session_id=session_id,
                            new_message=types.Content(role="user", parts=[types.Part(text=goal)]),
                            run_config=RunConfig(max_llm_calls=60, telemetry=telemetry),
                        )
                    ) as events:
                        async for event in events:
                            # Pinned ADK task completion is event.output,
                            # validated by finish_task. Drain the terminal event
                            # before closing so ADK releases its caller context.
                            if event.author == agent.name and event.output is not None:
                                await control.require_model_observation()
                                result = BrowserTaskResultV1.model_validate(event.output)
            if result is None:
                raise BrowserRefused("BROWSER_MODEL_RESULT_MISSING")
            return result
        finally:
            try:
                try:
                    async with asyncio.timeout(10):
                        await runner.close()
                finally:
                    await sessions.delete_session(
                        app_name=app_name, user_id=owner_id, session_id=session_id
                    )
            except BaseException:
                # A failed cleanup is distinct from a model failure: the pod
                # must keep its update permit until shutdown can be proved.
                raise BrowserRefused("BROWSER_MODEL_STOP_UNCONFIRMED") from None
