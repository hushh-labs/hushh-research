"""Pinned ADK transport contracts; synthetic model fixtures are not cloud acceptance."""

import asyncio

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused
from tests.helpers.pod_browser import Authority, Executor, _BrowserConsent, control, readiness


@pytest.mark.parametrize(
    "first_tool,first_args,refusal",
    [
        ("open_web_browser", {}, None),
        ("take_screenshot", {"intent": "Inspect"}, None),
        ("mouse_down", {}, "BROWSER_NATIVE_ACTION_UNSUPPORTED"),
        (
            "drag_and_drop",
            {"start_x": 0, "start_y": 0, "end_x": 500, "end_y": 500},
            "BROWSER_NATIVE_ACTION_UNSUPPORTED",
        ),
        ("click", {"x": 1000, "y": 500}, "BROWSER_COORDINATES_INVALID"),
    ],
)
async def test_native_adk_task_keeps_authored_instruction_png_and_finish_output(
    monkeypatch, first_tool, first_args, refusal
):
    """Real pinned ADK/Gemini preprocessing, synthetic provider response only."""
    from pathlib import Path
    from types import SimpleNamespace

    from google.adk.models import Gemini
    from google.genai import types

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.services.pod_browser.adk_task import NativeAdkBrowserModel
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
    delivered = []
    execute = driver.execute

    async def record(action):
        delivered.append(action)
        return await execute(action)

    monkeypatch.setattr(driver, "execute", record)
    model_name = "gemini-3.7-flash" if first_tool == "open_web_browser" else "gemini-3.8-flash"
    runtime = control(
        ready=readiness(model_name=model_name), auth=Authority(approved=True), driver=driver
    )
    process = BrowserModelProcessing(
        BrowserInformation(SimpleNamespace(), consent),
        runtime.binding,
        (),
        model_name,
        readiness().model_transport,
        ("https://example.com",),
        "Review the requested public page.",
    )
    _approve_processing(consent, process)
    requests = []

    async def generate(**request):
        requests.append(request)
        if len(requests) == 1:
            name, args = first_tool, first_args
        elif len(requests) == 2 and first_tool == "take_screenshot":
            name, args = "click", {"x": 500, "y": 500, "intent": "Select"}
        else:
            name, args = (
                "finish_task",
                {"outcome": "completed", "summary": "The requested page was reviewed."},
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

    client = SimpleNamespace(
        vertexai=False, aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
    )
    model = Gemini(model=process.model_name)
    # Supply only a synthetic HTTP client; all native ADK tool/model adaptation runs.
    model.__dict__["api_client"] = client
    if refusal:
        with pytest.raises(BrowserRefused, match=refusal):
            await NativeAdkBrowserModel(manifest, model).run(
                control=runtime, processing=process, goal=process.task_goal
            )
        assert len(requests) == 1 and not delivered
        return
    result = await NativeAdkBrowserModel(manifest, model).run(
        control=runtime, processing=process, goal="Review the requested public page."
    )
    assert result.outcome == "completed" and len(requests) == (
        3 if first_tool == "take_screenshot" else 2
    )
    if first_tool == "take_screenshot":
        assert (delivered[-1].x, delivered[-1].y) == (640, 360)
    assert requests[0]["config"].system_instruction is None  # native Computer Use behaviour
    assert any(tool.computer_use for tool in requests[0]["config"].tools)
    # The deployed native API rejects the excluded-action list with HTTP 400.
    assert all(
        tool.computer_use.excluded_predefined_functions is None
        for tool in requests[0]["config"].tools
        if tool.computer_use
    )
    assert manifest.system_instruction in "\n".join(
        part.text or "" for content in requests[0]["contents"] for part in content.parts or []
    )
    frames = [
        media.inline_data
        for content in requests[1]["contents"]
        for part in content.parts or []
        if part.function_response
        for media in part.function_response.parts or []
        if media.inline_data
    ]
    assert frames and frames[0].mime_type == "image/png"
    assert (
        runtime.control_owner == "agent"
    )  # runner closes ephemeral tools, lifecycle stays runtime-owned

    await _assert_closed_and_private(monkeypatch, manifest, model, runtime, process, requests)


@pytest.mark.parametrize("takeover", [False, True])
async def test_native_safety_review_resumes_exact_adk_call_or_fences_it(monkeypatch, takeover):
    from pathlib import Path
    from types import SimpleNamespace

    from google.adk.models import Gemini
    from google.genai import types

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.services.pod_browser.adk_task import NativeAdkBrowserModel
    from tests.helpers.pod_browser import task_runtime_fixture

    monkeypatch.setenv("ADK_TELEMETRY_IGNORE_RUN_CONFIG", "false")
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "hushh_mcp/agents/computer_use/agent.yaml")
    )
    requests = []

    async def generate(**request):
        requests.append(request)
        name, args = (
            (
                "open_web_browser",
                {
                    "safety_decision": {
                        "decision": "require_confirmation",
                        "explanation": "Synthetic website warning.",
                    }
                },
            )
            if len(requests) == 1
            else ("finish_task", {"outcome": "completed", "summary": "Synthetic review complete."})
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

    model = Gemini(model=readiness().model_name)
    model.__dict__["api_client"] = SimpleNamespace(
        vertexai=False, aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
    )
    fixture = task_runtime_fixture(monkeypatch, model=NativeAdkBrowserModel(manifest, model))
    started = await fixture.runtime.start(fixture.owner, fixture.request)
    task_id = started.binding.task_id
    task = fixture.runtime._tasks[task_id]
    receipt = "synthetic-owner-receipt-" + "x" * 32
    try:
        await task.worker
        status = await fixture.runtime.read(fixture.owner, task_id)
        await fixture.runtime.confirm_review(
            fixture.owner, task_id, status.review.review_id, receipt
        )
        worker = task.worker
        async with asyncio.timeout(3):
            while not task.review_waiting:
                await asyncio.sleep(0.01)
        status = await fixture.runtime.read(fixture.owner, task_id)
        assert status.review.purpose == "provider_safety" and len(requests) == 1
        assert fixture.driver.calls == ["initialize"]
        with pytest.raises(BrowserRefused, match="REVIEW_CHANGED"):
            await fixture.runtime.confirm_review(fixture.owner, task_id, "changed-call", receipt)
        if takeover:
            status = await fixture.runtime.control(
                fixture.owner, task_id, "takeover", status.control_epoch
            )
            assert status.control_owner == "owner" and worker.done()
            assert fixture.driver.calls == ["initialize"] and len(requests) == 1
        else:
            await fixture.runtime.confirm_review(
                fixture.owner, task_id, status.review.review_id, receipt
            )
            assert task.worker is worker  # no new goal or ADK invocation
            await asyncio.wait_for(worker, 3)
            assert (await fixture.runtime.read(fixture.owner, task_id)).phase == "completed"
            assert fixture.driver.calls.count("observe") == 1 and len(requests) == 2
        assert "Synthetic website warning" not in str(fixture.log.records)
    finally:
        await fixture.runtime.drain()


async def test_azure_native_adk_round_trip_uses_pixels_exact_call_ids_and_private_history(
    monkeypatch,
):
    import base64
    import json
    from pathlib import Path
    from types import SimpleNamespace

    import httpx
    from openai import AsyncOpenAI

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.runtime_providers.azure_browser_adk import (
        AzureBrowserAdkModel,
        ComputerCall,
        ComputerResult,
        computer_response,
    )
    from hushh_mcp.services.pod_browser.adk_task import NativeAdkBrowserModel
    from hushh_mcp.services.pod_browser.azure_computer import native_actions
    from hushh_mcp.services.pod_browser.information import (
        BrowserInformation,
        BrowserModelProcessing,
    )

    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    monkeypatch.setenv("ADK_TELEMETRY_IGNORE_RUN_CONFIG", "false")
    requests = []
    native = {
        "type": "computer_call",
        "id": "cu_synthetic",
        "call_id": "call_synthetic",
        "status": "completed",
        "pending_safety_checks": [],
        "actions": [
            {"type": "click", "button": "left", "x": 1100, "y": 600},
            {"type": "type", "text": "synthetic text"},
        ],
    }
    commentary = {
        "type": "message",
        "id": "msg_synthetic",
        "role": "assistant",
        "status": "completed",
        "phase": "commentary",
        "content": [{"type": "output_text", "text": "I will inspect the page.", "annotations": []}],
    }

    def respond(request):
        requests.append(json.loads(request.content))
        for item in requests[-1]["input"]:
            assert "pending_safety_checks" not in item
            assert "acknowledged_safety_checks" not in item
        output = (
            [commentary, native]
            if len(requests) == 1
            else [
                {
                    "type": "function_call",
                    "name": "finish_task",
                    "call_id": "finish_synthetic",
                    "arguments": json.dumps(
                        {"outcome": "completed", "summary": "Synthetic Azure task complete."}
                    ),
                }
            ]
        )
        return httpx.Response(
            200,
            json={
                "id": f"resp_synthetic_{len(requests)}",
                "object": "response",
                "created_at": 1,
                "model": "qualified-owner-deployment",
                "status": "completed",
                "output": output,
            },
        )

    async def current():
        return None

    model = AzureBrowserAdkModel(
        model="qualified-owner-deployment",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic-token",
        require_current=current,
        client_factory=lambda **kwargs: AsyncOpenAI(
            **kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        ),
    )
    transport = f"{type(model).__module__}.{type(model).__qualname__}"
    driver = Executor()
    runtime = control(
        ready=readiness(cloud="azure", model_name=model.model, model_transport=transport),
        auth=Authority(approved=True),
        driver=driver,
    )
    consent = _BrowserConsent()
    process = BrowserModelProcessing(
        BrowserInformation(SimpleNamespace(), consent),
        runtime.binding,
        (),
        model.model,
        transport,
        ("https://example.com",),
        "Synthetic Azure task.",
    )
    _approve_processing(consent, process)
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "hushh_mcp/agents/computer_use/agent.yaml")
    )
    try:
        result = await NativeAdkBrowserModel(manifest, model).run(
            control=runtime, processing=process, goal=process.task_goal
        )
        assert result.outcome == "completed" and len(requests) == 2
        assert driver.calls == ["initialize", "click", "type"]
        assert all(
            request["store"] is False
            and "previous_response_id" not in request
            and request["reasoning"]["effort"] == "low"
            for request in requests
        )
        assert {"type": "computer"} in requests[0]["tools"]
        history = requests[1]["input"]
        assert next(item for item in history if item.get("phase") == "commentary") == commentary
        assert next(item for item in history if item.get("type") == "computer_call") == {
            key: value for key, value in native.items() if key != "pending_safety_checks"
        }
        screenshot = next(item for item in history if item.get("type") == "computer_call_output")
        assert screenshot["call_id"] == native["call_id"]
        assert screenshot["output"]["image_url"].startswith("data:image/png;base64,")
        planned = native_actions(ComputerCall.from_provider(native), runtime)
        assert (planned[0].x, planned[0].y) == (1100, 600)  # no Gemini virtual-space scaling
        assert planned[1].x is None and planned[1].focus_existing
        with pytest.raises(BrowserRefused, match="NATIVE_ACTION_UNSUPPORTED"):
            native_actions(
                ComputerCall.from_provider(
                    {
                        **native,
                        "actions": [
                            native["actions"][0],
                            {"type": "click", "button": "right", "x": 1, "y": 1},
                        ],
                    }
                ),
                runtime,
            )
        with pytest.raises(ValueError, match="identity|changed"):
            ComputerResult(
                call_id="wrong", png_base64=base64.b64encode(b"\x89PNG\r\n\x1a\nfixture").decode()
            ).wire(ComputerCall.from_provider(native))
        with pytest.raises(ValueError, match="computer call"):
            computer_response(
                {
                    "status": "completed",
                    "output": [
                        {
                            "type": "function_call",
                            "name": "browser_native_call",
                            "call_id": "forged",
                            "arguments": json.dumps({"call": native}),
                        }
                    ],
                },
                allowed_names=set(),
            )
    finally:
        await runtime.stop()


