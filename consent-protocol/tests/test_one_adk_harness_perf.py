"""Tests for ADK 2.14 harness performance optimizations and lifecycle guarantees."""

from __future__ import annotations

import asyncio
import json
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock

from ag_ui.core import RunFinishedEvent, TextMessageContentEvent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.events import Event
from google.adk.events.event_actions import EventActions
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools.base_tool import BaseTool
from google.genai import types as genai_types

from hushh_mcp.one_adk import pod_agui_lifetime as pod
from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
from hushh_mcp.one_adk.chat_adk_app import _adk_context_cache_config, build_chat_adk_app
from hushh_mcp.one_adk.native_chat_output import encode_native_chat_output
from hushh_mcp.one_adk.native_chat_stream import native_chat_frames
from hushh_mcp.one_adk.tool_scoping import scope_leaf_tools_before_model
from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission, PodUpgradeInProgress
from tests.helpers.agui_lifetime import DETACHED_ANSWER, _input, _slow_answer_agent


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

    turn_input = _input()
    iterator = agent.run(turn_input)
    event = await anext(iterator)
    assert isinstance(event, RunFinishedEvent)
    yielded_finished = True
    assert not post_started.is_set()

    # Stream settlement completes immediately without blocking on detached post_run,
    # releasing the thread lock while retaining upgrade admission until post_run settles.
    finishing = asyncio.create_task(iterator.aclose())
    await asyncio.wait_for(finishing, 2)
    await asyncio.wait_for(post_started.wait(), 2)
    assert turn_input.thread_id not in pod._ACTIVE_THREADS
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 1

    # A back-to-back follow-up turn on the same thread succeeds immediately (no POD_CHAT_BUSY).
    second_agent = pod.PodTimedADKAgent.__new__(pod.PodTimedADKAgent)
    second_agent.close = AsyncMock()
    second_agent.configure_pod_turn(
        require_access=AsyncMock(),
        runtime_scope=nullcontext,
    )
    second_events = [evt async for evt in second_agent.run(turn_input)]
    assert len(second_events) == 1
    assert isinstance(second_events[0], RunFinishedEvent)

    post_release.set()
    if pod._POST_RUN_TASKS:
        await asyncio.wait_for(asyncio.gather(*tuple(pod._POST_RUN_TASKS)), 2)
    assert ran_after_yield == [1]
    assert (await admission.status(incarnation="synthetic"))["activeWork"] == 0


async def test_native_runner_streams_and_settles_with_chat_app():
    sessions = InMemorySessionService()
    app = build_chat_adk_app(_slow_answer_agent(delay=0), app_name="one_native_probe")
    session = await sessions.create_session(app_name=app.name, user_id="review_fixture")
    runner = Runner(app=app, session_service=sessions)
    require_access = AsyncMock()
    admission = PodUpgradeAdmission(log_resolver=lambda: None)

    async def save():
        assert (await admission.status(incarnation="native-probe"))["activeWork"] == 1

    snapshot = AsyncMock(side_effect=save)

    def open_fixture():
        return runner.run_async(
            user_id=session.user_id,
            session_id=session.id,
            new_message=genai_types.Content(
                role="user", parts=[genai_types.Part(text="Show my holdings")]
            ),
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        )

    try:
        stream = native_chat_frames(
            open_fixture,
            owner_id=session.user_id,
            conversation_id=session.id,
            require_access=require_access,
            settle=snapshot,
            admission=admission,
            incarnation="native-probe",
        )
        events = []
        async for frame in stream:
            if frame.startswith(b"event: done"):
                snapshot.assert_awaited_once()
                break
            events.append(json.loads(frame.removeprefix(b"data: ")))
        else:
            raise AssertionError("The native stream ended without a completion frame")
        await stream.aclose()
    finally:
        await runner.close()
    assert any(event["author"] == "one" and event.get("partial") for event in events)
    settled = await sessions.get_session(
        app_name=app.name, user_id=session.user_id, session_id=session.id
    )
    assert settled is not None
    texts = [
        part.text for event in settled.events if event.content for part in event.content.parts or []
    ]
    assert DETACHED_ANSWER in texts
    assert "working" not in texts


