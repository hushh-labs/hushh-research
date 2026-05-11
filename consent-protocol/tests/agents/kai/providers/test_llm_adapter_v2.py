# tests/agents/kai/providers/test_llm_adapter_v2.py
"""
synthesize_debate_recommendation_card_v2 migration tests.

These tests prove the proof migration is safe:

1. Without consent_token: v2 delegates to the original llm.py path
   verbatim (legacy behavior unchanged).
2. With consent_token: v2 routes through the registry and the result
   contains a `_meta` block identifying the provider.
3. Adapter-mode failures fall back to legacy gracefully.
4. Consent-scope violations are NOT silently downgraded -- they raise.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.consent.token import issue_token
from hushh_mcp.operons.kai.llm_adapter import synthesize_debate_recommendation_card_v2
from hushh_mcp.operons.kai.providers import (
    CompletionResponse,
    ConsentScopeViolation,
    ProviderUnavailable,
)
from hushh_mcp.operons.kai.providers.scopes import SCOPE_GEMINI, SCOPE_PRIVATE_ANY

_BASE_INPUTS = dict(
    ticker="AAPL",
    risk_profile="Balanced",
    user_context={"name": "Test", "risk_tolerance": "Balanced"},
    renaissance_context={"tier": "test", "score": 0.0},
    fundamental_payload={"summary": "f", "recommendation": "BUY", "confidence": 0.7},
    sentiment_payload={"summary": "s", "recommendation": "BUY", "confidence": 0.6},
    valuation_payload={"summary": "v", "recommendation": "BUY", "confidence": 0.6},
    debate_payload={"convergence": True},
    highlights=[{"title": "x", "source": "y"}],
)


@pytest.mark.asyncio
async def test_v2_without_consent_token_calls_legacy_path():
    """Backward compat: no token -> exact legacy behavior."""
    fake_legacy_payload = {"thesis": "legacy path", "key_drivers": []}
    with patch(
        "hushh_mcp.operons.kai.llm_adapter._llm.synthesize_debate_recommendation_card",
        new=AsyncMock(return_value=fake_legacy_payload),
    ) as legacy_mock:
        result = await synthesize_debate_recommendation_card_v2(**_BASE_INPUTS)
        legacy_mock.assert_awaited_once()
        # NO _meta block when going through legacy
        assert result == fake_legacy_payload
        assert "_meta" not in result


@pytest.mark.asyncio
async def test_v2_with_consent_token_routes_through_dispatch():
    """Adapter mode: token present -> dispatch path -> _meta annotated."""
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_GEMINI)
    token_str = token.token if hasattr(token, "token") else str(token)

    fake_text = '{"thesis": "via adapter", "key_drivers": ["d1"]}'
    fake_response = CompletionResponse(
        text=fake_text, provider="gemini", model="gemini-3-flash"
    )
    with patch(
        "hushh_mcp.operons.kai.llm_adapter.dispatch",
        new=AsyncMock(return_value=fake_response),
    ) as disp_mock:
        result = await synthesize_debate_recommendation_card_v2(
            **_BASE_INPUTS,
            consent_token=token_str,
            user_id="u1",
            provider_name="gemini",
        )
        disp_mock.assert_awaited_once()
        assert result["thesis"] == "via adapter"
        assert result["_meta"]["provider"] == "gemini"
        assert result["_meta"]["model"] == "gemini-3-flash"


@pytest.mark.asyncio
async def test_v2_consent_violation_NOT_silently_downgraded():
    """A scope violation must propagate. Silent downgrade would weaken consent-first."""
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_PRIVATE_ANY)
    token_str = token.token if hasattr(token, "token") else str(token)
    with patch(
        "hushh_mcp.operons.kai.llm_adapter.dispatch",
        new=AsyncMock(side_effect=ConsentScopeViolation(
            "denied", provider="gemini", scope=SCOPE_GEMINI,
        )),
    ):
        with pytest.raises(ConsentScopeViolation):
            await synthesize_debate_recommendation_card_v2(
                **_BASE_INPUTS,
                consent_token=token_str,
                user_id="u1",
                provider_name="gemini",
            )


@pytest.mark.asyncio
async def test_v2_provider_unavailable_falls_back_to_legacy():
    """Provider crashes / not-ready -> legacy path serves the user."""
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_GEMINI)
    token_str = token.token if hasattr(token, "token") else str(token)
    fake_legacy_payload = {"thesis": "legacy fallback path", "key_drivers": []}
    with patch(
        "hushh_mcp.operons.kai.llm_adapter.dispatch",
        new=AsyncMock(side_effect=ProviderUnavailable("vllm down")),
    ), patch(
        "hushh_mcp.operons.kai.llm_adapter._llm.synthesize_debate_recommendation_card",
        new=AsyncMock(return_value=fake_legacy_payload),
    ) as legacy_mock:
        result = await synthesize_debate_recommendation_card_v2(
            **_BASE_INPUTS,
            consent_token=token_str,
            user_id="u1",
            provider_name="vllm",
        )
        legacy_mock.assert_awaited_once()
        assert result == fake_legacy_payload


@pytest.mark.asyncio
async def test_v2_empty_synthesis_falls_back_to_legacy():
    """If the adapter returns non-JSON or empty, legacy serves the user."""
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_GEMINI)
    token_str = token.token if hasattr(token, "token") else str(token)
    bad_response = CompletionResponse(text="not json at all", provider="gemini", model="g")
    fake_legacy = {"thesis": "legacy", "fallback": True}
    with patch(
        "hushh_mcp.operons.kai.llm_adapter.dispatch",
        new=AsyncMock(return_value=bad_response),
    ), patch(
        "hushh_mcp.operons.kai.llm_adapter._llm.synthesize_debate_recommendation_card",
        new=AsyncMock(return_value=fake_legacy),
    ) as legacy:
        result = await synthesize_debate_recommendation_card_v2(
            **_BASE_INPUTS,
            consent_token=token_str,
            user_id="u1",
            provider_name="gemini",
        )
        legacy.assert_awaited_once()
        assert result == fake_legacy
