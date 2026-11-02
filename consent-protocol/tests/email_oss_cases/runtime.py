"""Real create_agent graph, fake model/provider: protocol and authority regressions."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from hushh_mcp.services.email_oss.history import sanitize_email_history
from hushh_mcp.services.email_oss.runtime import EmailAgentRuntime, review_arguments_digest
from tests.helpers.email_oss import Execution, ToolModel, call, make_runtime, turn


@pytest.mark.asyncio
async def test_standard_graph_pairs_tool_results_and_returns_natural_final_answer():
    runtime, model, execution = make_runtime(
        [
            AIMessage(
                content="", tool_calls=[call("search_threads", {"q": "invoice", "max_results": 7})]
            ),
            AIMessage(content="I found one invoice; its amount is unavailable."),
        ]
    )
    events = [
        event
        async for event in runtime.stream_turn(
            **turn(
                current_memory_md="## Facts\n- I work at Acme",
                now_utc=datetime(2026, 11, 2, tzinfo=timezone.utc),
                timezone="Asia/Kolkata",
            )
        )
    ]
    result = events[-1]["result"]
    assert result["response"] == "I found one invoice; its amount is unavailable."
    assert result["status"] == "ok" and result["performance"]["model_calls"] == 2
    assert any(event.get("text") == result["response"] for event in events)
    assert len(execution.calls) == 1
    response = next(item for item in model.seen[1] if isinstance(item, ToolMessage))
    assert response.tool_call_id == "call-1" and response.name == "search_threads"
    assert json.loads(response.content)["messages"][0]["amount"] is None
    assert "2026-11-02" in model.seen[0][0].content and "Asia/Kolkata" in model.seen[0][0].content
    assert "I work at Acme" in model.seen[0][0].content


@pytest.mark.asyncio
async def test_parallel_calls_keep_each_original_id_and_router_binds_real_subset():
    async def router(prompt):
        return SimpleNamespace(tool_names=("search_threads", "get_connection_status"))

    runtime, model, execution = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call("search_threads", {"q": "invoice"}, "invoice-call"),
                    call("get_connection_status", {}, "status-call"),
                ],
            ),
            AIMessage(content="The invoice search completed; connection status is unknown."),
        ],
        router=router,
    )
    result = await runtime.handle_turn(**turn())
    assert result["status"] == "ok"
    assert model.bound_tools == ["search_threads", "get_connection_status"]
    assert {
        message.tool_call_id for message in model.seen[1] if isinstance(message, ToolMessage)
    } == {"invoice-call", "status-call"}
    assert result["performance"]["tool_calls"] == 2 and len(execution.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("approved", [False, True])
async def test_send_requires_exact_review_receipt_negative_control(approved):
    class Review:
        async def review(self, context, name, arguments):
            return {
                "status": "approved",
                "approved": True,
                "tool_name": name,
                "receipt": "existing-ledger-receipt",
                "arguments_sha256": review_arguments_digest(arguments)
                if approved
                else "wrong-arguments",
            }

    envelope = {"to": "recipient@example.com", "subject": "Hello", "body": "Hello"}
    runtime, model, execution = make_runtime(
        [
            AIMessage(content="", tool_calls=[call("send_email", envelope)]),
            AIMessage(content="The requested send outcome is available above."),
        ],
        review_port=Review(),
    )
    result = await runtime.handle_turn(**turn())
    assert bool(execution.calls) is approved
    assert result["stateChanged"] is approved
    response = next(message for message in model.seen[1] if isinstance(message, ToolMessage))
    if not approved:
        assert json.loads(response.content)["executed"] is False


@pytest.mark.asyncio
async def test_pending_review_does_not_send_and_preserves_directive():
    class Review:
        async def review(self, context, name, arguments):
            return {
                "status": "confirmation_required",
                "directive": {"kind": "existing_send_review", "proposal_id": "proposal1"},
            }

    runtime, _, execution = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "send_email",
                        {"to": "recipient@example.com", "subject": "Hello", "body": "Hello"},
                    )
                ],
            ),
            AIMessage(content="Review the email in the card. It has not been sent."),
        ],
        review_port=Review(),
    )
    result = await runtime.handle_turn(**turn())
    assert execution.calls == [] and result["stateChanged"] is False
    assert result["directives"] == [{"kind": "existing_send_review", "proposal_id": "proposal1"}]


@pytest.mark.asyncio
async def test_pending_memory_save_requires_actual_acknowledgment():
    class Memory:
        def save_to_memory_md(self, domain_tag, fact_markdown):
            return {
                "status": "pending_client_commit",
                "saved": False,
                "directive": {"kind": "email_memory_save", "request_id": "request1"},
            }

    runtime, _, _ = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "save_to_memory_md",
                        {"domain_tag": "preferences", "fact_markdown": "I prefer short replies."},
                    )
                ],
            ),
            AIMessage(content="Please confirm saving that preference."),
        ],
        memory_port=Memory(),
    )
    result = await runtime.handle_turn(**turn())
    assert result["stateChanged"] is False and result["directive"]["kind"] == "email_memory_save"


@pytest.mark.asyncio
async def test_native_draft_creation_has_no_send_review():
    runtime, _, execution = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "create_draft",
                        {"to": "recipient@example.com", "subject": "Hello", "body": "Hello"},
                    )
                ],
            ),
            AIMessage(content="The draft is saved in Gmail. It has not been sent."),
        ]
    )
    result = await runtime.handle_turn(**turn())
    assert execution.calls[0][0] == "create_draft" and result["stateChanged"] is True


@pytest.mark.asyncio
async def test_attachment_uses_inventory_scanner_parser_then_final_model_answer():
    scans, parses = [], []

    class Scanner:
        async def scan(self, content):
            scans.append(content)

    class Parser:
        async def parse(self, **kwargs):
            parses.append(kwargs)
            return SimpleNamespace(pages=("Invoice amount: missing",), truncated=False)

    runtime, model, execution = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[call("get_attachment", {"message_id": "m1", "attachment_id": "a1"})],
            ),
            AIMessage(content="The PDF has no readable amount, so I cannot total it."),
        ],
        attachment_scanner=Scanner(),
        attachment_parser=Parser(),
    )
    result = await runtime.handle_turn(**turn())
    assert result["status"] == "ok" and len(scans) == len(parses) == 1
    assert [name for name, _ in execution.calls] == ["get_message", "get_attachment"]
    result_text = next(
        message.content for message in model.seen[1] if isinstance(message, ToolMessage)
    )
    assert "Invoice amount: missing" in result_text and "%PDF-test" not in result_text


@pytest.mark.asyncio
async def test_model_limit_is_error_not_tool_result_or_fabricated_final_success():
    runtime, _, _ = make_runtime(
        [
            AIMessage(content="", tool_calls=[call("search_threads", {"q": "invoice"})]),
            AIMessage(content="This final response must not be reached."),
        ],
        max_model_calls=1,
    )
    result = await runtime.handle_turn(**turn())
    assert result["status"] == "unavailable" and result["performance"]["model_calls"] == 1
    assert result["response"] != "This final response must not be reached."


@pytest.mark.asyncio
async def test_authority_is_rechecked_after_model_and_prevents_tool_execution():
    checks = 0

    async def revoked():
        nonlocal checks
        checks += 1
        if checks >= 3:
            raise PermissionError("revoked")

    runtime, _, execution = make_runtime(
        [
            AIMessage(content="", tool_calls=[call("search_threads", {"q": "invoice"})]),
            AIMessage(content="not reached"),
        ]
    )
    result = await runtime.handle_turn(**turn(require_access=revoked))
    assert result["code"] == "email_authority_changed" and execution.calls == []


def test_history_repairs_names_chronologically_without_global_id_deduplication():
    history = [
        HumanMessage(content="first"),
        AIMessage(content="", tool_calls=[call("unknown", {}, "reused")]),
        ToolMessage(content="first result", tool_call_id="reused", name="search_threads"),
        ToolMessage(content="duplicate", tool_call_id="reused", name="search_threads"),
        HumanMessage(content="second"),
        AIMessage(content="", tool_calls=[call("get_message", {"message_id": "m1"}, "reused")]),
        ToolMessage(content="second result", tool_call_id="reused", name="get_message"),
        ToolMessage(content="orphan", tool_call_id="orphan", name="get_message"),
        HumanMessage(content="third"),
        AIMessage(content="", tool_calls=[call("send_email", {}, "interrupted")]),
    ]
    result = sanitize_email_history(history, {"search_threads", "get_message", "send_email"})
    assistants = [message for message in result if isinstance(message, AIMessage)]
    tools = [message for message in result if isinstance(message, ToolMessage)]
    assert [message.tool_calls[0]["name"] for message in assistants] == [
        "search_threads",
        "get_message",
        "send_email",
    ]
    assert [message.content for message in tools[:2]] == ["first result", "second result"]
    assert tools[-1].status == "error" and "unknown" in tools[-1].content
    assert all(message.tool_call_id != "orphan" for message in tools)


def test_ambiguous_unknown_history_name_is_not_repaired():
    result = sanitize_email_history(
        [
            HumanMessage(content="find mail"),
            AIMessage(content="", tool_calls=[call("unknown", {}, "ambiguous")]),
            ToolMessage(content="one", tool_call_id="ambiguous", name="search_threads"),
            ToolMessage(content="two", tool_call_id="ambiguous", name="get_message"),
        ],
        {"search_threads", "get_message"},
    )
    assert len(result) == 1 and isinstance(result[0], HumanMessage)


@pytest.mark.asyncio
async def test_parallel_duplicate_drafts_execute_at_most_once():
    arguments = {"to": "person@example.test", "subject": "Invoice", "body": "Please review."}
    runtime, model, execution = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call("create_draft", arguments, "draft-a"),
                    call("create_draft", arguments, "draft-b"),
                ],
            ),
            AIMessage(content="One draft was created; the duplicate request was blocked."),
        ]
    )
    result = await runtime.handle_turn(**turn())
    assert result["status"] == "ok" and len(execution.calls) == 1
    assert len(result["effects"]) == 1
    observations = [
        json.loads(item.content) for item in model.seen[1] if isinstance(item, ToolMessage)
    ]
    assert any(item.get("code") == "duplicate_effect_blocked" for item in observations)


@pytest.mark.asyncio
async def test_uncertain_draft_aborts_without_replanning_or_retry():
    class UncertainError(RuntimeError):
        outcome_unknown = True

    class UncertainExecution(Execution):
        async def create_draft(self, **arguments):
            self.calls.append(("create_draft", arguments))
            raise UncertainError("provider response unavailable")

    execution = UncertainExecution()
    runtime, model, _ = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "create_draft",
                        {
                            "to": "person@example.test",
                            "subject": "Invoice",
                            "body": "Please review.",
                        },
                    )
                ],
            ),
            AIMessage(content="must not retry"),
        ],
        execution=execution,
    )
    result = await runtime.handle_turn(**turn())
    assert result["code"] == "email_effect_outcome_unknown"
    assert len(model.seen) == len(execution.calls) == 1
    assert result["stateChanged"] is False
    assert result["uncertainEffects"] == [{"tool": "create_draft", "status": "outcome_unknown"}]


@pytest.mark.asyncio
@pytest.mark.parametrize("chunks", [1, 50, 200])
async def test_gmail_admission_is_per_message_not_per_stream_delta(chunks):
    from unittest.mock import AsyncMock

    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGenerationChunk

    class StreamModel(ToolModel):
        async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
            for _ in range(chunks):
                yield ChatGenerationChunk(message=AIMessageChunk(content="x", id="one-answer"))

    model = StreamModel(responses=[AIMessage(content="x" * chunks)])
    check = AsyncMock()
    runtime = EmailAgentRuntime(
        model_factory=lambda _: model, execution_factory=lambda _: Execution()
    )
    result = await runtime.handle_turn(**turn(require_access=check))
    assert result["status"] == "ok" and result["response"] == "x" * chunks
    assert check.await_count == 5


@pytest.mark.asyncio
async def test_missing_invoice_amount_never_becomes_zero_in_memory():
    class UnreadInvoice(Execution):
        async def get_message(self, **kwargs):
            return {
                "id": "m1",
                "body": "Invoice attached. Amount is unavailable.",
                "attachments": [],
            }

    class Memory:
        calls = []

        def save_to_memory_md(self, **kwargs):
            self.calls.append(kwargs)
            return {"saved": False}

    memory = Memory()
    runtime, model, _ = make_runtime(
        [
            AIMessage(content="", tool_calls=[call("get_message", {"message_id": "m1"})]),
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "save_to_memory_md",
                        {
                            "domain_tag": "finance",
                            "receipt_rows": [
                                {
                                    "currency": "USD",
                                    "amount": "0",
                                    "source_ref": "m1",
                                    "evidence_quote": "Amount is unavailable.",
                                }
                            ],
                        },
                        "save",
                    )
                ],
            ),
            AIMessage(content="The amount is unresolved; I did not save a zero amount."),
        ],
        execution=UnreadInvoice(),
        memory_port=memory,
    )
    result = await runtime.handle_turn(**turn())
    assert result["status"] == "ok" and not memory.calls
    tool = next(
        m for m in model.seen[-1] if isinstance(m, ToolMessage) and m.tool_call_id == "save"
    )
    assert json.loads(tool.content)["code"] == "receipt_sources_or_summary_invalid"


@pytest.mark.asyncio
async def test_old_client_binds_reads_without_unsupported_review_cards():
    runtime, model, _ = make_runtime(
        [AIMessage(content="Gmail can be read.")], supports_email_reviews=False
    )
    result = await runtime.handle_turn(**turn())
    assert result["status"] == "ok"
    assert {"search_threads", "get_message", "get_connection_status"} <= set(model.bound_tools)
    assert not {
        "send_email",
        "reply_to_thread",
        "trash_message",
        "batch_modify_messages",
        "save_to_memory_md",
    } & set(model.bound_tools)
