"""Tests for ADK 2.14 harness performance optimizations and lifecycle guarantees."""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock

from ag_ui.core import RunFinishedEvent, TextMessageContentEvent
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.tools.base_tool import BaseTool
from google.genai import types as genai_types

from hushh_mcp.one_adk import pod_agui_lifetime as pod
from hushh_mcp.one_adk.agui_factory import _adk_context_cache_config
from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
from hushh_mcp.one_adk.tool_scoping import scope_leaf_tools_before_model
from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission
from tests.helpers.agui_lifetime import _input


async def test_stream_throttles_per_token_access_checks_but_checks_terminal_events(monkeypatch):
    monkeypatch.setattr(pod, "ADMISSION", PodUpgradeAdmission(log_resolver=lambda: None))
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "synthetic")
    require_access = AsyncMock()
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.close = AsyncMock()
    agent.configure_pod_turn(require_access=require_access, runtime_scope=nullcontext)

    async def sdk(self, input):
        for i in range(40):
            yield TextMessageContentEvent(message_id=f"m-{i}", delta="x")
        yield RunFinishedEvent(thread_id=input.thread_id, run_id=input.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", sdk)
    events = [event async for event in agent.run(_input())]
    assert len(events) == 41
    # Initial pre-stream check + 1st delta + terminal RUN_FINISHED = 3 calls (not 42).
    assert require_access.await_count <= 4


async def test_post_run_runs_in_settle_after_run_finished_while_holding_admission(monkeypatch):
    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    monkeypatch.setattr(pod, "ADMISSION", admission)
    monkeypatch.setattr(pod, "pod_incarnation", lambda: "synthetic")
    ran_after_yield: list[int] = []
    yielded_finished = False
    post_started, post_release = asyncio.Event(), asyncio.Event()

    async def after_snapshot(_input):
        assert not yielded_finished

    async def post_memory(_input):
        assert yielded_finished
        post_started.set()
        await post_release.wait()
        ran_after_yield.append((await admission.status(incarnation="synthetic"))["activeWork"])

    async def sdk(self, input):
        yield RunFinishedEvent(thread_id=input.thread_id, run_id=input.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", sdk)
    agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    agent.close = AsyncMock()
    agent.configure_pod_turn(
        require_access=AsyncMock(),
        runtime_scope=nullcontext,
        after_run=after_snapshot,
        post_run=post_memory,
    )

    iterator = agent.run(_input())
    event = await anext(iterator)
    assert isinstance(event, RunFinishedEvent)
    yielded_finished = True
    assert not post_started.is_set()

    finishing = asyncio.create_task(iterator.aclose())
    await asyncio.wait_for(post_started.wait(), 2)
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 1
    post_release.set()
    await asyncio.wait_for(finishing, 2)
    assert ran_after_yield == [1]
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 0


def test_context_cache_config_targets_native_gemini_only(monkeypatch):
    monkeypatch.setenv("HUSHH_ADK_CONTEXT_CACHE_FORCE_TEST", "1")
    monkeypatch.delenv("HUSHH_ADK_CONTEXT_CACHE_DISABLED", raising=False)

    assert _adk_context_cache_config(SimpleNamespace(model="gemini-2.5-flash")) is not None
    gemini_model = Gemini.model_construct(model="gemini-2.5-flash")
    assert _adk_context_cache_config(SimpleNamespace(model=gemini_model)) is not None

    class CustomLlm(Gemini):
        pass

    assert (
        _adk_context_cache_config(SimpleNamespace(model=CustomLlm.model_construct(model="x")))
        is None
    )
    assert _adk_context_cache_config(SimpleNamespace(model=object())) is None

    monkeypatch.setenv("HUSHH_ADK_CONTEXT_CACHE_DISABLED", "1")
    assert _adk_context_cache_config(SimpleNamespace(model=gemini_model)) is None


def test_scope_leaf_tools_prunes_unrelated_domains_and_keeps_history():
    core_padding = [f"core_tool_{i}" for i in range(25)]
    all_names = [
        *core_padding,
        "run_app_action",
        "ask_consent_agent",
        "calendar_summary",
        "propose_calendar_event",
        "list_my_location_circles",
        "create_drive_file",
        "list_active_grants",
    ]
    tool = genai_types.Tool(
        function_declarations=[
            genai_types.FunctionDeclaration(name=name, description=name) for name in all_names
        ]
    )

    class _StubTool(BaseTool):
        def __init__(self, tool_name: str) -> None:
            super().__init__(name=tool_name, description=tool_name)

    def make_request(text: str, *, history_tool: str | None = None) -> LlmRequest:
        parts = [genai_types.Part(text=text)]
        contents = [genai_types.Content(role="user", parts=parts)]
        if history_tool:
            contents.insert(
                0,
                genai_types.Content(
                    role="model",
                    parts=[
                        genai_types.Part(
                            function_call=genai_types.FunctionCall(name=history_tool, args={})
                        )
                    ],
                ),
            )
        return LlmRequest(
            model="gemini-2.5-flash",
            contents=contents,
            config=genai_types.GenerateContentConfig(tools=[tool]),
            tools_dict={name: _StubTool(name) for name in all_names},
        )

    generic_req = make_request("analyze NVDA stock price")
    scope_leaf_tools_before_model(None, generic_req)
    kept_generic = {d.name for d in generic_req.config.tools[0].function_declarations}
    assert kept_generic == {*core_padding, "run_app_action", "ask_consent_agent"}
    assert set(generic_req.tools_dict) == {*core_padding, "run_app_action", "ask_consent_agent"}

    cal_req = make_request("what meetings are on my calendar tomorrow?")
    scope_leaf_tools_before_model(None, cal_req)
    kept_cal = {d.name for d in cal_req.config.tools[0].function_declarations}
    assert "calendar_summary" in kept_cal
    assert "propose_calendar_event" in kept_cal
    assert "create_drive_file" not in kept_cal

    hist_req = make_request("thanks!", history_tool="list_active_grants")
    scope_leaf_tools_before_model(None, hist_req)
    kept_hist = {d.name for d in hist_req.config.tools[0].function_declarations}
    assert "list_active_grants" in kept_hist

    # Small synthetic fixture requests (<= 25 declarations) stay untouched.
    small_tool = genai_types.Tool(
        function_declarations=[
            genai_types.FunctionDeclaration(
                name="create_drive_file", description="create_drive_file"
            )
        ]
    )
    small_req = LlmRequest(
        model="gemini-2.5-flash",
        contents=[genai_types.Content(role="user", parts=[genai_types.Part(text="hi")])],
        config=genai_types.GenerateContentConfig(tools=[small_tool]),
        tools_dict={"create_drive_file": _StubTool("create_drive_file")},
    )
    scope_leaf_tools_before_model(None, small_req)
    assert [d.name for d in small_req.config.tools[0].function_declarations] == [
        "create_drive_file"
    ]


async def test_pod_chat_context_and_app_handle_fenced_pod_session_refused(monkeypatch):
    import subprocess
    import sys
    from pathlib import Path

    from fastapi import HTTPException

    from api.routes.one import pod_session
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext
    from hushh_mcp.services.pod_session_authority import PodSessionRefused

    claims = {"user_id": "owner-1", "hushh_id": "ha1_owner", "exp": 9_999_999_999}
    authority = SimpleNamespace(
        require_held=AsyncMock(
            side_effect=PodSessionRefused(
                "fenced",
                "this incarnation no longer holds the pod",
                status=503,
            )
        )
    )
    monkeypatch.setattr(
        pod_session, "verified_session", lambda *args, **kwargs: (authority, claims)
    )

    ctx = PodChatContext.__new__(PodChatContext)
    ctx.authorization = "Bearer pod-session:test"
    ctx.authority = authority
    ctx.claims = claims

    refused_exc = None
    try:
        await ctx._require_session_access()
    except HTTPException as exc:
        refused_exc = exc

    assert refused_exc is not None
    assert refused_exc.status_code == 503
    assert refused_exc.detail == {
        "code": "fenced",
        "message": "this incarnation no longer holds the pod",
    }

    # Import pod_server in an isolated interpreter so its module-level
    # HUSSH_POD_MODE=1 default never leaks into hub tests in this worker.
    probe = subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-c",
            (
                "import asyncio, json, pod_server; "
                "from hushh_mcp.services.pod_session_authority import PodSessionRefused; "
                "handler = pod_server.app.exception_handlers[PodSessionRefused]; "
                "res = asyncio.run(handler(None, PodSessionRefused("
                "'fenced', 'this incarnation no longer holds the pod', status=503))); "
                "assert res.status_code == 503; "
                "assert json.loads(res.body.decode()) == "
                "{'detail': {'code': 'fenced', 'message': 'this incarnation no longer holds the pod'}}"
            ),
        ],
        cwd=str(Path(__file__).resolve().parents[1]),
        capture_output=True,
        text=True,
        check=False,
    )
    assert probe.returncode == 0, probe.stderr or probe.stdout
