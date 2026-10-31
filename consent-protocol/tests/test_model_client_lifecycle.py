"""Real SDK streams/clients close on partial ADK turns; no provider requests."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from google import genai
from google.adk.models.llm_request import LlmRequest
from google.genai import types
from google.genai.client import AsyncClient
from openai import AsyncOpenAI

from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.runtime_providers.lifecycle import close_owned_model_client
from hushh_mcp.runtime_providers.openai_responses_transport import OpenAIResponsesTransport
from hushh_mcp.runtime_providers.vertex_failover import VertexRegionalClient


class ResponseStream(httpx.AsyncByteStream):
    def __init__(self):
        self.closed = False

    async def __aiter__(self):
        event = {
            "type": "response.output_text.delta",
            "delta": "Synthetic",
            "sequence_number": 1,
            "item_id": "msg-1",
            "output_index": 0,
            "content_index": 0,
        }
        yield ("event: response.output_text.delta\ndata: " + json.dumps(event) + "\n\n").encode()
        await asyncio.Event().wait()

    async def aclose(self):
        self.closed = True


async def test_partial_native_turn_closes_real_openai_stream_and_owned_client(monkeypatch):
    import openai

    from hushh_mcp.runtime_providers import owner_openai

    stream = ResponseStream()
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=stream
            )
        )
    )
    client = AsyncOpenAI(api_key="synthetic", http_client=http, max_retries=0)
    monkeypatch.setattr(openai, "AsyncOpenAI", lambda **kwargs: client)
    transport = OpenAIResponsesTransport(api_key="synthetic", base_url="https://api.openai.com/v1")
    monkeypatch.setattr(owner_openai, "owner_model_client", lambda *args: transport)
    model = ProviderAdkModel(
        model="synthetic", provider="openai", runtime_mode="byok", credential="synthetic"
    )
    response = model.generate_content_async(
        LlmRequest(
            model="synthetic",
            contents=[types.Content(role="user", parts=[types.Part(text="Synthetic turn")])],
        ),
        stream=True,
    )
    try:
        assert (await anext(response)).partial is True
    finally:
        await response.aclose()
    assert stream.closed and client.is_closed() and http.is_closed


async def test_borrowed_sdk_client_is_not_closed_by_transport():
    client = SimpleNamespace(close=AsyncMock())
    transport = OpenAIResponsesTransport(api_key="synthetic", client=client)
    await transport.aclose()
    client.close.assert_not_awaited()


async def test_vertex_regions_close_both_genai_halves_and_refuse_reopening(monkeypatch):
    closes, async_closes = [], []
    original, original_async = genai.Client.close, AsyncClient.aclose

    def close(client):
        closes.append(client)
        original(client)

    async def aclose(client):
        async_closes.append(client)
        await original_async(client)

    monkeypatch.setattr(genai.Client, "close", close)
    monkeypatch.setattr(AsyncClient, "aclose", aclose)
    clients = []

    def factory(**kwargs):
        client = genai.Client(api_key="synthetic", vertexai=False)
        clients.append(client)
        return client

    regional = VertexRegionalClient(
        project="synthetic-project",
        locations=("us-central1", "us-east1"),
        client_factory=factory,
        cooldown_seconds=1,
    )
    regional._client_for("us-east1")
    await close_owned_model_client(regional)
    assert closes == clients and len(async_closes) == 2
    with pytest.raises(RuntimeError, match="closed"):
        regional._client_for("us-central1")


async def test_scheduled_model_closes_existing_native_client_without_creating_an_unused_one(
    monkeypatch,
):
    from google.adk.models import Gemini

    from hushh_mcp.runtime_providers.lifecycle import close_owned_adk_model

    fresh = Gemini(model="synthetic")
    await close_owned_adk_model(fresh)
    assert "api_client" not in fresh.__dict__
    client = genai.Client(api_key="synthetic", vertexai=False)
    close = Mock(wraps=client.close)
    monkeypatch.setattr(client, "close", close)
    fresh.__dict__["api_client"] = client
    await close_owned_adk_model(fresh)
    close.assert_called_once()
    assert "api_client" not in fresh.__dict__
    # Browser continuation recreates the client from the same owner binding,
    # even when ambient Shared configuration selects a different provider mode.
    from hushh_mcp.runtime_providers.factory import build_gemini_byok_adk_model

    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    owner = build_gemini_byok_adk_model("gemini-3.8-flash", "synthetic")
    initial = owner.api_client
    assert initial.vertexai is False
    await close_owned_adk_model(owner)
    resumed = owner.api_client
    try:
        assert resumed is not initial and resumed.vertexai is False
        assert owner.client_kwargs == {"vertexai": False, "api_key": "synthetic"}
    finally:
        await close_owned_adk_model(owner)


async def test_repeated_cancellation_joins_both_owned_genai_halves(monkeypatch):
    client = genai.Client(api_key="synthetic", vertexai=False)
    entered, release = asyncio.Event(), asyncio.Event()
    original = client.aio.aclose

    async def close_async():
        entered.set()
        await release.wait()
        await original()

    monkeypatch.setattr(client.aio, "aclose", close_async)
    closed = Mock(wraps=client.close)
    monkeypatch.setattr(client, "close", closed)
    task = asyncio.create_task(close_owned_model_client(client))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        for _ in range(2):
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            closed.assert_not_called()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    closed.assert_called_once()
