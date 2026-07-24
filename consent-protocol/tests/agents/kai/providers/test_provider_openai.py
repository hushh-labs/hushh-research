# tests/agents/kai/providers/test_provider_openai.py
"""OpenAI provider: request shape + error mapping."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.operons.kai.providers import (
    CompletionRequest,
    Message,
    Role,
)
from hushh_mcp.operons.kai.providers.errors import ProviderTimeout, ProviderUnavailable
from hushh_mcp.operons.kai.providers.openai import OpenAIProvider


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-key")
    return OpenAIProvider(model="gpt-4o-mini")


def test_not_ready_when_api_key_missing(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    p = OpenAIProvider()
    ready, why = p.is_ready()
    assert ready is False
    assert "OPENAI_API_KEY" in (why or "")


def test_ready_when_api_key_present(provider):
    ready, _ = provider.is_ready()
    assert ready is True


@pytest.mark.asyncio
async def test_complete_sends_messages_in_canonical_order(provider):
    fake_response = MagicMock()
    fake_response.choices = [MagicMock(message=MagicMock(content="hi back"), finish_reason="stop")]
    fake_response.usage = MagicMock(prompt_tokens=10, completion_tokens=5, total_tokens=15)

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=fake_response)
        mk.return_value = client

        request = CompletionRequest(
            prompt="user q",
            system_instruction="system msg",
            temperature=0.2,
            max_output_tokens=100,
        )
        resp = await provider.complete(request)

        # Verify request shape sent to OpenAI
        call_kwargs = client.chat.completions.create.await_args.kwargs
        assert call_kwargs["model"] == "gpt-4o-mini"
        assert call_kwargs["temperature"] == 0.2
        assert call_kwargs["max_tokens"] == 100
        assert call_kwargs["messages"] == [
            {"role": "system", "content": "system msg"},
            {"role": "user", "content": "user q"},
        ]
        # Response surfaces correctly
        assert resp.text == "hi back"
        assert resp.provider == "openai"
        assert resp.model == "gpt-4o-mini"
        assert resp.finish_reason == "stop"
        assert resp.usage == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}


@pytest.mark.asyncio
async def test_complete_response_format_json_passes_through(provider):
    fake = MagicMock()
    fake.choices = [MagicMock(message=MagicMock(content='{"x": 1}'), finish_reason="stop")]
    fake.usage = None

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=fake)
        mk.return_value = client

        await provider.complete(
            CompletionRequest(prompt="x", response_mime_type="application/json")
        )
        kw = client.chat.completions.create.await_args.kwargs
        assert kw["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_complete_unavailable_when_no_creds(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    p = OpenAIProvider()
    with pytest.raises(ProviderUnavailable):
        await p.complete(CompletionRequest(prompt="x"))


@pytest.mark.asyncio
async def test_complete_maps_asyncio_timeout_to_provider_timeout(provider):
    import asyncio

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()

        async def hang(*_, **__):
            await asyncio.sleep(0.5)

        client.chat.completions.create = hang
        mk.return_value = client

        with pytest.raises(ProviderTimeout):
            await provider.complete(CompletionRequest(prompt="x", timeout_seconds=0.05))


@pytest.mark.asyncio
async def test_explicit_messages_preserved(provider):
    fake = MagicMock()
    fake.choices = [MagicMock(message=MagicMock(content="ok"), finish_reason="stop")]
    fake.usage = None

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=fake)
        mk.return_value = client

        explicit = (
            Message(role=Role.SYSTEM, content="sys"),
            Message(role=Role.USER, content="u1"),
            Message(role=Role.ASSISTANT, content="a1"),
            Message(role=Role.USER, content="u2"),
        )
        await provider.complete(
            CompletionRequest(prompt="ignored", messages=explicit)
        )
        msgs = client.chat.completions.create.await_args.kwargs["messages"]
        assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"]
        assert msgs[-1]["content"] == "u2"
