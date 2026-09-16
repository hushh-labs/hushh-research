"""Manifest-owned single-turn runtime for Kai's portfolio optimization."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.models import Gemini
from google.genai import types

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
from hushh_mcp.runtime_providers import build_managed_gemini_adk_model, build_managed_runtime_client
from hushh_mcp.runtime_providers.gemini_config import (
    build_generate_content_config,
    resolve_fleet_model_name,
    thinking_config_for,
)

_MANIFEST_PATH = Path(__file__).with_name("agent.yaml")
_PORTFOLIO_OPTIMIZER_GENE_ID = "agent_kai_portfolio_optimizer"
_KAI_CHAT_GENE_ID = "agent_kai_chat"
_KAI_FUNDAMENTAL_GENE_ID = "agent_kai_fundamental"
_KAI_SENTIMENT_GENE_ID = "agent_kai_sentiment"
_KAI_VALUATION_GENE_ID = "agent_kai_valuation"
_KAI_DEBATE_GENE_ID = "agent_kai_debate"
_KAI_SYNTHESIS_GENE_ID = "agent_kai_synthesis"

PORTFOLIO_OPTIMIZER_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "criteria_context": {"type": "STRING"},
        "summary": {"type": "OBJECT"},
        "losers": {"type": "ARRAY", "items": {"type": "OBJECT"}},
        "portfolio_level_takeaways": {"type": "ARRAY", "items": {"type": "STRING"}},
        "analytics": {"type": "OBJECT", "nullable": True},
    },
    "required": ["summary", "losers", "portfolio_level_takeaways"],
}

KAI_ANALYST_SCHEMAS: dict[str, dict[str, Any]] = {
    _KAI_DEBATE_GENE_ID: {
        "type": "OBJECT",
        "properties": {"statement": {"type": "STRING"}},
        "required": ["statement"],
    },
    _KAI_SYNTHESIS_GENE_ID: {
        "type": "OBJECT",
        "properties": {
            "thesis": {"type": "STRING"},
            "key_drivers": {"type": "ARRAY", "items": {"type": "STRING"}},
            "key_risks": {"type": "ARRAY", "items": {"type": "STRING"}},
            "action_plan": {"type": "ARRAY", "items": {"type": "STRING"}},
            "watchlist_triggers": {"type": "ARRAY", "items": {"type": "STRING"}},
            "horizon_fit": {"type": "STRING"},
        },
        "required": [
            "thesis",
            "key_drivers",
            "key_risks",
            "action_plan",
            "watchlist_triggers",
            "horizon_fit",
        ],
    },
    _KAI_FUNDAMENTAL_GENE_ID: {
        "type": "OBJECT",
        "properties": {
            "business_moat": {"type": "STRING"},
            "financial_resilience": {"type": "STRING"},
            "growth_efficiency": {"type": "STRING"},
            "bull_case": {"type": "STRING"},
            "bear_case": {"type": "STRING"},
            "summary": {"type": "STRING"},
            "confidence": {"type": "NUMBER"},
            "recommendation": {"type": "STRING"},
        },
        "required": [
            "business_moat",
            "financial_resilience",
            "growth_efficiency",
            "bull_case",
            "bear_case",
            "summary",
            "confidence",
            "recommendation",
        ],
    },
    _KAI_SENTIMENT_GENE_ID: {
        "type": "OBJECT",
        "properties": {
            "summary": {"type": "STRING"},
            "sentiment_score": {"type": "NUMBER"},
            "key_catalysts": {"type": "ARRAY", "items": {"type": "STRING"}},
            "news_highlights": {"type": "ARRAY", "items": {"type": "OBJECT"}},
            "momentum_signal": {"type": "STRING"},
            "confidence": {"type": "NUMBER"},
            "recommendation": {"type": "STRING"},
        },
        "required": [
            "summary",
            "sentiment_score",
            "key_catalysts",
            "news_highlights",
            "momentum_signal",
            "confidence",
            "recommendation",
        ],
    },
    _KAI_VALUATION_GENE_ID: {
        "type": "OBJECT",
        "properties": {
            "summary": {"type": "STRING"},
            "valuation_verdict": {"type": "STRING"},
            "valuation_metrics": {"type": "OBJECT"},
            "peer_ranking": {"type": "STRING"},
            "peer_comparison": {"type": "OBJECT"},
            "price_targets": {"type": "OBJECT"},
            "upside_downside": {"type": "OBJECT"},
            "confidence": {"type": "NUMBER"},
            "recommendation": {"type": "STRING"},
        },
        "required": [
            "summary",
            "valuation_verdict",
            "valuation_metrics",
            "peer_ranking",
            "price_targets",
            "upside_downside",
            "confidence",
            "recommendation",
        ],
    },
}


@lru_cache(maxsize=1)
def load_kai_portfolio_optimizer_gene() -> Any:
    """Load and validate Kai's manifest-owned optimizer child."""

    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    gene = next(
        (child for child in manifest.subagents if child.id == _PORTFOLIO_OPTIMIZER_GENE_ID),
        None,
    )
    if gene is None:
        raise RuntimeError("Kai portfolio optimizer gene is missing")
    if gene.runtime.adk_mode != "single_turn" or gene.runtime.transport != ["in_process"]:
        raise RuntimeError("Kai portfolio optimizer gene has an invalid runtime boundary")
    if gene.privacy.plaintext_telemetry:
        raise RuntimeError("Kai portfolio optimizer gene permits plaintext telemetry")
    return gene


