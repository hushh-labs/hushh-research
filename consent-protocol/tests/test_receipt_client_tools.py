"""Receipt native client-tool roundtrip through production encrypted projection."""

from __future__ import annotations

import json
import os
import time
import uuid

os.environ.setdefault("TESTING", "true")
os.environ.setdefault("DB_OFFLINE", "1")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "hushh-ci-test")
os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

import pytest
from ag_ui.core import RunAgentInput, Tool, ToolMessage, UserMessage
from ag_ui_adk import ADKAgent, AGUIToolset
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import Session
from google.adk.sessions.base_session_service import BaseSessionService, ListSessionsResponse
from google.genai import types

from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.receipt_client_tools import (
    PRIVATE_RECEIPT_ANSWER,
    STATE_RECEIPT_PENDING,
    STATE_RECEIPT_PRIVATE,
    STATE_RECEIPT_RESULT,
    admit_receipt_result,
    before_receipt_tool,
    read_receipt_continuation_session,
    receipt_after_model,
    receipt_before_model,
    receipt_tool_declaration,
)
from tests.helpers.chat_keys import static_chat_cipher

NAME = "receipt_spending"
OWNER = "synthetic-owner"
THREAD = "synthetic-thread"
APP = "receiptprobe"
QUERY = {
    "from_date": "2026-01-01",
    "to_date": "2027-01-01",
    "timezone": "UTC",
    "group_by": "merchant",
    "limit": 10,
}
PRIVATE_LABEL = "SYNTHETIC_PRIVATE_MERCHANT"
PRIVATE_ANSWER = "SYNTHETIC_PRIVATE_RECEIPT_ANSWER 7.00"
ORDINARY_ANSWER = "SYNTHETIC_ORDINARY_ANSWER"
RESULT = {
    "schema": "receipt_analysis.v1",
    "operation": NAME,
    "requested_range": {
        "from": QUERY["from_date"],
        "to": QUERY["to_date"],
        "end_exclusive": True,
        "timezone": "UTC",
    },
    "source_freshness": "2026-10-13T00:00:00Z",
    "snapshot_revision": 1,
    "canonical_transaction_count": 1,
    "matched_count": 1,
    "included_count": 1,
    "coverage": {
        "partial": False,
        "truncated": False,
        "source_count": 1,
        "window_from": "2026-01-01",
        "window_to": "2026-12-31",
        "source": "gmail_live",
        "undated_count": 0,
        "excluded_from_paid_count": 0,
    },
    "truncated": False,
    "dedupe_policy": "Mail canonical groups",
    "refund_handling": {
        "record_count": 0,
        "amount": None,
        "net": None,
        "policy": "Verified refund allocation unavailable",
    },
    "cancellation_handling": "Excluded unpaid records",
    "limitations": ["Observed Mail receipts only"],
    "status": "ok",
    "group_by": "merchant",
    "currency_totals": [
        {
            "currency": "USD",
            "paid_amount": "7.00",
            "paid_transaction_count": 1,
            "refund_amount": None,
            "net_amount": "7.00",
        }
    ],
    "results": [
        {
            "label": PRIVATE_LABEL,
            "currency": "USD",
            "paid_amount": "7.00",
            "paid_transaction_count": 1,
            "rank": 1,
            "refund_amount": None,
            "net_amount": "7.00",
        }
    ],
}


class SealedReadbackService(BaseSessionService):
    """Use the production encrypted projection, with no database or live aliases.

    Every get decrypts a fresh Session. This deliberately reproduces the storage
    boundary that InMemorySessionService misses: deferred ToolContext mutations
    do not persist until an event is appended and sealed.
    """

    def __init__(self):
        self.rows = {}
        self.codec = EncryptedAdkSessionService(static_chat_cipher())

    @staticmethod
    def key(session):
        return session.app_name, session.user_id, session.id

    def save(self, session):
        self.rows[self.key(session)] = {
            f"payload_{key}": value for key, value in self.codec._encode(session).items()
        }

    async def create_session(self, *, app_name, user_id, state=None, session_id=None):
        session = Session(
            app_name=app_name,
            user_id=user_id,
            id=session_id or str(uuid.uuid4()),
            state=state or {},
        )
        self.save(session)
        return session

    async def get_session(self, *, app_name, user_id, session_id, config=None):
        row = self.rows.get((app_name, user_id, session_id))
        return (
            self.codec._decode(row, app_name=app_name, user_id=user_id, session_id=session_id)
            if row
            else None
        )

    async def list_sessions(self, *, app_name, user_id=None):
        return ListSessionsResponse(sessions=[])

    async def delete_session(self, *, app_name, user_id, session_id):
        self.rows.pop((app_name, user_id, session_id), None)

    async def append_event(self, session, event):
        appended = await super().append_event(session, event)
        if not event.partial:
            self.save(session)
        return appended