async def _assert_closed_and_private(monkeypatch, manifest, model, runtime, process, requests):
    from google.adk.runners import Runner

    from hushh_mcp.services.pod_browser.adk_task import NativeAdkBrowserModel

    completed_request_count = len(requests)

    async def unconfirmed_model_close(_runner):
        raise OSError("synthetic model close failure")

    with monkeypatch.context() as cleanup:
        cleanup.setattr(Runner, "close", unconfirmed_model_close)
        with pytest.raises(BrowserRefused, match="MODEL_STOP_UNCONFIRMED"):
            await NativeAdkBrowserModel(manifest, model).run(
                control=runtime, processing=process, goal=process.task_goal
            )
    assert len(requests) == completed_request_count + 1
    await runtime.stop()

    with pytest.raises(BrowserRefused, match="PROCESSING_TERMS_MISMATCH"):
        await NativeAdkBrowserModel(manifest, model).run(
            control=runtime, processing=process, goal="An unapproved changed goal."
        )

    # OpenAI's SDK logs full request JSON at DEBUG, independently of ADK
    # telemetry. Suppressed spans alone cannot protect screenshots and goals.
    import logging

    sdk_logger = logging.getLogger("openai._base_client")
    original_level = sdk_logger.level
    try:
        sdk_logger.setLevel(logging.DEBUG)
        with pytest.raises(BrowserRefused, match="TELEMETRY_CONTENT_REFUSED"):
            await NativeAdkBrowserModel(manifest, model).run(
                control=runtime, processing=process, goal=process.task_goal
            )
    finally:
        sdk_logger.setLevel(original_level)

    monkeypatch.setenv("ADK_TELEMETRY_IGNORE_RUN_CONFIG", "true")
    monkeypatch.setenv("ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS", "true")
    with pytest.raises(BrowserRefused, match="TELEMETRY_CONTENT_REFUSED"):
        await NativeAdkBrowserModel(manifest, model).run(
            control=runtime, processing=process, goal=process.task_goal
        )
    assert len(requests) == completed_request_count + 1


def _approve_processing(consent, process):
    consent.approve(
        "model_process",
        {
            "fields": [],
            "values": {},
            "model": process.model_name,
            "transport": process.transport,
            "origins": list(process.allowed_origins),
            "screen_processing": True,
            "task_goal": process.task_goal,
            "result_storage": "owner_encrypted_log",
        },
    )
