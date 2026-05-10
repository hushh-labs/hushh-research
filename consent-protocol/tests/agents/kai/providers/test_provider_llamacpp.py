# tests/agents/kai/providers/test_provider_llamacpp.py
"""llama.cpp provider: native /completion endpoint, ChatML prompt building."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from hushh_mcp.operons.kai.providers import CompletionRequest, Message, Role
from hushh_mcp.operons.kai.providers.errors import (
    ProviderError,
    ProviderResponseInvalid,
    ProviderUnavailable,
)
from hushh_mcp.operons.kai.providers.llamacpp import LlamaCppProvider


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("KAI_LLAMACPP_BASE_URL", "http://localhost:8080")
    return LlamaCppProvider()


def test_kind_is_private():
    assert LlamaCppProvider().kind == "private"


def test_build_prompt_passes_through_when_no_system(provider):
    req = CompletionRequest(prompt="hello world")
    assert provider._build_prompt(req) == "hello world"  # noqa: SLF001


def test_build_prompt_uses_chatml_when_system_present(provider):
    req = CompletionRequest(prompt="hi", system_instruction="be terse")
    rendered = provider._build_prompt(req)  # noqa: SLF001
    assert "<|im_start|>system" in rendered
    assert "be terse" in rendered
    assert "<|im_start|>user" in rendered
    assert "hi" in rendered
    assert rendered.endswith("<|im_start|>assistant\n")


def test_build_prompt_uses_chatml_with_explicit_messages(provider):
    req = CompletionRequest(
        prompt="ignored",
        messages=(
            Message(role=Role.USER, content="q1"),
            Message(role=Role.ASSISTANT, content="a1"),
        ),
    )
    rendered = provider._build_prompt(req)  # noqa: SLF001
    assert "q1" in rendered and "a1" in rendered
    assert rendered.endswith("<|im_start|>assistant\n")


@pytest.mark.asyncio
async def test_complete_parses_native_response(provider):
    fake = MagicMock()
    fake.status_code = 200
    fake.json = MagicMock(return_value={
        "content": "model output",
        "stopping_word": "</s>",
        "tokens_evaluated": 50,
        "tokens_predicted": 25,
    })

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.post = AsyncMock(return_value=fake)
        mk.return_value = client

        resp = await provider.complete(CompletionRequest(prompt="hi"))
        assert resp.text == "model output"
        assert resp.provider == "llamacpp"
        assert resp.usage["prompt_tokens"] == 50
        assert resp.usage["completion_tokens"] == 25


@pytest.mark.asyncio
async def test_complete_raises_on_non_200_status(provider):
    fake = MagicMock()
    fake.status_code = 500
    fake.text = "internal server error"
    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.post = AsyncMock(return_value=fake)
        mk.return_value = client
        with pytest.raises(ProviderError, match="500"):
            await provider.complete(CompletionRequest(prompt="x"))


@pytest.mark.asyncio
async def test_complete_raises_on_empty_content(provider):
    fake = MagicMock()
    fake.status_code = 200
    fake.json = MagicMock(return_value={"content": ""})
    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.post = AsyncMock(return_value=fake)
        mk.return_value = client
        with pytest.raises(ProviderResponseInvalid):
            await provider.complete(CompletionRequest(prompt="x"))


@pytest.mark.asyncio
async def test_complete_maps_request_error_to_unavailable(provider):
    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.post = AsyncMock(side_effect=httpx.RequestError("connection refused"))
        mk.return_value = client
        with pytest.raises(ProviderUnavailable):
            await provider.complete(CompletionRequest(prompt="x"))
