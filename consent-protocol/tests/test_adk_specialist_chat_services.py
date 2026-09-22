"""Deterministic proof that direct specialist routes use the ADK turn runner."""

from __future__ import annotations

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.services.email_chat_service import EmailChatService
from hushh_mcp.services.information_chat_service import InformationChatService
from hushh_mcp.services.location_chat_service import LocationChatService


def _response(*, text: str | None = None, call: str | None = None, args: dict | None = None):
    parts = []
    if text:
        parts.append(types.Part.from_text(text=text))
    if call:
        parts.append(types.Part(function_call=types.FunctionCall(name=call, args=args or {})))
    return LlmResponse(content=types.Content(role="model", parts=parts))


class _ScriptedModel(BaseLlm):
    _steps: list[LlmResponse] = PrivateAttr()
    _calls: int = PrivateAttr(default=0)

    def __init__(self, steps: list[LlmResponse]):
        super().__init__(model="fixture")
        self._steps = list(steps)

    async def generate_content_async(self, llm_request, stream=False):
        self._calls += 1
        yield self._steps.pop(0)


class _Turn:
    def __init__(self, conversation_id: str):
        self.conversation_id = conversation_id
        self.history = []


class _Store:
    def __init__(self):
        self.messages: list[dict] = []

    async def prepare_turn(self, **kwargs):
        return _Turn(kwargs.get("conversation_id") or "fixture-conversation")

    async def add_message(self, **kwargs):
        self.messages.append(kwargs)


async def list_public_links() -> dict:
    return {"publicLinks": []}


async def list_published_slices() -> dict:
    return {"publishedSlices": [], "count": 0}


class _Gmail:
    async def list_nudges(self, *, user_id: str, limit: int) -> dict:
        return {"account_email": "owner@example.com", "nudges": []}

    async def search_inbox(self, *, user_id: str, query: str, limit: int) -> list:
        return []

    async def list_receipts(self, *, user_id: str, page: int, per_page: int) -> dict:
        return {"items": [], "page": page, "total": 0}

    async def get_status(self, *, user_id: str) -> dict:
        return {"connected": True, "latest_run": "ok"}


async def test_location_direct_route_executes_adk_tool_and_persists_answer():
    model = _ScriptedModel(
        [_response(call="list_public_links"), _response(text="No active links.")]
    )
    store = _Store()
    service = LocationChatService(
        chat_store=store,
        model=model,
        ready=lambda: True,
        tools=[list_public_links],
        system_prompt="Fixture location specialist.",
    )

    result = await service.handle_turn(
        user_id="owner",
        message="show my public links",
        consent_token="fixture-token",  # noqa: S106 - synthetic test authority
    )

    assert result["response"] == "No active links."
    assert result["isComplete"] is True
    assert result["stateChanged"] is False
    assert model._calls == 2
    assert [message["status"] for message in store.messages] == ["complete"]


async def test_memory_direct_route_executes_adk_tool_and_persists_answer():
    model = _ScriptedModel(
        [_response(call="list_published_slices"), _response(text="Nothing is published yet.")]
    )
    store = _Store()
    service = InformationChatService(
        chat_store=store,
        model=model,
        ready=lambda: True,
        tools=[list_published_slices],
        system_prompt="Fixture memory specialist.",
    )

    result = await service.handle_turn(
        user_id="owner",
        message="what have I published",
        consent_token="fixture-token",  # noqa: S106 - synthetic test authority
    )

    assert result["response"] == "Nothing is published yet."
    assert result["isComplete"] is True
    assert result["stateChanged"] is False
    assert model._calls == 2
    assert [message["status"] for message in store.messages] == ["complete"]


async def test_email_direct_route_uses_one_adk_agent_for_inbox_and_receipts():
    model = _ScriptedModel(
        [_response(call="list_receipts"), _response(text="No receipts are synced yet.")]
    )
    store = _Store()
    service = EmailChatService(
        chat_store=store,
        gmail_service=_Gmail(),
        model=model,
        ready=lambda: True,
    )

    result = await service.handle_turn(
        user_id="owner",
        message="show my receipts",
        consent_token="fixture-token",  # noqa: S106 - synthetic test authority
    )

    assert result["response"] == "No receipts are synced yet."
    assert result["isComplete"] is True
    assert result["stateChanged"] is False
    assert model._calls == 2
    assert [message["status"] for message in store.messages] == ["complete"]
