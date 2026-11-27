"""A receipt turn resumes once, and an invalid receipt call never reaches the device."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from ag_ui.core import ToolMessage, UserMessage
from ag_ui_adk import ADKAgent, AGUIToolset
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.events import Event
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from hushh_mcp.one_adk.receipt_client_tools import (
    STATE_RECEIPT_PENDING,
    STATE_RECEIPT_RESULT,
    before_receipt_tool,
    receipt_after_model,
    receipt_before_model,
)
from hushh_mcp.one_adk.receipt_turn_admission import admit_receipt_continuation
from hushh_mcp.one_adk.tool_history import validate_one_tool_result_history
from tests.test_receipt_client_tools import (
    APP,
    NAME,
    OWNER,
    QUERY,
    RESULT,
    THREAD,
    NoSweepSessionManager,
    SealedReadbackService,
    StubReceiptModel,
    run_input,
)

QUESTION = "What did I spend in the last 2 months"
STATE = {"hussh:user_id": OWNER, "hussh:consent_token": "synthetic-owner-ref"}


def _call(args: dict) -> types.Part:
    return types.Part(function_call=types.FunctionCall(name=NAME, args=args))


class _AzureLikeModel(BaseLlm):
    """Refuses a call without its result, as azure_adk._history does."""

    invalid_first: bool = False

    async def generate_content_async(self, llm_request, stream=False):
        ids = {"call": set(), "result": set()}
        for part in (p for content in llm_request.contents for p in content.parts or []):
            if part.function_call:
                ids["call"].add(part.function_call.id)
            if part.function_response:
                ids["result"].add(part.function_response.id)
        if ids["call"] - ids["result"]:
            raise ValueError("Azure history requires complete tool results and a request")
        last = llm_request.contents[-1]
        asks = last.role == "user" and any(QUESTION in (p.text or "") for p in last.parts or [])
        call = _call({} if self.invalid_first else dict(QUERY))  # {}: the copied stored call.
        part = call if asks else types.Part(text="ANSWER")
        yield LlmResponse(content=types.Content(role="model", parts=[part]), turn_complete=True)


def _agent(store, model: BaseLlm) -> ADKAgent:
    root = LlmAgent(
        name="one",
        model=model,
        tools=[AGUIToolset(tool_filter=[NAME])],
        before_tool_callback=lambda tool, args, context: before_receipt_tool(tool, args, context),
        before_model_callback=receipt_before_model,
        after_model_callback=receipt_after_model,
    )
    app = App(name=APP, root_agent=root, resumability_config=ResumabilityConfig(is_resumable=True))
    manager = NoSweepSessionManager(session_service=store, use_thread_id_as_session_id=True)
    return ADKAgent.from_app(
        app,
        user_id=OWNER,
        session_manager=manager,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
        emit_messages_snapshot=True,
    )


async def _receipt_turn(agent, store, run: str, resend_snapshot: bool) -> list[str]:
    user = UserMessage(id=f"client-user-{run}", role="user", content=QUESTION)
    first = [event async for event in agent.run(run_input(f"{run}-a", [user]))]
    call_id = next(e.tool_call_id for e in first if str(e.type).endswith("TOOL_CALL_END"))
    snapshot = next(e for e in first if str(e.type).endswith("MESSAGES_SNAPSHOT")).messages
    result = {"toolCallId": call_id, "toolName": NAME, "request": QUERY, "result": RESULT}
    receipt = {"schema": "receipt_result.v1", "operation": NAME, "ephemeral_result": True}
    wire = ToolMessage(
        id=f"tool-{run}", role="tool", tool_call_id=call_id, content=json.dumps(receipt)
    )
    # What the browser sent on UAT: run A's whole snapshot plus the tool result.
    messages = [m for m in snapshot if m.role != "reasoning"] if resend_snapshot else []
    messages.append(wire)
    reference = await admit_receipt_continuation(
        {"receiptToolResults": [result]},
        owner_id=OWNER,
        conversation_id=THREAD,
        messages=messages,
        execution_head=lambda: agent,
        load_session=lambda: store.get_session(app_name=APP, user_id=OWNER, session_id=THREAD),
    )
    state = {STATE_RECEIPT_RESULT: reference}
    second = [event async for event in agent.run(run_input(f"{run}-b", messages, **state))]
    return [str(getattr(event.type, "value", event.type)) for event in second]


async def test_continuation_with_the_whole_snapshot_resumes_once_and_stores_one_question():
    # UAT 2026-10-29: the bridge ran the question again beside the pending
    # receipt call, so every spending answer arrived in a failed turn.
    store = SealedReadbackService()
    agent = _agent(store, _AzureLikeModel(model="synthetic-azure-like"))
    await _receipt_turn(agent, store, "t1", resend_snapshot=False)
    kinds = await _receipt_turn(agent, store, "t2", resend_snapshot=True)

    assert kinds.count("RUN_STARTED") == 1 and "RUN_ERROR" not in kinds
    session = await store.get_session(app_name=APP, user_id=OWNER, session_id=THREAD)
    questions = [
        event
        for event in session.events
        if event.author == "user"
        and event.content
        and any(QUESTION in (part.text or "") for part in event.content.parts or [])
    ]
    assert len(questions) == 2


async def test_one_hub_resumes_the_receipt_and_reloads_the_redacted_history():
    from hushh_mcp.one_adk.agent_tree import build_one_text_agent
    from hushh_mcp.one_adk.agui_factory import build_authenticated_agui

    store = SealedReadbackService()
    model = StubReceiptModel(model="synthetic-receipt-probe", streamed_function_call=True)
    root = build_one_text_agent(
        model=model, allow_workspace_tools=True, include_thought_summaries=True
    )
    agent = build_authenticated_agui(root, store, app_name=APP, user_id_extractor=lambda _: OWNER)
    kinds = await _receipt_turn(agent, store, "hub", resend_snapshot=False)
    assert "RUN_FINISHED" in kinds and "RUN_ERROR" not in kinds
    assert model.calls == 2 and model.observations[-1]["private_label_seen"]

    followup = UserMessage(id="ordinary-user", role="user", content="An ordinary follow-up")
    events = [event async for event in agent.run(run_input("ordinary-run", [followup]))]
    kinds = [str(getattr(event.type, "value", event.type)) for event in events]
    assert "RUN_FINISHED" in kinds and "RUN_ERROR" not in kinds
    assert model.calls == 3 and not model.observations[-1]["private_label_seen"]


@pytest.mark.parametrize("mismatch", ["call_id", "branch", "operation", "payload", "name"])
def test_receipt_placeholder_requires_the_exact_preceding_call_and_safe_shape(mismatch):
    call = Event(
        author="one",
        invocation_id="synthetic",
        content=types.Content(
            role="model",
            parts=[types.Part(function_call=types.FunctionCall(id="receipt", name=NAME))],
        ),
    )
    placeholder = {
        "schema": "receipt_result.v1",
        "operation": "list_recent_receipts" if mismatch == "operation" else NAME,
        "ephemeral_result": True,
    }
    if mismatch == "payload":
        placeholder["unexpected_value"] = "synthetic"
    result = Event(
        author="user",
        invocation_id="synthetic",
        branch="different" if mismatch == "branch" else None,
        content=types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="other" if mismatch == "call_id" else "receipt",
                        name="wrong_name" if mismatch == "name" else "unknown",
                        response=placeholder,
                    )
                )
            ],
        ),
    )
    with pytest.raises(ValueError, match="preceding matching call"):
        validate_one_tool_result_history(
            SimpleNamespace(session=SimpleNamespace(events=[call, result])), None
        )


async def test_an_invalid_receipt_call_never_reaches_the_device():
    # Deferred to the device, an argument-less call also hid One's corrected call as its replay.
    store = SealedReadbackService()
    agent = _agent(store, _AzureLikeModel(model="synthetic-azure-like", invalid_first=True))
    user = UserMessage(id="client-user-bad", role="user", content=QUESTION)
    events = [event async for event in agent.run(run_input("bad-a", [user]))]

    kinds = [str(getattr(event.type, "value", event.type)) for event in events]
    assert not any(kind.startswith("TOOL_CALL") for kind in kinds) and "RUN_ERROR" in kinds
    session = await store.get_session(app_name=APP, user_id=OWNER, session_id=THREAD)
    assert not session.state.get(STATE_RECEIPT_PENDING)


@pytest.mark.parametrize("beside", [[], [types.Part(text="Let me check.")]])
def test_an_invalid_receipt_call_alone_fails_the_turn_closed(beside):
    state = dict(STATE)
    response = LlmResponse(content=types.Content(role="model", parts=[*beside, _call({})]))
    if beside:
        receipt_after_model(SimpleNamespace(state=state), response)
        assert [part.text for part in response.content.parts] == ["Let me check."]
    else:
        with pytest.raises(ValueError, match="Receipt request is invalid"):
            receipt_after_model(SimpleNamespace(state=state), response)
    assert STATE_RECEIPT_PENDING not in state


@pytest.mark.parametrize(
    ("limit", "expected"), [(None, 10), (5.0, 5), (5, 5), (5.5, None), (True, None)]
)
def test_the_hub_reads_a_receipt_limit_the_way_the_device_does(limit, expected):
    # The device reads a null limit as the default and JSON's 5.0 as 5; the hub refused
    # both, so a call the device answered had no binding and the turn failed.
    from hushh_mcp.one_adk.receipt_client_tools import validate_request

    if expected is None:
        with pytest.raises(ValueError, match="Invalid receipt limit"):
            validate_request(NAME, {**QUERY, "limit": limit})
        return
    request = validate_request(NAME, {**QUERY, "limit": limit})
    assert request["limit"] == expected and type(request["limit"]) is int
