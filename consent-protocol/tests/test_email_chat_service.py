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


async def test_private_email_runs_shared_loop_with_scoped_broker_and_owner_store(monkeypatch):
    from unittest.mock import AsyncMock

    import pytest

    from hushh_mcp.adk_bridge import _register_builtin_specialists
    from hushh_mcp.adk_bridge.contract import A2AAuthorityContext, A2ATask
    from hushh_mcp.adk_bridge.dispatch import bind_specialist_runtime, dispatch
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services import pod_consent_client, pod_memory_service, pod_specialist_runtime
    from hushh_mcp.services.pod_consent_client import ConsentVerdict
    from hushh_mcp.services.pod_hub_client import PodHubClient

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_ID", "pod-owner")
    revoked = False

    async def verify(token, *, expected_scope):
        scopes = {"read": "pkm.read", "email-view": "cap.email.inbox.view"}
        valid = scopes.get(token) == expected_scope and not (revoked and token == "email-view")
        return ConsentVerdict(valid, True, "owner", "pod-owner")

    monkeypatch.setattr(pod_consent_client, "verify_consent", verify)
    log = SimpleNamespace(_owner_id="pod-owner", require_open=AsyncMock())
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)
    store = _FakeStore()
    stores = []

    def local_store(**kwargs):
        stores.append(kwargs)
        return store

    monkeypatch.setattr(pod_specialist_runtime, "PodAgentChatStore", local_store)
    responses = iter(
        [
            _fc_response("search_inbox", {"query": "subject:invoice", "limit": 2}),
            _text_response("One invoice from Billing."),
        ]
    )
    calls = []

    async def generate(**kwargs):
        calls.append(True)
        return next(responses)

    client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
    monkeypatch.setattr(factory, "build_managed_runtime_client", lambda provider: client)
    reads = []

    def read(_self, name, token, **kwargs):
        reads.append((name, token, kwargs))
        return {"results": [{"subject": "Invoice", "from": "Billing", "snippet": "Ready"}]}

    monkeypatch.setattr(PodHubClient, "read_specialist", read)
    runtime = pod_specialist_runtime.build_pod_specialist_runtime(
        user_id="owner",
        hushh_id="pod-owner",
        consent_token="read",  # noqa: S106
        provider="gemini",
        model="synthetic",
        runtime_mode="user_adc",
        credential=None,
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants={"email": "email-view"},
    )
    task = A2ATask(
        user_id="owner",
        consent_token="read",  # noqa: S106 -- synthetic scope token
        conversation_id="thread",
        message="Find my invoice",
        authority=A2AAuthorityContext(
            "owner",
            "owner",
            "thread",
            "first_party",
            invocation_capabilities=("cap.one.invoke",),
        ),
    )
    _register_builtin_specialists()
    with bind_specialist_runtime(runtime):
        result = await dispatch("agent_email", task)
        assert result.text == "One invoice from Billing."
        assert result.directive is None and not result.state_changed
        assert stores[0]["log"] is log and stores[0]["agent_id"] == "agent_email"
        assert reads == [
            (
                "email",
                "email-view",
                {
                    "email_read": {
                        "operation": "search",
                        "query": "subject:invoice",
                        "limit": 2,
                    }
                },
            )
        ]
        assert len(calls) == 2
        revoked = True
        with pytest.raises(PermissionError):
            await dispatch("agent_email", task)
        assert len(calls) == 2 and len(reads) == 1
    with pytest.raises(PermissionError):
        await pod_specialist_runtime.PodEmailReadPort("owner", "email-view").search_inbox(
            user_id="foreign",
            query="invoice",
        )
    assert len(reads) == 1
