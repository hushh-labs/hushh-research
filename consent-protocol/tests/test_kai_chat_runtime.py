"""Focused tests for Kai's manifest-owned chat runtime."""

from __future__ import annotations

import json
from unittest.mock import Mock

import pytest

from hushh_mcp.agents.kai import runtime

_AZURE_RESULTS = {
    "fundamental": {
        "business_moat": "Synthetic moat",
        "financial_resilience": "Synthetic cash flow",
        "growth_efficiency": "Synthetic growth",
        "bull_case": "Synthetic strength",
        "bear_case": "Synthetic risk",
        "summary": "Supplied facts only",
        "confidence": 0.5,
        "recommendation": "hold",
    },
    "sentiment": {
        "summary": "Supplied news only",
        "sentiment_score": 0.0,
        "key_catalysts": ["Synthetic filing"],
        "news_highlights": [{"title": "Synthetic filing", "source": "fixture"}],
        "momentum_signal": "neutral",
        "confidence": 0.5,
        "recommendation": "neutral",
    },
    "valuation": {
        "summary": "Supplied valuation only",
        "valuation_verdict": "fair",
        "valuation_metrics": {"pe_ratio": 12.0},
        "peer_ranking": "middle",
        "peer_comparison": {"sector_median": 14.0},
        "price_targets": {"base_case": 100.0},
        "upside_downside": {"base_pct": 0.0},
        "confidence": 0.5,
        "recommendation": "fair",
    },
    "debate": {"statement": "Synthetic debate from supplied evidence."},
    "synthesis": {
        "thesis": "Synthetic conclusion",
        "key_drivers": ["Supplied fact"],
        "key_risks": ["Supplied risk"],
        "action_plan": ["Review supplied evidence"],
        "watchlist_triggers": ["A new filing"],
        "horizon_fit": "Synthetic horizon",
    },
}


def _azure_stock_transport(monkeypatch, outputs):
    import openai

    from hushh_mcp.runtime_providers import managed_azure
    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
    from tests.services.test_azure_adk import Client

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    for key in ("HUSHH_UAT_MANAGED_AI_PROVIDER", "HUSHH_UAT_MANAGED_TEXT_PROVIDER"):
        monkeypatch.delenv(key, raising=False)
    token = Mock(return_value="synthetic-bearer")
    monkeypatch.setattr(managed_azure, "_credential_supplier", lambda *_args: token)
    client = Client(outputs)
    factory = Mock(return_value=client)
    monkeypatch.setattr(openai, "AsyncOpenAI", factory)
    vertex = Mock(side_effect=AssertionError("UAT Azure stock analysis reached Vertex"))
    monkeypatch.setattr(ManagedGeminiRuntimeBinding, "from_environment", vertex)
    return client, factory, token, vertex


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", list(_AZURE_RESULTS))
async def test_uat_stock_stages_use_azure_without_vertex_and_preserve_outputs(monkeypatch, stage):
    from hushh_mcp.managed_ai_config import load_pwm_policy
    from hushh_mcp.runtime_providers.json_schema import current_validated_output_schema
    from tests.services.test_azure_adk import message, response

    payload = _AZURE_RESULTS[stage]
    client, factory, token, vertex = _azure_stock_transport(
        monkeypatch, [response(message(json.dumps(payload)))]
    )
    kwargs = dict(
        prompt="Synthetic approved market facts; no real owner holdings.",
        user_id="synthetic-owner",
        consent_token="synthetic-owner-token",  # noqa: S106 - inert fixture
    )
    if stage == "debate":
        result = await runtime.run_kai_debate_turn(**kwargs)
        assert result == payload["statement"]
    elif stage == "synthesis":
        assert await runtime.run_kai_synthesis_turn(**kwargs) == payload
    else:
        assert await runtime.run_kai_analyst_turn(gene_id=f"agent_kai_{stage}", **kwargs) == payload
    vertex.assert_not_called()
    token.assert_called_once()
    assert len(client.requests) == client.closed == 1
    wire = client.requests[0]
    assert (
        wire["model"]
        == load_pwm_policy(environment="uat", provider="azure_openai")["azure"][
            "primary_deployment"
        ]
    )
    assert wire["store"] is False
    assert factory.call_args.kwargs["max_retries"] == 0
    assert wire["reasoning"]["effort"] == ("high" if stage == "synthesis" else "low")
    assert wire["text"]["format"]["type"] == (
        "json_object" if stage in {"sentiment", "valuation"} else "json_schema"
    )
    assert current_validated_output_schema() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["invalid_output", "provider_failure"])
async def test_uat_stock_failure_never_switches_to_vertex(monkeypatch, failure):
    from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
    from hushh_mcp.runtime_providers.json_schema import current_validated_output_schema
    from tests.services.test_azure_adk import message, response

    client, _factory, _token, vertex = _azure_stock_transport(
        monkeypatch, [response(message('{"summary":"Missing required analysis"}'))]
    )
    if failure == "provider_failure":

        async def unavailable(**kwargs):
            client.requests.append(kwargs)
            raise RuntimeError("Synthetic Azure transport failure")

        client.create = unavailable
    expected = SpecialistAdkTurnError if failure == "provider_failure" else ValueError
    reason = "Specialist turn failed" if failure == "provider_failure" else "output schema"
    with pytest.raises(expected, match=reason):
        await runtime.run_kai_analyst_turn(
            gene_id="agent_kai_valuation",
            prompt="Synthetic approved facts.",
            user_id="synthetic-owner",
            consent_token="synthetic-owner-token",  # noqa: S106 - inert fixture
        )
    vertex.assert_not_called()
    assert len(client.requests) == client.closed == 1
    assert current_validated_output_schema() is None


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
@pytest.mark.parametrize("confidence", [0.0, -0.1, 1.1, float("nan")])
async def test_analyst_confidence_preserves_zero_and_rejects_invalid_values(
    monkeypatch, confidence
):
    monkeypatch.setattr(runtime, "build_single_turn_agent", lambda *_args, **_kwargs: "agent")

    async def run(*_args, **_kwargs):
        return {"confidence": confidence}

    monkeypatch.setattr(runtime, "run_single_turn", run)
    kwargs = dict(
        gene_id="agent_kai_sentiment",
        prompt="supplied facts",
        user_id="owner",
        consent_token="test-token",  # noqa: S106 - inert test fixture
    )
    if confidence == 0.0:
        assert (await runtime.run_kai_analyst_turn(**kwargs))["confidence"] == 0.0
    else:
        with pytest.raises(ValueError, match="confidence"):
            await runtime.run_kai_analyst_turn(**kwargs)


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
