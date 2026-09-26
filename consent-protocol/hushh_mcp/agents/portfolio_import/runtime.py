"""Manifest-owned ADK calls used by Portfolio Import's parser adapters.

The public upload route and the legacy parser classes share this small runtime
boundary.  Parsers remain deterministic; only the explicitly named extraction
genes may invoke Gemini.  The helpers accept text or document parts so callers
can preserve the existing PDF/CSV input contract without recreating provider
configuration in each parser.
"""

from __future__ import annotations

import json
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Sequence

from google.genai import types

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers import build_managed_regional_gemini_adk_model
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

_MANIFEST_PATH = Path(__file__).with_name("agent.yaml")

_TEXT: dict[str, Any] = {"type": "STRING", "nullable": True}
_NUMBER: dict[str, Any] = {"type": "NUMBER", "nullable": True}

# Gemini structured output can only return keys a schema declares: an OBJECT
# with no properties decodes to {}. Declared as bare OBJECTs, every holding came
# back empty and imports found nothing. These are the keys the prompts ask for
# (kai_import/prompt_v2.py rule 7 and the text-extraction prompt in
# portfolio_import_service) and the route reads back.
_HOLDING_ROW_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "symbol": _TEXT,
        "ticker": _TEXT,
        "symbol_cusip": _TEXT,
        "cusip": _TEXT,
        "security_id": _TEXT,
        "name": _TEXT,
        "description": _TEXT,
        "quantity": _NUMBER,
        "price": _NUMBER,
        "market_value": _NUMBER,
        "cost_basis": _NUMBER,
        "unrealized_gain_loss": _NUMBER,
        "unrealized_gain_loss_pct": _NUMBER,
        "est_annual_income": _NUMBER,
        "est_yield": _NUMBER,
        "asset_type": _TEXT,
        "sector": _TEXT,
        "industry": _TEXT,
    },
}

_STATEMENT_DETAILS_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "institution_name": _TEXT,
        "account_number": _TEXT,
        "account_name": _TEXT,
        "statement_period_start": _TEXT,
        "statement_period_end": _TEXT,
        "client_address": _TEXT,
    },
}

# prompt_v2 rule 8: always present, numeric or null.
_PORTFOLIO_SUMMARY_KEYS = (
    "beginning_value",
    "ending_value",
    "change_in_value",
    "net_deposits_withdrawals",
    "income",
    "fees",
)
_PORTFOLIO_SUMMARY_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {key: _NUMBER for key in _PORTFOLIO_SUMMARY_KEYS},
    "required": list(_PORTFOLIO_SUMMARY_KEYS),
}

_EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "statement_details": _STATEMENT_DETAILS_SCHEMA,
        "portfolio_summary": _PORTFOLIO_SUMMARY_SCHEMA,
        "detailed_holdings": {"type": "ARRAY", "items": _HOLDING_ROW_SCHEMA},
        "cash_balance": _NUMBER,
        "total_value": _NUMBER,
    },
    "required": [
        "statement_details",
        "portfolio_summary",
        "detailed_holdings",
        "cash_balance",
        "total_value",
    ],
}

_HOLDINGS_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {"holdings": {"type": "ARRAY", "items": _HOLDING_ROW_SCHEMA}},
    "required": ["holdings"],
}

_RELEVANCE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "is_relevant": {"type": "BOOLEAN"},
        "confidence": {"type": "NUMBER"},
        "doc_type": {"type": "STRING"},
        "reason": {"type": "STRING"},
    },
    "required": ["is_relevant", "confidence", "reason"],
}


@lru_cache(maxsize=8)
def load_portfolio_gene(gene_id: str) -> Any:
    """Return one validated Portfolio Import child from the authored manifest."""

    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    gene = next((child for child in manifest.subagents if child.id == gene_id), None)
    if gene is None:
        raise RuntimeError(f"Portfolio Import gene is missing: {gene_id}")
    if gene.runtime.adk_mode != "single_turn" or gene.runtime.transport != ["in_process"]:
        raise RuntimeError(f"Portfolio Import gene has an invalid runtime boundary: {gene_id}")
    if gene.privacy.plaintext_telemetry:
        raise RuntimeError(f"Portfolio Import gene permits plaintext telemetry: {gene_id}")
    return gene


def _model_name(gene: Any, requested: str | None) -> str:
    if requested and str(requested).strip():
        return resolve_fleet_model_name(str(requested).strip())
    # A gene is an AgentSubagentConfig, whose model config is `.model`;
    # model_config_for_runtime() exists only on the top-level manifest, so
    # callers that did not pass a model (portfolio_import_service) crashed here.
    return resolve_fleet_model_name(str(gene.model.name))


async def run_portfolio_gene(
    *,
    gene_id: str,
    prompt: str,
    user_id: str,
    consent_token: str,
    output_schema: Any = dict,
    document_parts: Sequence[Any] = (),
    model_name: str | None = None,
    timeout_seconds: float | None = None,
) -> tuple[dict[str, Any], int]:
    """Run one bounded, manifest-owned Portfolio Import model call."""

    if not str(prompt or "").strip():
        raise ValueError("Portfolio Import gene prompt is required")
    if not str(user_id or "").strip() or not str(consent_token or "").strip():
        raise ValueError("Portfolio Import gene authority is required")

    gene = load_portfolio_gene(gene_id)
    if str(gene.model.provider or "").strip().lower() != "gemini":
        raise RuntimeError(f"Portfolio Import gene must run on managed Gemini: {gene_id}")

    resolved_model = _model_name(gene, model_name)
    agent = build_single_turn_agent(
        gene,
        output_schema=output_schema,
        # Not Gemini(client=build_managed_runtime_client(...)): with more than one
        # configured Vertex location that returns a VertexRegionalClient, which
        # ADK 2.9's Gemini.client (typed genai.Client) rejects, so every import
        # failed before its request was sent. The regional model is the seam for
        # a tool-less single turn, with bounded failover across locations.
        model=build_managed_regional_gemini_adk_model(resolved_model),
    )
    parts: list[Any] = [types.Part.from_text(text=str(prompt).strip())]
    parts.extend(document_parts)
    started = time.perf_counter()
    result = await run_single_turn(
        agent,
        prompt_parts=str(prompt).strip(),
        message_content=types.Content(role="user", parts=parts),
        user_id=str(user_id),
        consent_token=str(consent_token),
        timeout_seconds=timeout_seconds
        if timeout_seconds is not None
        else max(30.0, gene.performance.latency_p95_ms / 1000),
    )
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    if not isinstance(payload, dict):
        raise ValueError("Portfolio Import gene returned a non-object payload")
    # Force a JSON-compatible copy before parser code handles provider objects.
    normalized = json.loads(json.dumps(payload, separators=(",", ":")))
    return normalized, int((time.perf_counter() - started) * 1000)


__all__ = [
    "load_portfolio_gene",
    "run_portfolio_gene",
    "_EXTRACTION_SCHEMA",
    "_HOLDINGS_SCHEMA",
    "_RELEVANCE_SCHEMA",
]
