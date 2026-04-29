import pytest

from hushh_mcp.agents.kai.sentiment_agent import sentiment_agent
from hushh_mcp.agents.kai.valuation_agent import valuation_agent


@pytest.mark.asyncio
async def test_sentiment_agent_requires_consent_token_positional():
    """Verify that omitting consent_token raises a hard TypeError at runtime."""
    with pytest.raises(TypeError, match="missing 1 required positional argument: 'consent_token'"):
        await sentiment_agent.analyze(  # type: ignore
            ticker="AAPL",
            user_id="test_user",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("consent_token", [None, ""])
async def test_sentiment_agent_rejects_empty_consent_token(consent_token):
    """Verify explicit empty tokens fail before any fallback analysis can run."""
    with pytest.raises(PermissionError, match="requires a consent token"):
        await sentiment_agent.analyze(  # type: ignore[arg-type]
            ticker="AAPL",
            user_id="test_user",
            consent_token=consent_token,
        )


@pytest.mark.asyncio
async def test_valuation_agent_requires_consent_token_positional():
    """Verify that omitting consent_token raises a hard TypeError at runtime."""
    with pytest.raises(TypeError, match="missing 1 required positional argument: 'consent_token'"):
        await valuation_agent.analyze(  # type: ignore
            ticker="AAPL",
            user_id="test_user",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("consent_token", [None, ""])
async def test_valuation_agent_rejects_empty_consent_token(consent_token):
    """Verify explicit empty tokens fail before any fallback analysis can run."""
    with pytest.raises(PermissionError, match="requires a consent token"):
        await valuation_agent.analyze(  # type: ignore[arg-type]
            ticker="AAPL",
            user_id="test_user",
            consent_token=consent_token,
        )
