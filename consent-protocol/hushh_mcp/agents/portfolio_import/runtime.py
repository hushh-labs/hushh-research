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
from hushh_mcp.runtime_providers import build_managed_runtime_client
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

_MANIFEST_PATH = Path(__file__).with_name("agent.yaml")

_EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "statement_details": {"type": "OBJECT"},
        "portfolio_summary": {"type": "OBJECT"},
        "detailed_holdings": {"type": "ARRAY", "items": {"type": "OBJECT"}},
        "cash_balance": {"type": "NUMBER", "nullable": True},
        "total_value": {"type": "NUMBER", "nullable": True},
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
    "properties": {"holdings": {"type": "ARRAY", "items": {"type": "OBJECT"}}},
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
    model = gene.model_config_for_runtime()
    return resolve_fleet_model_name(str(model.name))


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
    client = build_managed_runtime_client(gene.model.provider)
    from google.adk.models import Gemini

    resolved_model = _model_name(gene, model_name)
    agent = build_single_turn_agent(
        gene,
        output_schema=output_schema,
        model=Gemini(model=resolved_model, client=client),
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
