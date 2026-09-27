"""Pay the private agent's first-turn setup once per process, off the event loop.

Measured on production 2026-09-27 (revision ``consent-protocol-00190-neb``):
the first One chat turn in each gunicorn worker spent 3.6-41 s before its first
model call, while a later turn in the same worker spent 94 ms. ADK imports
provider modules lazily while building the first model request
(``contents._id_pairing_model_types`` pulls in the Anthropic and OpenAI SDKs,
about 1,800 modules) and does it on the event loop. A revocation timer due at
18:50:10.2 fired at 18:50:25.5, 5 ms before the stalled turn resumed: the
worker's whole event loop was blocked, not only that turn.

This runs one complete One text turn per process against a stub model with an
in-memory session, in a worker thread with its own event loop. It sends nothing
to a provider, reads and writes no stored session, and uses no credential. The
real turns that follow reuse what it loaded: imported modules, completed
Pydantic schemas and ADK's per-function declaration cache.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types as genai_types

logger = logging.getLogger(__name__)

WARMUP_USER_ID = "one-turn-warmup"
WARMUP_SESSION_ID = "one-turn-warmup"
# A stub turn never waits on the network; this only bounds an unexpected wait.
WARMUP_TIMEOUT_SECONDS = 120.0


class _WarmupLlm(BaseLlm):
    """Answers with one fixed text part and never reaches a provider."""

    calls: int = 0

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        del llm_request, stream
        self.calls += 1
        yield LlmResponse(
            content=genai_types.Content(role="model", parts=[genai_types.Part(text="ready")])
        )


async def _run_stub_turn() -> int:
    """Run one One text turn through ADK's Runner; return the stub model's call count."""
    from google.adk.agents.run_config import RunConfig
    from google.adk.apps import App, ResumabilityConfig
    from google.adk.runners import Runner
    from google.adk.sessions.in_memory_session_service import InMemorySessionService

    from hushh_mcp.hushh_adk.telemetry import private_telemetry
    from hushh_mcp.one_adk.agent_tree import _SPECIALIST_MODEL, ONE_APP_NAME, build_one_text_agent

    # The stub carries the real model id only as a label, so model-keyed
    # configuration (thinking level) resolves exactly as it does for Chat.
    model = _WarmupLlm(model=_SPECIALIST_MODEL)
    runner = Runner(
        app=App(
            name=ONE_APP_NAME,
            # Same construction as Agent Chat's authenticated head.
            root_agent=build_one_text_agent(
                model=model, allow_workspace_tools=True, include_thought_summaries=True
            ),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        session_service=InMemorySessionService(),
        auto_create_session=True,
    )
    try:
        async with asyncio.timeout(WARMUP_TIMEOUT_SECONDS):
            async for _event in runner.run_async(
                user_id=WARMUP_USER_ID,
                session_id=WARMUP_SESSION_ID,
                new_message=genai_types.Content(
                    role="user", parts=[genai_types.Part(text="warm up")]
                ),
                run_config=RunConfig(telemetry=private_telemetry()),
            ):
                pass
    finally:
        await runner.close()
    return model.calls


def warm_one_turn_path() -> bool:
    """Run the stub turn on a private event loop. Call it from a worker thread.

    Returns whether the stub model was reached, which proves the whole pre-model
    path ran. Marks the process warmed for the turn timing line on success.
    """
    from hushh_mcp.one_adk.agui_turn_timing import mark_turn_path_warmed

    reached = asyncio.run(_run_stub_turn()) > 0
    if reached:
        mark_turn_path_warmed()
    return reached


async def warm_one_turn_path_in_background() -> None:
    """Startup entry: never blocks the event loop and never raises."""
    started_at = time.perf_counter()
    try:
        reached = await asyncio.to_thread(warm_one_turn_path)
    except Exception as exc:  # noqa: BLE001 - a failed warmup leaves the lazy path
        logger.warning("startup.one_turn_path_warm_failed reason=%s", type(exc).__name__)
        return
    logger.info(
        "startup.one_turn_path_warmed reached_model=%s duration_ms=%.0f",
        reached,
        (time.perf_counter() - started_at) * 1000,
    )


__all__ = ["warm_one_turn_path", "warm_one_turn_path_in_background"]
