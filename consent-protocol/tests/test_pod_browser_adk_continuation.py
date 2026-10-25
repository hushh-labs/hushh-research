"""Native same-task handback; scripted model traffic never qualifies a cloud."""

import asyncio

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused
from tests.helpers.pod_browser import (
    Authority,
    Executor,
    _BrowserConsent,
    approve_browser_processing,
    control,
    readiness,
)


@pytest.mark.parametrize("unmatched", [False, True])
async def test_native_handback_retains_session_without_repeating_goal_or_pending_call(
    monkeypatch, unmatched
):
    from pathlib import Path
    from types import SimpleNamespace

    from google.adk.events import Event
    from google.adk.models import Gemini
    from google.genai import types

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.services.pod_browser.adk_task import NativeAdkBrowserModel
    from hushh_mcp.services.pod_browser.contracts import BrowserAction
    from hushh_mcp.services.pod_browser.information import (
        BrowserInformation,
        BrowserModelProcessing,
    )

    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    monkeypatch.setenv("ADK_TELEMETRY_IGNORE_RUN_CONFIG", "false")
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "hushh_mcp/agents/computer_use/agent.yaml")
    )
    consent = _BrowserConsent()
    driver = Executor()
    runtime = control(
        ready=readiness(model_name="gemini-3.8-flash"), auth=Authority(approved=True), driver=driver
    )
    process = BrowserModelProcessing(
        BrowserInformation(SimpleNamespace(), consent),
        runtime.binding,
        (),
        "gemini-3.8-flash",
        readiness().model_transport,
        ("https://example.com",),
        "Original synthetic research goal.",
    )
    approve_browser_processing(consent, process)
    requests = []

    async def generate(**request):
        requests.append(request)
        name, args = (
            ("click", {"x": 500, "y": 500})
            if len(requests) == 1
            else ("finish_task", {"outcome": "needs_owner", "summary": "Please sign in."})
            if len(requests) == 2
            else ("take_screenshot", {})
            if len(requests) == 3
            else (
                "finish_task",
                {"outcome": "completed", "summary": "Continued after owner handback."},
            )
        )
        return types.GenerateContentResponse(
            candidates=[
                types.Candidate(
                    content=types.Content(
                        role="model",
                        parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))],
                    ),
                    finish_reason=types.FinishReason.STOP,
                )
            ]
        )

    model = Gemini(model=process.model_name)
    model.__dict__["api_client"] = SimpleNamespace(
        vertexai=False, aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
    )
    native = NativeAdkBrowserModel(manifest, model)
    try:
        result = await native.run(control=runtime, processing=process, goal=process.task_goal)
        assert result.outcome == "needs_owner"
        context = native._tasks[runtime.binding.task_id]
        original_session = context.session_id
        session = await context.sessions.get_session(
            app_name="pod_browser", user_id=runtime.binding.owner_id, session_id=original_session
        )
        first_ids = {event.invocation_id for event in session.events}
        await runtime.take_control()
        await runtime.execute(
            BrowserAction(
                operation="type",
                sequence=runtime.next_sequence,
                control_epoch=runtime.control_epoch,
                x=10,
                y=10,
                text="synthetic-owner-login",
            ),
            actor="owner",
        )
        await runtime.resume_agent()
        if unmatched:
            await context.sessions.append_event(
                session,
                Event(
                    author="computer_use_agent",
                    invocation_id="interrupted-native",
                    content=types.Content(
                        role="model",
                        parts=[
                            types.Part(
                                function_call=types.FunctionCall(
                                    id="pending-effect", name="click", args={"x": 1, "y": 1}
                                )
                            )
                        ],
                    ),
                ),
            )
            with pytest.raises(BrowserRefused, match="CONTINUATION_UNCERTAIN"):
                await native.run(control=runtime, processing=process, goal=process.task_goal)
            assert len(requests) == 2 and driver.calls.count("click") == 1
        else:
            result = await native.run(control=runtime, processing=process, goal=process.task_goal)
            assert result.outcome == "completed" and driver.calls.count("click") == 1
            text = "\n".join(
                part.text or ""
                for content in requests[2]["contents"]
                for part in content.parts or []
            )
            assert "synthetic-owner-login" not in text
            assert (
                text.count(process.task_goal) == 1
            )  # retained original, never another goal submission
            assert "handed back this same browser task" in text
            assert context.session_id == original_session
            # Native task segments use fresh explicit IDs instead of unfinished-call replay.
            assert context.segments == 2 and first_ids
            assert runtime.binding.task_id not in native._tasks
    finally:
        await runtime.stop()
        await native.release_task(runtime.binding)