@lru_cache(maxsize=1)
def load_kai_chat_gene() -> Any:
    """Load Kai's manifest-owned conversational child."""

    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    gene = next((child for child in manifest.subagents if child.id == _KAI_CHAT_GENE_ID), None)
    if gene is None:
        raise RuntimeError("Kai chat gene is missing")
    if gene.runtime.adk_mode != "chat" or gene.runtime.transport != ["chat", "in_process"]:
        raise RuntimeError("Kai chat gene has an invalid runtime boundary")
    if gene.privacy.plaintext_telemetry:
        raise RuntimeError("Kai chat gene permits plaintext telemetry")
    return gene


@lru_cache(maxsize=4)
def load_kai_analyst_gene(gene_id: str) -> Any:
    """Load one of Kai's manifest-owned analyst children."""

    if gene_id not in KAI_ANALYST_SCHEMAS:
        raise ValueError(f"Unknown Kai analyst gene: {gene_id}")
    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    gene = next((child for child in manifest.subagents if child.id == gene_id), None)
    if gene is None:
        raise RuntimeError(f"Kai analyst gene is missing: {gene_id}")
    if gene.runtime.adk_mode != "single_turn" or gene.runtime.transport != ["in_process"]:
        raise RuntimeError(f"Kai analyst gene has an invalid runtime boundary: {gene_id}")
    if gene.privacy.plaintext_telemetry:
        raise RuntimeError(f"Kai analyst gene permits plaintext telemetry: {gene_id}")
    return gene


def build_kai_chat_agent(*, instruction: str | None = None, model: Any | None = None) -> LlmAgent:
    """Build one bounded Kai chat agent from the authored child manifest."""

    gene = load_kai_chat_gene()
    model_name = resolve_fleet_model_name(str(gene.model.name))
    resolved = model if model is not None else build_managed_gemini_adk_model(model_name)
    resolved_name = str(getattr(resolved, "model", model_name) or model_name)
    return LlmAgent(
        name=gene.id,
        description=gene.description,
        instruction=str(instruction or gene.system_instruction),
        model=resolved,
        mode=gene.runtime.adk_mode,
        include_contents="none",
        disallow_transfer_to_parent=True,
        disallow_transfer_to_peers=True,
        tools=[],
        generate_content_config=build_generate_content_config(
            types,
            resolved_name,
            max_output_tokens=gene.performance.max_output_tokens,
            thinking_config=thinking_config_for(resolved_name, gene.model.thinking_level, types),
        ),
    )


async def run_kai_chat_turn(
    *,
    system_instruction: str,
    user_message: str,
    user_id: str,
    consent_token: str,
    timeout_seconds: float | None = None,
) -> str:
    """Run one bounded, manifest-owned Kai chat turn."""

    if not str(system_instruction or "").strip() or not str(user_message or "").strip():
        raise ValueError("Kai chat instruction and message are required")
    if not str(user_id or "").strip() or not str(consent_token or "").strip():
        raise ValueError("Kai chat authority is required")
    gene = load_kai_chat_gene()
    total_timeout = (
        float(timeout_seconds)
        if timeout_seconds is not None
        else max(30.0, gene.performance.latency_p95_ms / 1000)
    )
    turn = await run_specialist_adk_turn(
        agent=build_kai_chat_agent(instruction=system_instruction),
        app_name="hushh_kai_chat",
        user_id=str(user_id),
        consent_token=str(consent_token),
        message=str(user_message).strip(),
        max_llm_calls=1,
        first_event_timeout_s=min(30.0, total_timeout),
        between_event_timeout_s=min(30.0, total_timeout),
        total_timeout_s=total_timeout,
    )
    text = turn.final_text.strip()
    if not text:
        raise ValueError("Kai chat returned an empty response")
    return text