async def test_dev_finance_presenter_streams_catalog_offers_with_the_installed_adk(monkeypatch):
    from google.adk.agents import LlmAgent
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.one_adk.chat_adk_app import build_native_visual_chat_app
    from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
    from hushh_mcp.one_adk.finance_a2ui import STATE_DEV_FINANCE_VISUALS, send_a2ui_json_to_client
    from hushh_mcp.one_adk.native_chat_output import A2UI_TOOL_NAME, STATE_NATIVE_VISUAL_CHAT
    from hushh_mcp.one_adk.state_keys import STATE_USER_ID
    from hushh_mcp.services.generated_contracts import generated_contract_path

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    selected = (
        [
            {"component": "SavedPortfolio", "section": section}
            for section in ("holdings", "allocation", "performance", "sources")
        ]
        + [
            {"component": "MarketSnapshot", "view": view}
            for view in ("gainers", "losers", "movers")
        ]
        + [
            {"component": "FinanceStockPreview", "ticker": "TEST"},
            {"component": "FinancePortfolioUpload"},
            {"component": "FinancePortfolioPicker", "mode": "switch"},
            {"component": "FinancePortfolioPicker", "mode": "delete"},
            {"component": "FinancePlaidConnection"},
            {"component": "FinanceShareProposal", "audience": "connection"},
            {"component": "FinanceShareProposal", "audience": "verified_advisor"},
            {"component": "FinanceShareProposal", "audience": "received"},
        ]
    )
    submitted = selected + [{"component": "FinanceStockPreview", "ticker": "link://invalid"}]

    class FinanceModel(BaseLlm):
        called: bool = False

        async def generate_content_async(self, llm_request, stream=False):
            if self.called:
                parts = [genai_types.Part(text="Finance offers ready")]
            else:
                self.called = True
                parts = [
                    genai_types.Part(
                        function_call=genai_types.FunctionCall(
                            name=A2UI_TOOL_NAME,
                            args=selection,
                        )
                    )
                    for selection in submitted
                ]
            yield LlmResponse(
                content=genai_types.Content(role="model", parts=parts),
                turn_complete=True,
            )

    app = build_native_visual_chat_app(
        LlmAgent(name="one", model=FinanceModel(model="synthetic-finance")),
        app_name="one",
        finance_only=True,
    )
    sessions = InMemorySessionService()
    state = {
        STATE_USER_ID: "test-owner",
        "hussh:consent_token": "synthetic-request-reference",
        STATE_EXECUTION_SURFACE: "typed_chat",
        STATE_NATIVE_VISUAL_CHAT: True,
        STATE_DEV_FINANCE_VISUALS: True,
    }
    assert send_a2ui_json_to_client(
        "SavedPortfolio",
        SimpleNamespace(agent_name="finance", state=state),
        section="holdings",
    ) == {"status": "unavailable"}
    session = await sessions.create_session(app_name=app.name, user_id="test-owner", state=state)
    async with Runner(app=app, session_service=sessions) as runner:
        events = [
            event
            async for event in runner.run_async(
                user_id=session.user_id,
                session_id=session.id,
                new_message=genai_types.Content(
                    role="user", parts=[genai_types.Part(text="Show Finance")]
                ),
                state_delta=state,
                run_config=RunConfig(streaming_mode=StreamingMode.SSE),
            )
        ]
    responses = [
        part["functionResponse"]["response"]["validated_a2ui_json"][0]
        for event in events
        if (frame := encode_native_chat_output(event))
        for part in json.loads(frame.removeprefix(b"data: "))["content"]["parts"]
        if "functionResponse" in part
    ]
    catalog = json.loads(generated_contract_path("a2ui", "morphy-one.v1.catalog.json").read_text())
    offered = []
    for response in responses:
        assert response["version"] == "1.0"
        surface = response["createSurface"]
        assert surface["catalogId"] == catalog["catalogId"]
        assert "dataModel" not in surface
        (node,) = surface["components"]
        assert node.pop("id") == "root"
        assert node["component"] in catalog["components"]
        offered.append(node)
    assert sorted(offered, key=lambda offer: str(offer)) == sorted(
        selected, key=lambda offer: str(offer)
    )


async def test_native_stream_refuses_to_complete_when_access_ends_before_settlement():
    async def open_fixture():
        yield Event(
            author="one",
            partial=True,
            content=genai_types.Content(role="model", parts=[genai_types.Part(text="visible")]),
        )

    require_access = AsyncMock(side_effect=[None, None, PermissionError("private-refusal-detail")])
    snapshot = AsyncMock()
    frames = [
        frame
        async for frame in native_chat_frames(
            open_fixture,
            owner_id="fixture-owner",
            conversation_id="fixture-turn",
            require_access=require_access,
            settle=snapshot,
        )
    ]
    assert b"visible" in frames[0]
    assert frames[1] == b'event: error\ndata: {"code":"AGENT_ERROR"}\n\n'
    snapshot.assert_not_awaited()


