# tests/agents/kai/providers/test_provider_anthropic.py
"""Anthropic provider: request shape + system-message partitioning."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.operons.kai.providers import (
    CompletionRequest,
    Message,
    Role,
)
from hushh_mcp.operons.kai.providers.anthropic import AnthropicProvider
from hushh_mcp.operons.kai.providers.errors import ProviderResponseInvalid, ProviderUnavailable


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    return AnthropicProvider(model="claude-3-5-sonnet-latest")


def test_not_ready_when_api_key_missing(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    p = AnthropicProvider()
    ok, why = p.is_ready()
    assert ok is False
    assert "ANTHROPIC_API_KEY" in (why or "")


@pytest.mark.asyncio
async def test_complete_partitions_system_from_messages(provider):
    fake = MagicMock()
    text_block = MagicMock(type="text")
    text_block.text = "claude reply"
    fake.content = [text_block]
    fake.stop_reason = "end_turn"
    fake.usage = MagicMock(input_tokens=10, output_tokens=5)

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.messages.create = AsyncMock(return_value=fake)
        mk.return_value = client

        await provider.complete(
            CompletionRequest(
                prompt="hi claude",
                system_instruction="be helpful",
            )
        )
        kw = client.messages.create.await_args.kwargs
        assert kw["model"] == "claude-3-5-sonnet-latest"
        assert kw["system"] == "be helpful"
        # User content is in messages, NOT system
        assert kw["messages"] == [{"role": "user", "content": "hi claude"}]


@pytest.mark.asyncio
async def test_complete_concatenates_multiple_system_messages(provider):
    fake = MagicMock()
    tb = MagicMock(type="text")
    tb.text = "ok"
    fake.content = [tb]
    fake.stop_reason = "end_turn"
    fake.usage = None

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.messages.create = AsyncMock(return_value=fake)
        mk.return_value = client

        await provider.complete(
            CompletionRequest(
                prompt="ignored",
                system_instruction="rule 1",
                messages=(
                    Message(role=Role.SYSTEM, content="rule 2"),
                    Message(role=Role.USER, content="actual question"),
                ),
            )
        )
        kw = client.messages.create.await_args.kwargs
        assert "rule 1" in kw["system"]
        assert "rule 2" in kw["system"]
        assert kw["messages"] == [{"role": "user", "content": "actual question"}]


@pytest.mark.asyncio
async def test_complete_raises_invalid_on_empty_text_blocks(provider):
    fake = MagicMock()
    fake.content = []  # no text blocks
    fake.stop_reason = "end_turn"
    fake.usage = None
    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.messages.create = AsyncMock(return_value=fake)
        mk.return_value = client
        with pytest.raises(ProviderResponseInvalid):
            await provider.complete(CompletionRequest(prompt="x"))


@pytest.mark.asyncio
async def test_complete_unavailable_without_creds(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    p = AnthropicProvider()
    with pytest.raises(ProviderUnavailable):
        await p.complete(CompletionRequest(prompt="x"))


@pytest.mark.asyncio
async def test_role_translation_assistant_preserved(provider):
    fake = MagicMock()
    tb = MagicMock(type="text")
    tb.text = "ok"
    fake.content = [tb]
    fake.stop_reason = "end_turn"
    fake.usage = None
    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.messages.create = AsyncMock(return_value=fake)
        mk.return_value = client
        await provider.complete(
            CompletionRequest(
                prompt="ignored",
                messages=(
                    Message(role=Role.USER, content="q1"),
                    Message(role=Role.ASSISTANT, content="a1"),
                    Message(role=Role.USER, content="q2"),
                ),
            )
        )
        msgs = client.messages.create.await_args.kwargs["messages"]
        assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