async def run_kai_analyst_turn(
    *,
    gene_id: str,
    prompt: str,
    user_id: str,
    consent_token: str,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Run one manifest-owned Kai analyst with a bounded structured response."""

    if not str(prompt or "").strip():
        raise ValueError("Kai analyst prompt is required")
    if not str(user_id or "").strip() or not str(consent_token or "").strip():
        raise ValueError("Kai analyst authority is required")
    gene = load_kai_analyst_gene(gene_id)
    result = await run_single_turn(
        build_single_turn_agent(gene, output_schema=KAI_ANALYST_SCHEMAS[gene_id]),
        prompt_parts=str(prompt).strip(),
        user_id=str(user_id),
        consent_token=str(consent_token),
        timeout_seconds=(
            float(timeout_seconds)
            if timeout_seconds is not None
            else max(30.0, gene.performance.latency_p95_ms / 1000)
        ),
    )
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    if not isinstance(payload, dict):
        raise ValueError("Kai analyst returned a non-object payload")
    return json.loads(json.dumps(payload, separators=(",", ":")))


async def run_kai_debate_turn(
    *,
    prompt: str,
    user_id: str,
    consent_token: str,
    timeout_seconds: float | None = None,
) -> str:
    """Run one bounded debate statement through the manifest-owned ADK gene."""

    payload = await run_kai_analyst_turn(
        gene_id=_KAI_DEBATE_GENE_ID,
        prompt=prompt,
        user_id=user_id,
        consent_token=consent_token,
        timeout_seconds=timeout_seconds,
    )
    statement = str(payload.get("statement") or "").strip()
    if not statement:
        raise ValueError("Kai debate gene returned an empty statement")
    return statement


async def run_kai_synthesis_turn(
    *,
    prompt: str,
    user_id: str,
    consent_token: str,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Run one bounded recommendation-card synthesis through its ADK gene."""

    return await run_kai_analyst_turn(
        gene_id=_KAI_SYNTHESIS_GENE_ID,
        prompt=prompt,
        user_id=user_id,
        consent_token=consent_token,
        timeout_seconds=timeout_seconds,
    )


async def run_kai_portfolio_optimizer(
    *,
    prompt: str,
    user_id: str,
    consent_token: str,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Run one bounded, schema-constrained optimizer turn."""

    if not str(prompt or "").strip():
        raise ValueError("Kai portfolio optimizer prompt is required")
    if not str(user_id or "").strip() or not str(consent_token or "").strip():
        raise ValueError("Kai portfolio optimizer authority is required")

    gene = load_kai_portfolio_optimizer_gene()
    client = build_managed_runtime_client(gene.model.provider)
    model_name = resolve_fleet_model_name(str(gene.model.name))
    agent = build_single_turn_agent(
        gene,
        output_schema=PORTFOLIO_OPTIMIZER_SCHEMA,
        model=Gemini(model=model_name, client=client),
    )
    result = await run_single_turn(
        agent,
        prompt_parts=str(prompt).strip(),
        user_id=str(user_id),
        consent_token=str(consent_token),
        timeout_seconds=(
            float(timeout_seconds)
            if timeout_seconds is not None
            else max(30.0, gene.performance.latency_p95_ms / 1000)
        ),
    )
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    if not isinstance(payload, dict):
        raise ValueError("Kai portfolio optimizer returned a non-object payload")
    return json.loads(json.dumps(payload, separators=(",", ":")))


__all__ = [
    "KAI_ANALYST_SCHEMAS",
    "PORTFOLIO_OPTIMIZER_SCHEMA",
    "build_kai_chat_agent",
    "load_kai_analyst_gene",
    "load_kai_chat_gene",
    "load_kai_portfolio_optimizer_gene",
    "run_kai_analyst_turn",
    "run_kai_debate_turn",
    "run_kai_synthesis_turn",
    "run_kai_chat_turn",
    "run_kai_portfolio_optimizer",
]
