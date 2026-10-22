"""Native same-task handback; scripted model traffic never qualifies a cloud."""

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused
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
