"""Tests for the Gmail inbox agent chat runner.

Inject a fake model_call (the Gemini seam), real google.genai types, a fake chat
store, and a fake Gmail service — no live LLM, Gmail, or DB. Verifies the
function-calling loop dispatches the read-only inbox tools with the right args
and returns the model's final text.
"""

from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from hushh_mcp.services.email_chat_service import (
    _UNAVAILABLE_MESSAGE,
    EmailChatService,
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


class _FakeGmail:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_nudges(self, *, user_id, limit):
        self.calls.append(("list_nudges", user_id, limit))
        return {
            "account_email": "me@example.com",
            "nudges": [
                {
                    "type": "needs_reply",
                    "thread_id": "t1",
                    "message_id": "m1",
                    "title": "Q3 plan",
                    "sender": "Ravi",
                    "sender_email": "ravi@acme.com",
                    "received_at": None,
                }
            ],
        }

    async def search_inbox(self, *, user_id, query, limit):
        self.calls.append(("search_inbox", user_id, query, limit))
        return [
            {
                "thread_id": "t2",
                "subject": "Invoice",
                "from": "Acme Billing",
                "from_email": "billing@acme.com",
                "snippet": "Your invoice is ready",
                "received_at": None,
            }
        ]


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


def _service(*, store, gmail, responses, ready=True):
    return EmailChatService(
        chat_store=store,
        gmail_service=gmail,
        model_call=_scripted_model_call(responses),
        genai_types=types,
        ready=lambda: ready,
    )


async def test_needs_reply_tool_flow():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(
        store=store,
        gmail=gmail,
        responses=[
            _fc_response("list_needs_reply", {"limit": 5}),
            _text_response("You have 1 thread waiting: Q3 plan from Ravi."),
        ],
    )
    result = await svc.handle_turn(
        user_id="u1", message="what needs a reply?", consent_token=_TOKEN
    )
    assert result["response"] == "You have 1 thread waiting: Q3 plan from Ravi."
    assert result["conversationId"] == "conv-new"
    assert result["isComplete"] is True
    assert result["stateChanged"] is False
    # Tool dispatched with the bound user_id and the model-supplied limit.
    assert gmail.calls == [("list_nudges", "u1", 5)]
    assert store.added[-1]["role"] == "assistant"
    assert store.added[-1]["status"] == "complete"


async def test_search_inbox_tool_flow():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(
        store=store,
        gmail=gmail,
        responses=[
            _fc_response("search_inbox", {"query": "from:ravi newer_than:7d", "limit": 3}),
            _text_response("Found 1 match: Invoice from Acme Billing."),
        ],
    )
    result = await svc.handle_turn(
        user_id="u1", message="find emails from ravi", consent_token=_TOKEN
    )
    assert result["response"] == "Found 1 match: Invoice from Acme Billing."
    assert gmail.calls == [("search_inbox", "u1", "from:ravi newer_than:7d", 3)]


async def test_empty_message_returns_prompt_without_tools():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(store=store, gmail=gmail, responses=[])
    result = await svc.handle_turn(user_id="u1", message=None, consent_token=_TOKEN)
    assert result["isComplete"] is True
    assert "needs a reply" in result["response"].lower()
    assert gmail.calls == []


async def test_unavailable_when_model_not_ready():
    store, gmail = _FakeStore(), _FakeGmail()
    svc = _service(store=store, gmail=gmail, responses=[], ready=False)
    result = await svc.handle_turn(user_id="u1", message="hi", consent_token=_TOKEN)
    assert result["response"] == _UNAVAILABLE_MESSAGE
    assert result["isComplete"] is False
    assert gmail.calls == []