class NoSweepSessionManager(SessionManager):
    def _start_cleanup_task(self):
        return None


class StubReceiptModel(BaseLlm):
    calls: int = 0
    streamed_function_call: bool = False
    observations: list[dict] = []

    async def generate_content_async(self, llm_request, stream=False):
        self.calls += 1
        prompt = json.dumps(
            [content.model_dump(mode="json", exclude_none=True) for content in llm_request.contents]
        )
        self.observations.append(
            {
                "private_label_seen": PRIVATE_LABEL in prompt,
                "private_answer_seen": PRIVATE_ANSWER in prompt,
            }
        )
        if self.calls == 1:
            assert PRIVATE_LABEL not in prompt
            if self.streamed_function_call:
                yield LlmResponse(
                    content=types.Content(
                        role="model",
                        parts=[
                            types.Part(
                                function_call=types.FunctionCall(name=NAME, args=dict(QUERY))
                            )
                        ],
                    ),
                    partial=True,
                    turn_complete=False,
                )
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(function_call=types.FunctionCall(name=NAME, args=dict(QUERY)))
                    ],
                ),
                partial=False,
                turn_complete=True,
            )
        elif self.calls == 2:
            assert PRIVATE_LABEL in prompt, "The authorized result must reach this model request"
            assert "7.00" in prompt
            config = llm_request.config.tool_config.function_calling_config
            assert str(config.mode).endswith("NONE")
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text=PRIVATE_ANSWER)]),
                partial=False,
                turn_complete=True,
            )
        else:
            assert PRIVATE_LABEL not in prompt and PRIVATE_ANSWER not in prompt, (
                "Later ordinary turn must not replay receipt detail"
            )
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text=ORDINARY_ANSWER)]),
                partial=False,
                turn_complete=True,
            )


def state(**extra):
    return {
        "hussh:user_id": OWNER,
        "hussh:consent_token": "synthetic-owner-ref",
        "hussh:conversation_id": THREAD,
        "hussh:timezone": "UTC",
        **extra,
    }


