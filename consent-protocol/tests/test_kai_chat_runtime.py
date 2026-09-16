"""Focused tests for Kai's manifest-owned chat runtime."""

from __future__ import annotations

import pytest

from hushh_mcp.agents.kai import runtime


def test_chat_gene_loads_from_kai_manifest() -> None:
    gene = runtime.load_kai_chat_gene()

    assert gene.id == "agent_kai_chat"
    assert gene.runtime.adk_mode == "chat"
    assert gene.runtime.transport == ["chat", "in_process"]
    assert gene.privacy.plaintext_telemetry is False


@pytest.mark.parametrize(
    "gene_id",
    [
        "agent_kai_debate",
        "agent_kai_synthesis",
        "agent_kai_fundamental",
        "agent_kai_sentiment",
        "agent_kai_valuation",
    ],
)
def test_analyst_genes_load_as_bounded_single_turns(gene_id: str) -> None:
    gene = runtime.load_kai_analyst_gene(gene_id)

    assert gene.id == gene_id
    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False


@pytest.mark.asyncio
async def test_chat_runtime_uses_one_bounded_adk_turn(monkeypatch) -> None:
    calls: dict[str, object] = {}

    monkeypatch.setattr(
        runtime,
        "build_kai_chat_agent",
        lambda **kwargs: calls.setdefault("agent", kwargs) or "agent",
    )

    class _Turn:
        final_text = "Kai response with grounded context."

    async def _run_turn(**kwargs):
        calls["kwargs"] = kwargs
        return _Turn()

    monkeypatch.setattr(runtime, "run_specialist_adk_turn", _run_turn)

    response = await runtime.run_kai_chat_turn(
        system_instruction="Use only supplied context.",
        user_message="What should I review?",
        user_id="user-1",
        consent_token="owner-token",  # noqa: S106 - test fixture token
        timeout_seconds=45,
    )

    assert response == "Kai response with grounded context."
    assert calls["kwargs"]["app_name"] == "hushh_kai_chat"
    assert calls["kwargs"]["user_id"] == "user-1"
    assert calls["kwargs"]["consent_token"] == "owner-token"
    assert calls["kwargs"]["message"] == "What should I review?"
    assert calls["kwargs"]["max_llm_calls"] == 1
    assert calls["kwargs"]["total_timeout_s"] == 45


@pytest.mark.asyncio
async def test_chat_runtime_requires_authority_and_nonempty_input() -> None:
    with pytest.raises(ValueError, match="instruction and message"):
        await runtime.run_kai_chat_turn(
            system_instruction="",
            user_message="hello",
            user_id="user-1",
            consent_token="token",  # noqa: S106 - test fixture token
        )
    with pytest.raises(ValueError, match="authority"):
        await runtime.run_kai_chat_turn(
            system_instruction="system",
            user_message="hello",
            user_id="",
            consent_token="token",  # noqa: S106 - test fixture token
        )


@pytest.mark.asyncio
async def test_analyst_runtime_uses_shared_single_turn(monkeypatch) -> None:
    calls: dict[str, object] = {}

    monkeypatch.setattr(runtime, "build_single_turn_agent", lambda gene, **kwargs: "agent")

    async def _run_single_turn(agent, **kwargs):
        calls["agent"] = agent
        calls["kwargs"] = kwargs
        return {"summary": "grounded", "confidence": 0.8}

    monkeypatch.setattr(runtime, "run_single_turn", _run_single_turn)

    result = await runtime.run_kai_analyst_turn(
        gene_id="agent_kai_sentiment",
        prompt="Analyze the supplied news.",
        user_id="user-1",
        consent_token="owner-token",  # noqa: S106 - test fixture token
    )

    assert result == {"summary": "grounded", "confidence": 0.8}
    assert calls["agent"] == "agent"
    assert calls["kwargs"]["user_id"] == "user-1"
    assert calls["kwargs"]["consent_token"] == "owner-token"


@pytest.mark.asyncio
async def test_synthesis_runtime_routes_to_its_manifest_gene(monkeypatch) -> None:
    calls: dict[str, object] = {}

    async def _run_analyst_turn(**kwargs):
        calls.update(kwargs)
        return {"thesis": "grounded"}

    monkeypatch.setattr(runtime, "run_kai_analyst_turn", _run_analyst_turn)

    result = await runtime.run_kai_synthesis_turn(
        prompt="Synthesize supplied evidence.",
        user_id="user-1",
        consent_token="owner-token",  # noqa: S106 - test fixture token
    )

    assert result == {"thesis": "grounded"}
    assert calls["gene_id"] == "agent_kai_synthesis"
    assert calls["user_id"] == "user-1"
