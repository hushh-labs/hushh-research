"""Manifest-owned ADK genes for Connected Systems."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from google.adk.models import Gemini

from hushh_mcp.hushh_adk.manifest import AgentSubagentConfig, ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers import build_managed_runtime_client
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

_MANIFEST_PATH = Path(__file__).with_name("agent.yaml")

CRM_SCHEMA_MAPPING_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "mappings": {
            "type": "OBJECT",
            "properties": {
                semantic: {
                    "type": "OBJECT",
                    "nullable": True,
                    "properties": {
                        "fieldKey": {"type": "STRING", "nullable": True},
                        "confidence": {"type": "NUMBER"},
                        "reason": {"type": "STRING"},
                    },
                    "required": ["fieldKey", "confidence", "reason"],
                }
                for semantic in (
                    "email",
                    "phone",
                    "phoneCountryCode",
                    "firstName",
                    "lastName",
                    "fullName",
                    "address",
                )
            },
            "required": [
                "email",
                "phone",
                "phoneCountryCode",
                "firstName",
                "lastName",
                "fullName",
                "address",
            ],
        }
    },
    "required": ["mappings"],
}


@lru_cache(maxsize=8)
def load_connected_systems_gene(gene_id: str) -> AgentSubagentConfig:
    """Load one bounded child from Connected Systems' authored manifest."""

    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    try:
        gene = next(child for child in manifest.subagents if child.id == gene_id)
    except StopIteration as exc:
        raise RuntimeError(f"Connected Systems manifest is missing gene: {gene_id}") from exc
    if gene.runtime.adk_mode != "single_turn" or gene.runtime.transport != ["in_process"]:
        raise RuntimeError(f"Connected Systems gene has an invalid runtime boundary: {gene_id}")
    if gene.privacy.plaintext_telemetry:
        raise RuntimeError(f"Connected Systems gene permits plaintext telemetry: {gene_id}")
    return gene


async def run_connected_systems_gene(
    *,
    gene_id: str,
    prompt: str,
    user_id: str,
    consent_token: str,
    output_schema: Any = dict,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Run one owner-authorized, schema-constrained Connected Systems call."""

    if not str(prompt or "").strip():
        raise ValueError("Connected Systems gene prompt is required")
    if not str(user_id or "").strip() or not str(consent_token or "").strip():
        raise ValueError("Connected Systems gene authority is required")

    gene = load_connected_systems_gene(gene_id)
    model_name = resolve_fleet_model_name(str(gene.model.name))
    client = build_managed_runtime_client(gene.model.provider)
    agent = build_single_turn_agent(
        gene,
        output_schema=output_schema,
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
            else max(5.0, gene.performance.latency_p95_ms / 1000)
        ),
    )
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    if not isinstance(payload, dict):
        raise ValueError("Connected Systems gene returned a non-object payload")
    return json.loads(json.dumps(payload, separators=(",", ":")))


__all__ = [
    "CRM_SCHEMA_MAPPING_SCHEMA",
    "load_connected_systems_gene",
    "run_connected_systems_gene",
]