async def test_native_stream_cannot_start_while_the_private_runtime_is_updating(monkeypatch):
    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    acquire = AsyncMock(side_effect=PodUpgradeInProgress("synthetic update"))
    monkeypatch.setattr(admission, "acquire_turn", acquire)
    source = AsyncMock()
    snapshot = AsyncMock()
    frames = [
        frame
        async for frame in native_chat_frames(
            source,
            owner_id="fixture-owner",
            conversation_id="fixture-update",
            require_access=AsyncMock(),
            settle=snapshot,
            admission=admission,
            incarnation="native-update",
        )
    ]
    assert frames == [b'event: error\ndata: {"code":"POD_CHAT_UPDATING"}\n\n']
    source.assert_not_called()
    snapshot.assert_not_awaited()


async def test_native_stream_does_not_offer_review_for_an_unfinished_operation():
    async def open_fixture():
        yield Event(
            author="one",
            content=genai_types.Content(role="model", parts=[genai_types.Part(text="Working")]),
        )
        yield Event(author="one", long_running_tool_ids={"native-pending-work"})

    snapshot = AsyncMock()
    frames = [
        frame
        async for frame in native_chat_frames(
            open_fixture,
            owner_id="fixture-owner",
            conversation_id="fixture-pending-work",
            require_access=AsyncMock(),
            settle=snapshot,
        )
    ]
    assert frames[-1] == b'event: error\ndata: {"code":"AGENT_ERROR"}\n\n'
    snapshot.assert_not_awaited()


def test_native_output_only_projects_visible_one_parts_and_read_only_surfaces():
    visual = {
        "version": "1.0",
        "createSurface": {
            "surfaceId": "holdings",
            "catalogId": "hussh.ai:morphy-one/v1",
            "sendDataModel": False,
        },
    }
    round_trip = {
        **visual,
        "createSurface": {**visual["createSurface"], "sendDataModel": True},
    }
    event = Event(
        author="one",
        actions=EventActions(state_delta={"private_snapshot": "internal-state"}),
        content=genai_types.Content(
            role="model",
            parts=[
                genai_types.Part(text="visible"),
                genai_types.Part(
                    text="private-thought", thought=True, thought_signature=b"signature"
                ),
                genai_types.Part.from_function_call(
                    name="share", args={"topic": "private-argument"}
                ),
                genai_types.Part.from_function_response(
                    name="read_portfolio_context",
                    response={"holdings": "private-tool-result"},
                ),
                genai_types.Part.from_function_response(
                    name="send_a2ui_json_to_client",
                    response={"validated_a2ui_json": [visual], "private": "private-extra"},
                ),
                genai_types.Part.from_function_response(
                    name="send_a2ui_json_to_client",
                    response={
                        "validated_a2ui_json": [
                            {
                                "version": "1.0",
                                "callRendererFunction": {"callFunction": "disallowed"},
                            },
                            round_trip,
                        ]
                    },
                ),
                genai_types.Part.from_function_response(
                    name="send_a2ui_json_to_client",
                    response={"validated_a2ui_json": [round_trip]},
                ),
            ],
        ),
    )
    frame = encode_native_chat_output(event)
    assert json.loads(frame.removeprefix(b"data: "))["content"]["parts"] == [
        {"text": "visible"},
        {
            "functionResponse": {
                "name": "send_a2ui_json_to_client",
                "response": {"validated_a2ui_json": [visual]},
            }
        },
    ]
    assert b"internal-state" not in frame
    assert encode_native_chat_output(event.model_copy(update={"author": "finance"})) == b""


def test_native_location_review_only_emits_a_valid_proposal_for_an_admitted_turn():
    from hushh_mcp.one_adk.location_chat_proposal import TOOL_NAME, propose_location_action

    proposal = propose_location_action("share_live", ["Kushal"], duration_hours=1)
    event = Event(
        author="one",
        content=genai_types.Content(
            parts=[genai_types.Part.from_function_response(name=TOOL_NAME, response=proposal)]
        ),
    )
    assert encode_native_chat_output(event) == b""
    projected = json.loads(encode_native_chat_output(event, location_chat_review=True)[6:])
    assert projected["content"]["parts"] == [
        {"functionResponse": {"name": TOOL_NAME, "response": proposal}}
    ]
    assert (
        encode_native_chat_output(
            event.model_copy(update={"partial": True}), location_chat_review=True
        )
        == b""
    )
    malformed = Event(
        author="one",
        content=genai_types.Content(
            parts=[
                genai_types.Part.from_function_response(
                    name=TOOL_NAME, response={**proposal, "latitude": 24}
                )
            ]
        ),
    )
    assert encode_native_chat_output(malformed, location_chat_review=True) == b""


