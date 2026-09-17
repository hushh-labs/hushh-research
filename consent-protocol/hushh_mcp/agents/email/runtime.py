"""Manifest-owned ADK genes used by the Email specialist.

The Gmail service owns transport and confirmation boundaries.  This module owns
the small, schema-constrained model calls that support those boundaries so
email workflows do not grow a second provider configuration path.
"""

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

EMAIL_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "to": {"type": "ARRAY", "items": {"type": "STRING"}},
        "cc": {"type": "ARRAY", "items": {"type": "STRING"}},
        "bcc": {"type": "ARRAY", "items": {"type": "STRING"}},
        "subject": {"type": "STRING"},
        "body": {"type": "STRING"},
        "missing_details": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["to", "cc", "bcc", "subject", "body", "missing_details"],
}

EMAIL_RECEIPT_MEMORY_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "readable_summary": {
            "type": "OBJECT",
            "properties": {
                "text": {"type": "STRING"},
                "highlights": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
            "required": ["text", "highlights"],
        },
        "signal_language": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "signal_id": {"type": "STRING"},
                    "human_label": {"type": "STRING"},
                    "rationale": {"type": "STRING"},
                },
                "required": ["signal_id", "human_label", "rationale"],
            },
        },
    },
    "required": ["readable_summary", "signal_language"],
}

EMAIL_REQUEST_CLASSIFIER_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "is_information_request": {"type": "BOOLEAN"},
        "confidence": {"type": "NUMBER"},
        "requested_field_labels": {"type": "ARRAY", "items": {"type": "STRING"}},
        "requested_domains": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": [
        "is_information_request",
        "confidence",
        "requested_field_labels",
        "requested_domains",
    ],
}

EMAIL_RECEIPT_EXTRACTOR_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "is_receipt": {"type": "BOOLEAN"},
        "confidence": {"type": "NUMBER"},
        "merchant_name": {"type": "STRING", "nullable": True},
        "order_id": {"type": "STRING", "nullable": True},
        "amount": {"type": "NUMBER", "nullable": True},
        "currency": {"type": "STRING", "nullable": True},
    },
    "required": [
        "is_receipt",
        "confidence",
        "merchant_name",
        "order_id",
        "amount",
        "currency",
    ],
}


@lru_cache(maxsize=8)
def load_email_gene(gene_id: str) -> AgentSubagentConfig:
    """Load one bounded Email child from the authored manifest."""

    manifest = ManifestLoader.load(str(_MANIFEST_PATH))
    try:
        gene = next(child for child in manifest.subagents if child.id == gene_id)
    except StopIteration as exc:
        raise RuntimeError(f"Email manifest is missing gene: {gene_id}") from exc
    if gene.runtime.adk_mode != "single_turn" or gene.runtime.transport != ["in_process"]:
        raise RuntimeError(f"Email gene has an invalid runtime boundary: {gene_id}")
    if gene.privacy.plaintext_telemetry:
        raise RuntimeError(f"Email gene permits plaintext telemetry: {gene_id}")
    return gene


async def run_email_gene(
    *,
    gene_id: str,
    prompt: str,
    user_id: str,
    consent_token: str,
    output_schema: Any = dict,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """Run one owner-authorized, schema-constrained Email model call."""

    if not str(prompt or "").strip():
        raise ValueError("Email gene prompt is required")
    if not str(user_id or "").strip() or not str(consent_token or "").strip():
        raise ValueError("Email gene authority is required")

    gene = load_email_gene(gene_id)
    model_config = gene.model
    model_name = resolve_fleet_model_name(str(model_config.name))
    client = build_managed_runtime_client(model_config.provider)
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
            else max(30.0, gene.performance.latency_p95_ms / 1000)
        ),
    )
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    if not isinstance(payload, dict):
        raise ValueError("Email gene returned a non-object payload")
    return json.loads(json.dumps(payload, separators=(",", ":")))


__all__ = [
    "EMAIL_DRAFT_SCHEMA",
    "EMAIL_REQUEST_CLASSIFIER_SCHEMA",
    "EMAIL_RECEIPT_EXTRACTOR_SCHEMA",
    "EMAIL_RECEIPT_MEMORY_SCHEMA",
    "load_email_gene",
    "run_email_gene",
]