@pytest.fixture
async def confirmed_dispatch(monkeypatch, interruption):
    from types import SimpleNamespace

    driver, auth = Executor(), Authority(approved=True)
    state = SimpleNamespace(
        driver=driver,
        auth=auth,
        runtime=control(driver=driver, auth=auth),
        finished=False,
        checking=asyncio.Event(),
        release=asyncio.Event(),
        active=None,
        takeover=None,
        attempts=0,
    )
    execute, check, settle = driver.execute, auth.check_binding, auth.settle_dispatch

    async def executing(*args, **kwargs):
        frame = await execute(*args, **kwargs)
        state.finished = True
        return frame

    async def checking_binding(value):
        if state.finished and asyncio.current_task() is state.active and interruption != "lost_ack":
            state.checking.set()
            await state.release.wait()
        await check(value)

    async def settling(value, action, *, uncertain):
        state.attempts += 1
        if interruption == "settlement_failed":
            state.checking.set()
            await state.release.wait()
            raise RuntimeError("synthetic unavailable journal")
        if (action.sequence, "settled") not in auth.journal:
            await settle(value, action, uncertain=uncertain)
        if interruption == "lost_ack" and state.attempts == 1:
            state.checking.set()
            await state.release.wait()

    monkeypatch.setattr(driver, "execute", executing)
    monkeypatch.setattr(auth, "check_binding", checking_binding)
    monkeypatch.setattr(auth, "settle_dispatch", settling)
    await state.runtime.initialize()
    try:
        yield state
    finally:
        workers = [worker for worker in (state.active, state.takeover) if worker is not None]
        for worker in workers:
            if not worker.done():
                worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        await state.runtime.stop()


@pytest.mark.parametrize(
    "operation, interruption",
    [
        ("observe", "epoch"),
        ("click", "epoch"),
        ("click", "cancel"),
        ("click", "lost_ack"),
        ("click", "settlement_failed"),
        ("click", "revoked"),
    ],
)
async def test_confirmed_dispatch_survives_takeover_without_disclosing_old_frame(
    confirmed_dispatch, operation, interruption
):
    state = confirmed_dispatch
    runtime = state.runtime
    state.active = asyncio.create_task(
        runtime.execute(
            BrowserAction(
                operation=operation,
                sequence=1,
                control_epoch=1,
                **({"x": 1, "y": 1} if operation == "click" else {}),
            )
        )
    )
    await asyncio.wait_for(state.checking.wait(), 1)
    cancel = interruption in {"cancel", "lost_ack"}

    async def interrupt():
        state.active.cancel()
        await asyncio.gather(state.active, return_exceptions=True)

    if interruption == "revoked":
        state.auth.revoked = True
    else:
        state.takeover = asyncio.create_task(
            runtime.take_control(interrupt=interrupt if cancel else None)
        )
        await asyncio.sleep(0)
    state.release.set()
    expected = (
        asyncio.CancelledError
        if cancel
        else RuntimeError
        if interruption == "settlement_failed"
        else BrowserRefused
    )
    with pytest.raises(expected):
        await state.active
    assert runtime.latest_frame is None
    if interruption == "settlement_failed":
        with pytest.raises(BrowserRefused, match="UNCERTAIN"):
            await state.takeover
        assert runtime.outcome_uncertain and state.attempts == 2
        return
    assert not runtime.outcome_uncertain
    assert state.driver.calls == ["initialize", operation]
    assert state.auth.journal == ([(1, "dispatch"), (1, "settled")] if operation == "click" else [])
    if state.takeover is None:
        return
    assert await state.takeover == 2 and runtime.control_owner == "owner"
    with pytest.raises(BrowserRefused, match="CONTROL_CHANGED"):
        await runtime.execute(BrowserAction(operation="observe", sequence=2, control_epoch=1))
    await runtime.execute(
        BrowserAction(operation="observe", sequence=2, control_epoch=2), actor="owner"
    )
    await runtime.resume_agent()
    assert runtime.control_epoch == 3
    await runtime.execute(BrowserAction(operation="observe", sequence=4, control_epoch=3))
