"""Tests for the Gmail receipts agent chat runner.

Inject a fake model_call (the Gemini seam), real google.genai types, a fake
chat store, and a fake receipts service - no live LLM, Gmail, or DB. Verifies
the function-calling loop dispatches the read-only receipt tools with the
right args and returns the model's final text.
"""

from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from hushh_mcp.services.gmail_chat_service import (
    _UNAVAILABLE_MESSAGE,
    GmailChatService,
)

_TOKEN = "tok"  # noqa: S105 (test consent-token stub, not a real secret)


class _Turn:
    def __init__(self, conversation_id: str, history: list) -> None:
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self, history=None) -> None:
        self.history = history or []
        self.added: list[dict] = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", self.history)

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append({"role": role, "content": content, "status": status})


class _FakeReceipts:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_receipts(self, *, user_id, page, per_page):
        self.calls.append(("list_receipts", user_id, page, per_page))
        return {
            "items": [
                {
                    "merchant_name": "Blue Bottle",
                    "amount": 14.5,
                    "currency": "USD",
                    "receipt_date": "2026-07-01",
                    "order_id": "o1",
                }
            ],
            "page": page,
            "total": 1,
        }

    async def get_status(self, *, user_id):
        self.calls.append(("get_status", user_id))
        return {"connected": True, "account_email": "me@example.com", "latest_run": "ok"}


def _fc_response(name: str, args: dict):
    return SimpleNamespace(
        function_calls=[SimpleNamespace(name=name, args=args)],
        text="",
        candidates=[
            SimpleNamespace(content=types.Content(role="model", parts=[types.Part(text="")]))
        ],
    )


def _text_response(text: str):
    return SimpleNamespace(function_calls=[], text=text, candidates=[])


def _scripted_model_call(responses: list):
    seq = iter(responses)

    async def _call(contents, config):
        return next(seq)

    return _call


def _service(*, store, receipts, responses, ready=True):
    return GmailChatService(
        chat_store=store,
        gmail_service=receipts,
        model_call=_scripted_model_call(responses),
        genai_types=types,
        ready=lambda: ready,
    )


async def test_list_receipts_tool_flow():
    store, receipts = _FakeStore(), _FakeReceipts()
    svc = _service(
        store=store,
        receipts=receipts,
        responses=[
            _fc_response("list_receipts", {"page": 1, "per_page": 5}),
            _text_response("Your latest receipt is $14.50 at Blue Bottle on July 1."),
        ],
    )
    result = await svc.handle_turn(user_id="u1", message="show my receipts", consent_token=_TOKEN)
    assert result["response"] == "Your latest receipt is $14.50 at Blue Bottle on July 1."
    assert result["conversationId"] == "conv-new"
    assert result["isComplete"] is True
    assert result["stateChanged"] is False
    assert receipts.calls == [("list_receipts", "u1", 1, 5)]
    assert store.added[-1]["role"] == "assistant"
    assert store.added[-1]["status"] == "complete"


async def test_sync_status_tool_flow():
    store, receipts = _FakeStore(), _FakeReceipts()
    svc = _service(
        store=store,
        receipts=receipts,
        responses=[
            _fc_response("sync_status", {}),
            _text_response("Receipt sync is connected for me@example.com and healthy."),
        ],
    )
    result = await svc.handle_turn(
        user_id="u1", message="is my receipt sync working?", consent_token=_TOKEN
    )
    assert result["response"] == "Receipt sync is connected for me@example.com and healthy."
    assert receipts.calls == [("get_status", "u1")]


async def test_empty_message_prompts_without_model_call():
    store, receipts = _FakeStore(), _FakeReceipts()
    svc = _service(store=store, receipts=receipts, responses=[])
    result = await svc.handle_turn(user_id="u1", message="", consent_token=_TOKEN)
    assert "receipts" in result["response"]
    assert receipts.calls == []
    assert store.added == []


async def test_unready_model_returns_unavailable():
    store, receipts = _FakeStore(), _FakeReceipts()
    svc = _service(store=store, receipts=receipts, responses=[], ready=False)
    result = await svc.handle_turn(user_id="u1", message="show receipts", consent_token=_TOKEN)
    assert result["response"] == _UNAVAILABLE_MESSAGE
    assert result["isComplete"] is False
    assert store.added[-1]["status"] == "error"
