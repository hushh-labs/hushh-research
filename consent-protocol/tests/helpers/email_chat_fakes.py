"""Synthetic Gmail/store ports shared by the Email service contracts."""

from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from hushh_mcp.services.email_chat_service import EmailChatService

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

    async def list_receipts(self, *, user_id, page, per_page):
        self.calls.append(("list_receipts", user_id, page, per_page))
        return {"items": [], "page": page, "total": 0}

    async def get_status(self, *, user_id):
        self.calls.append(("get_status", user_id))
        return {"connected": True, "latest_run": "ok"}


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