def test_context_cache_config_targets_native_gemini_only(monkeypatch):
    from hushh_mcp.one_adk import chat_adk_app

    monkeypatch.setenv("HUSHH_ADK_CONTEXT_CACHE_FORCE_TEST", "1")
    monkeypatch.delenv("HUSHH_ADK_CONTEXT_CACHE_DISABLED", raising=False)

    if chat_adk_app.ContextCacheConfig is None or not chat_adk_app._APP_ACCEPTS_CONTEXT_CACHE:
        assert _adk_context_cache_config(SimpleNamespace(model="gemini-2.5-flash")) is None
        return

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


def test_scope_leaf_tools_prunes_unrelated_domains_and_keeps_history(monkeypatch):
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

    # Prefix-cache default: without opt-in flag, tool declarations stay stable across turns.
    monkeypatch.delenv("HUSHH_ONE_TOOL_SCOPING_ENABLED", raising=False)
    default_req = make_request("analyze NVDA stock price")
    scope_leaf_tools_before_model(None, default_req)
    assert {d.name for d in default_req.config.tools[0].function_declarations} == set(all_names)

    monkeypatch.setenv("HUSHH_ONE_TOOL_SCOPING_ENABLED", "1")
    generic_req = make_request("analyze NVDA stock price")
    scope_leaf_tools_before_model(None, generic_req)
    kept_generic = {d.name for d in generic_req.config.tools[0].function_declarations}
    expected = {
        *core_padding,
        "run_app_action",
        "ask_consent_agent",
        "calendar_summary",
        "propose_calendar_event",
    }
    assert kept_generic == expected
    assert set(generic_req.tools_dict) == expected
    # Calendar interpretation belongs to One, including fresh turns with no
    # lexical calendar marker and short same-conversation references.
    for wording in (
        "Am I free Friday afternoon?",
        "What calls do I have Monday?",
        "Block 30 minutes Friday",
        "kal khaali hoon?",
        "move that one",
        "shfit the 2nd one",
        "मेरे पास सोमवार को क्या है?",
    ):
        request = make_request(wording)
        scope_leaf_tools_before_model(None, request)
        kept = {
            decl.name for tool in request.config.tools for decl in tool.function_declarations or []
        }
        assert {"calendar_summary", "propose_calendar_event"} <= kept
        assert {"calendar_summary", "propose_calendar_event"} <= set(request.tools_dict)
        assert "create_drive_file" not in kept

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


async def test_schedule_fenced_pod_retirement_is_cloud_only_and_idempotent():
    import os
    import signal

    from hushh_mcp.services.pod_session_authority import (
        _reset_fenced_pod_retirement_for_tests,
        schedule_fenced_pod_retirement,
    )

    calls: list[tuple[int, int]] = []
    _reset_fenced_pod_retirement_for_tests()
    try:
        # Local dev / test platforms must never receive SIGTERM.
        assert (
            schedule_fenced_pod_retirement(
                "local_test",
                platform_fn=lambda: "local",
                kill_fn=lambda pid, sig: calls.append((pid, sig)),
                delay_seconds=0.005,
            )
            is False
        )
        await asyncio.sleep(0.02)
        assert calls == []

        # Managed cloud pods retire once after flushing response, preferring arbiter ppid.
        assert (
            schedule_fenced_pod_retirement(
                "http_session_refused",
                platform_fn=lambda: "gcp",
                kill_fn=lambda pid, sig: calls.append((pid, sig)),
                delay_seconds=0.01,
            )
            is True
        )
        assert (
            schedule_fenced_pod_retirement(
                "duplicate",
                platform_fn=lambda: "gcp",
                kill_fn=lambda pid, sig: calls.append((pid, sig)),
                delay_seconds=0.01,
            )
            is False
        )
        await asyncio.sleep(0.04)
        expected_target = os.getppid() if os.getppid() >= 1 else os.getpid()
        assert calls == [(expected_target, signal.SIGTERM)]

        # If signaling parent raises PermissionError, fall back to os.getpid().
        calls.clear()
        _reset_fenced_pod_retirement_for_tests()

        def _deny_parent(pid: int, sig: int) -> None:
            if pid == os.getppid() and pid != os.getpid():
                raise PermissionError("parent owned differently")
            calls.append((pid, sig))

        assert (
            schedule_fenced_pod_retirement(
                "fallback_pid",
                platform_fn=lambda: "azure",
                kill_fn=_deny_parent,
                delay_seconds=0.01,
            )
            is True
        )
        await asyncio.sleep(0.04)
        assert calls == [(os.getpid(), signal.SIGTERM)]
    finally:
        _reset_fenced_pod_retirement_for_tests()
