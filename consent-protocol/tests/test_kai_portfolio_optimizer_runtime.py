"""Focused contract tests for Kai's manifest-owned portfolio optimizer."""

from __future__ import annotations

import pytest

from hushh_mcp.agents.kai import runtime


def test_optimizer_gene_loads_from_kai_manifest() -> None:
    gene = runtime.load_kai_portfolio_optimizer_gene()
    assert gene.id == "agent_kai_portfolio_optimizer"
    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False


@pytest.mark.asyncio
async def test_optimizer_runtime_uses_one_bounded_single_turn(monkeypatch) -> None:
    calls: dict[str, object] = {}

    monkeypatch.setattr(runtime, "build_managed_runtime_client", lambda _provider: object())
    monkeypatch.setattr(runtime, "Gemini", lambda **kwargs: kwargs)

    def _build_agent(gene, *, output_schema, model):
        calls["gene"] = gene.id
        calls["schema"] = output_schema
        calls["model"] = model
        return "agent"

    async def _run_agent(agent, **kwargs):
        calls["agent"] = agent
        calls["kwargs"] = kwargs
        return {
            "summary": {},
            "losers": [],
            "portfolio_level_takeaways": [],
        }

    monkeypatch.setattr(runtime, "build_single_turn_agent", _build_agent)
    monkeypatch.setattr(runtime, "run_single_turn", _run_agent)

    payload = await runtime.run_kai_portfolio_optimizer(
        prompt="Use the supplied portfolio snapshot.",
        user_id="user-1",
        consent_token="vault-owner-token",  # noqa: S106 - test fixture token
    )

    assert payload == {"summary": {}, "losers": [], "portfolio_level_takeaways": []}
    assert calls["gene"] == "agent_kai_portfolio_optimizer"
    assert calls["agent"] == "agent"
    assert calls["kwargs"]["user_id"] == "user-1"
    assert calls["kwargs"]["consent_token"] == "vault-owner-token"


@pytest.mark.asyncio
async def test_optimizer_runtime_requires_prompt_and_authority() -> None:
    with pytest.raises(ValueError, match="prompt"):
        await runtime.run_kai_portfolio_optimizer(
            prompt="",
            user_id="user-1",
            consent_token="token",  # noqa: S106 - test fixture token
        )
    with pytest.raises(ValueError, match="authority"):
        await runtime.run_kai_portfolio_optimizer(
            prompt="prompt",
            user_id="",
            consent_token="token",  # noqa: S106 - test fixture token
        )