def run_input(run_id, messages, **extra_state):
    return RunAgentInput(
        thread_id=THREAD,
        run_id=run_id,
        state=state(**extra_state),
        messages=messages,
        tools=[Tool(**receipt_tool_declaration(NAME))],
        context=[],
        forwarded_props={},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "streamed_function_call", [False, True], ids=["native-final", "native-partial-final"]
)
@pytest.mark.parametrize(
    "same_worker", [False, True], ids=["cross-worker-reread", "same-worker-producer"]
)
async def test_native_receipt_result_current_turn_only_and_encrypted_reload(
    streamed_function_call, same_worker
):
    store = SealedReadbackService()
    model = StubReceiptModel(
        model="synthetic-receipt-probe", streamed_function_call=streamed_function_call
    )

    def gate(tool, args, tool_context):
        return before_receipt_tool(tool, args, tool_context)

    root = LlmAgent(
        name="one",
        model=model,
        tools=[AGUIToolset(tool_filter=[NAME])],
        before_tool_callback=gate,
        before_model_callback=receipt_before_model,
        after_model_callback=receipt_after_model,
    )
    app = App(name=APP, root_agent=root, resumability_config=ResumabilityConfig(is_resumable=True))
    manager = NoSweepSessionManager(session_service=store, use_thread_id_as_session_id=True)
    agent = ADKAgent.from_app(
        app,
        user_id=OWNER,
        session_manager=manager,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
        emit_messages_snapshot=True,
    )
    user = UserMessage(id="synthetic-user-1", role="user", content="Show spending by merchant")
    initial_events = [event async for event in agent.run(run_input("synthetic-run-1", [user]))]
    assert not any(str(event.type).endswith("RUN_ERROR") for event in initial_events)
    calls = [event for event in initial_events if str(event.type).endswith("TOOL_CALL_END")]
    assert len(calls) == 1
    call_id = calls[0].tool_call_id
    loads = 0

    async def read_sealed():
        nonlocal loads
        loads += 1
        return await store.get_session(app_name=APP, user_id=OWNER, session_id=THREAD)

    started = time.perf_counter()
    saved = await read_receipt_continuation_session(
        agent if same_worker else None,
        read_sealed,
        owner_id=OWNER,
        conversation_id=THREAD,
        results=[{"toolCallId": call_id, "toolName": NAME, "request": QUERY, "result": RESULT}],
    )
    elapsed = time.perf_counter() - started
    print(
        f"settling same_worker={same_worker} streamed={streamed_function_call} loads={loads} elapsed_ms={elapsed * 1000:.2f}"
    )
    assert 1 <= loads <= 20
    assert elapsed < 2.5
    assert call_id in saved.state["pending_tool_calls"]
    actual_call_id = saved.state.get("lro_tool_call_id_remap", {}).get(call_id, call_id)
    assert saved.state[STATE_RECEIPT_PENDING][actual_call_id]["operation"] == NAME
    assert model.calls == 1
    saved_calls = [
        part.function_call
        for event in saved.events
        if event.content
        for part in event.content.parts or []
        if part.function_call
    ]
    assert saved_calls and saved_calls[0].args == {}, "Receipt query args are not durable"

    wire = ToolMessage(
        id="synthetic-tool-result",
        role="tool",
        tool_call_id=call_id,
        content=json.dumps(
            {"schema": "receipt_result.v1", "operation": NAME, "ephemeral_result": True}
        ),
    )
    assert PRIVATE_LABEL not in wire.content and "7.00" not in wire.content
    forwarded = {
        "receiptToolResults": [
            {"toolCallId": call_id, "toolName": NAME, "request": QUERY, "result": RESULT}
        ]
    }
    reference = admit_receipt_result(
        forwarded, owner_id=OWNER, conversation_id=THREAD, session=saved, messages=[user, wire]
    )
    assert "receiptToolResults" not in forwarded
    assistant = {
        "id": "synthetic-assistant-call",
        "role": "assistant",
        "toolCalls": [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": NAME, "arguments": json.dumps(QUERY)},
            }
        ],
    }
    continuation_events = [
        event
        async for event in agent.run(
            run_input(
                "synthetic-run-2", [user, assistant, wire], **{STATE_RECEIPT_RESULT: reference}
            )
        )
    ]
    assert not any(str(event.type).endswith("RUN_ERROR") for event in continuation_events)
    live_text = "".join(
        event.delta
        for event in continuation_events
        if hasattr(event, "delta") and isinstance(event.delta, str)
    )
    assert PRIVATE_ANSWER in live_text, "The active authorized turn should display its answer"
    assert model.calls == 2 and model.observations[1]["private_label_seen"]
    restored = await store.get_session(app_name=APP, user_id=OWNER, session_id=THREAD)
    restored_json = restored.model_dump_json()

    def string_values(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for child in value.values():
                yield from string_values(child)
        elif isinstance(value, list):
            for child in value:
                yield from string_values(child)

    # Money is a decimal string in this contract. Searching serialized JSON
    # also matches innocent numeric timestamps ending in e.g. 1997.001327.
    assert (
        PRIVATE_LABEL not in restored_json
        and PRIVATE_ANSWER not in restored_json
        and not any("7.00" in text for text in string_values(json.loads(restored_json)))
    )
    assert PRIVATE_RECEIPT_ANSWER in restored_json and restored.state[STATE_RECEIPT_PRIVATE]
    assert STATE_RECEIPT_RESULT not in restored_json and reference not in restored_json

    ordinary = UserMessage(id="synthetic-user-ordinary", role="user", content="Say hello")
    ordinary_events = [event async for event in agent.run(run_input("synthetic-run-3", [ordinary]))]
    assert not any(str(event.type).endswith("RUN_ERROR") for event in ordinary_events)
    control = await store.get_session(app_name=APP, user_id=OWNER, session_id=THREAD)
    control_json = control.model_dump_json()
    assert ORDINARY_ANSWER in control_json, "Unrelated assistant answers remain durable"
    assert (
        PRIVATE_LABEL not in control_json
        and PRIVATE_ANSWER not in control_json
        and not any("7.00" in text for text in string_values(json.loads(control_json)))
    )
    assert model.calls == 3


@pytest.mark.parametrize(
    "mutation",
    [
        lambda result: result.update(body="RAW_BODY"),
        lambda result: result["results"][0].update(subject="RAW_SUBJECT"),
        lambda result: result["results"][0].update(label="billing@example.com"),
        lambda result: result["results"][0].update(label={"subject": "RAW_SUBJECT"}),
        lambda result: result.update(source_freshness={"body": "RAW_BODY"}),
        lambda result: result.update(limitations=[{"sender": "RAW_SENDER"}]),
        lambda result: result["refund_handling"].update(policy={"body": "RAW_BODY"}),
        lambda result: result["results"][0].update(paid_amount=7.0),
        lambda result: result["refund_handling"].update(amount="7.00"),
        lambda result: result["currency_totals"][0].update(currency=["USD"]),
        lambda result: result["currency_totals"][0].update(net_amount="6.00"),
        lambda result: result["currency_totals"][0].update(paid_transaction_count=2),
    ],
)
def test_result_envelope_rejects_raw_fields_and_unsupported_evidence(mutation):
    import copy

    from hushh_mcp.one_adk.receipt_client_tools import validate_result

    result = copy.deepcopy(RESULT)
    mutation(result)
    with pytest.raises(ValueError):
        validate_result(NAME, QUERY, result)


async def test_owner_gate_and_consumed_pending_bindings():
    from types import SimpleNamespace

    from hushh_mcp.one_adk.request_secrets import store_request_secret

    context = SimpleNamespace(state={}, function_call_id="call")
    assert (
        before_receipt_tool(SimpleNamespace(name=NAME), QUERY, context)["code"] == "vault_required"
    )
    context.state = state()
    context.invocation_id = "resumed"
    context.state[STATE_RECEIPT_PENDING] = {str(i): {"operation": NAME} for i in range(4)}
    context.state[STATE_RECEIPT_RESULT] = store_request_secret(
        json.dumps(
            {
                "owner": OWNER,
                "conversation": THREAD,
                "results": [
                    {"call_id": str(i), "operation": NAME, "result": RESULT} for i in range(4)
                ],
            }
        ),
        ttl_seconds=60,
    )
    request = SimpleNamespace(contents=[], config=types.GenerateContentConfig())
    receipt_before_model(context, request)
    assert context.state[STATE_RECEIPT_PENDING] == {}
    assert PRIVATE_LABEL in request.contents[-1].parts[0].text
    receipt_after_model(
        context,
        LlmResponse(content=types.Content(parts=[types.Part(text="answer")]), partial=False),
    )
    assert context.state[STATE_RECEIPT_RESULT] == ""


def test_private_receipt_result_cannot_escape_through_another_tool():
    from types import SimpleNamespace

    from google.adk.events import Event

    from hushh_mcp.one_adk.agent_tree import _before_one_tool
    from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection

    context = SimpleNamespace(
        state={STATE_RECEIPT_PRIVATE: ["receipt-results"]}, invocation_id="receipt-results"
    )
    assert (
        _before_one_tool(SimpleNamespace(name="unrelated_tool"), {"query": PRIVATE_LABEL}, context)[
            "code"
        ]
        == "receipt_result_turn_is_read_only"
    )
    session = Session(
        id=THREAD,
        user_id=OWNER,
        app_name=APP,
        state=context.state,
        events=[
            Event(
                author="one",
                invocation_id="receipt-request",
                content=types.Content(
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(name=NAME, id="request", args=QUERY)
                        ),
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="ordinary_tool", response={"value": ORDINARY_ANSWER}
                            )
                        ),
                    ]
                ),
            ),
            Event(
                author="one",
                invocation_id="receipt-results",
                content=types.Content(
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="unrelated_tool", args={"query": PRIVATE_LABEL}
                            )
                        ),
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="unrelated_tool", response={"value": PRIVATE_LABEL}
                            )
                        ),
                    ]
                ),
            ),
        ],
    )
    assert PRIVATE_LABEL in session.model_dump_json(), "Negative control contains the detail"
    projected = durable_external_read_projection(session).model_dump_json()
    assert PRIVATE_LABEL not in projected
    assert ORDINARY_ANSWER in projected, "Earlier governed tool history remains intact"
