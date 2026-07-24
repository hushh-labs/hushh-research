# tests/agents/kai/providers/test_provider_gemini.py
"""GeminiProvider: thin wrapper around llm.py preserves behavior."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.operons.kai.providers import CompletionRequest
from hushh_mcp.operons.kai.providers.errors import ProviderUnavailable
from hushh_mcp.operons.kai.providers.gemini import GeminiProvider


def test_default_model_is_constants_gemini_model():
    p = GeminiProvider()
    # Must be non-empty -- comes from constants.GEMINI_MODEL
    assert p.default_model
    assert isinstance(p.default_model, str)


def test_kind_is_cloud():
    assert GeminiProvider().kind == "cloud"


def test_is_ready_proxies_to_llm_module():
    p = GeminiProvider()
    with patch("hushh_mcp.operons.kai.providers.gemini._llm.is_gemini_ready", return_value=True):
        ok, why = p.is_ready()
        assert ok is True
        assert why is None
    with patch("hushh_mcp.operons.kai.providers.gemini._llm.is_gemini_ready", return_value=False), \
         patch(
             "hushh_mcp.operons.kai.providers.gemini._llm.get_gemini_unavailable_reason",
             return_value="no creds",
         ):
        ok, why = p.is_ready()
        assert ok is False
        assert "no creds" in (why or "")


@pytest.mark.asyncio
async def test_complete_delegates_to_generate_content_text():
    p = GeminiProvider()
    fake_text = "gemini reply here"
    with patch(
        "hushh_mcp.operons.kai.providers.gemini._llm._generate_content_text",
        new=AsyncMock(return_value=fake_text),
    ) as mk:
        resp = await p.complete(
            CompletionRequest(
                prompt="hello",
                timeout_seconds=12.5,
                max_output_tokens=2048,
                response_mime_type="application/json",
            )
        )
        # Verify exact call shape preserved (no kwarg drift)
        mk.assert_awaited_once()
        kw = mk.await_args.kwargs
        assert kw["prompt"] == "hello"
        assert kw["timeout_seconds"] == 12.5
        assert kw["max_output_tokens"] == 2048
        assert kw["response_mime_type"] == "application/json"

        assert resp.text == fake_text
        assert resp.provider == "gemini"


@pytest.mark.asyncio
async def test_complete_maps_runtime_error_to_unavailable():
    p = GeminiProvider()
    with patch(
        "hushh_mcp.operons.kai.providers.gemini._llm._generate_content_text",
        new=AsyncMock(side_effect=RuntimeError("client unavailable")),
    ):
        with pytest.raises(ProviderUnavailable):
            await p.complete(CompletionRequest(prompt="x"))
