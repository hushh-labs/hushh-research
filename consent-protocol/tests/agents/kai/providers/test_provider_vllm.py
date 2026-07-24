# tests/agents/kai/providers/test_provider_vllm.py
"""vLLM provider: OpenAI-compatible, points at self-hosted endpoint."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.operons.kai.providers import CompletionRequest
from hushh_mcp.operons.kai.providers.vllm import VLLMProvider


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("KAI_VLLM_BASE_URL", "http://gpu-host:8000/v1")
    return VLLMProvider(model="meta-llama/Llama-3.1-8B-Instruct")


def test_ready_with_default_base_url():
    """vLLM is considered ready even without an env var because the default is sensible."""
    p = VLLMProvider()
    ready, _ = p.is_ready()
    assert ready is True  # default localhost URL is non-empty


def test_default_kind_is_private():
    p = VLLMProvider()
    assert p.kind == "private"


@pytest.mark.asyncio
async def test_complete_routes_to_configured_base_url(provider):
    fake = MagicMock()
    fake.choices = [MagicMock(message=MagicMock(content="local result"), finish_reason="stop")]
    fake.usage = None

    with patch.object(provider, "_get_client") as mk:
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=fake)
        mk.return_value = client

        resp = await provider.complete(CompletionRequest(prompt="hi"))
        assert resp.text == "local result"
        assert resp.provider == "vllm"
        # Confirm it called the chat completions endpoint with our model
        kw = client.chat.completions.create.await_args.kwargs
        assert kw["model"] == "meta-llama/Llama-3.1-8B-Instruct"


@pytest.mark.asyncio
async def test_complete_uses_default_when_no_env(monkeypatch):
    monkeypatch.delenv("KAI_VLLM_BASE_URL", raising=False)
    p = VLLMProvider()
    fake = MagicMock()
    fake.choices = [MagicMock(message=MagicMock(content="ok"), finish_reason="stop")]
    fake.usage = None
    with patch.object(p, "_get_client") as mk:
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=fake)
        mk.return_value = client
        resp = await p.complete(CompletionRequest(prompt="x"))
        assert resp.text == "ok"
