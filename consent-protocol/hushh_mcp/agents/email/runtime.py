"""Manifest-owned ADK genes used by the Email specialist.

The Gmail service owns transport and confirmation boundaries.  This module owns
the small, schema-constrained model calls that support those boundaries so
email workflows do not grow a second provider configuration path.
"""

from __future__ import annotations

import asyncio
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from hushh_mcp.hushh_adk.manifest import AgentSubagentConfig, ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers.vertex_failover import is_retryable_vertex_error

_MANIFEST_PATH = Path(__file__).with_name("agent.yaml")


def _is_retryable_email_gene_error(error: Exception) -> bool:
    """Return whether a side-effect-free Email gene can be replayed once."""

    if is_retryable_vertex_error(error) or isinstance(error, TimeoutError):
        return True
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        # The shared ADK runner preserves the underlying timeout as the cause
        # of SpecialistAdkTurnError. Email genes have no tools, so one replay
        # after that cancellation is safe.
        if isinstance(current, TimeoutError):
            return True
        if isinstance(current, (json.JSONDecodeError, ValidationError)):
            return True
        if isinstance(current, ValueError) and str(current) in {
            "single-turn agent returned an empty response",
            "single-turn agent returned invalid JSON",
            "single-turn agent returned a non-object response",
            "single-turn response does not match output schema",
        }:
            return True
        current = current.__cause__ or current.__context__
    return False


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

# Live Gmail receipt reads require provenance for every semantic field.  The
# deterministic validator may reject an unsupported selection, but it never
# substitutes its own merchant, order, total evidence, or event judgement.
EMAIL_LIVE_RECEIPT_EXTRACTOR_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "is_receipt": {"type": "BOOLEAN"},
        "confidence": {"type": "NUMBER"},
        "receipt_evidence_ids": {"type": "ARRAY", "items": {"type": "STRING"}},
        "event_type": {
            "type": "STRING",
            "enum": ["purchase", "fulfillment", "refund", "cancellation", "unknown"],
        },
        "event_evidence_id": {"type": "STRING", "nullable": True},
        "merchant_name": {"type": "STRING", "nullable": True},
        "merchant_evidence_id": {"type": "STRING", "nullable": True},
        "merchant_evidence": {"type": "STRING", "nullable": True},
        "document_kind": {
            "type": "STRING",
            "nullable": True,
            "enum": [
                "invoice",
                "receipt",
                "payment_confirmation",
                "order_confirmation",
                "booking",
                "fulfillment",
            ],
        },
        "document_evidence": {"type": "STRING", "nullable": True},
        "transaction_date": {"type": "STRING", "nullable": True},
        "identifiers": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "kind": {
                        "type": "STRING",
                        "enum": ["order", "invoice", "receipt", "pnr", "payment"],
                    },
                    "value": {"type": "STRING"},
                    "evidence": {"type": "STRING"},
                },
                "required": ["kind", "value", "evidence"],
            },
        },
        "order_id": {"type": "STRING", "nullable": True},
        "order_evidence_id": {"type": "STRING", "nullable": True},
        "amount_evidence_id": {"type": "STRING", "nullable": True},
        "category": {
            "type": "STRING",
            "nullable": True,
            "enum": [
                "Shopping",
                "Food",
                "Travel",
                "Transport",
                "Software & Subscriptions",
                "Cloud & Infra",
                "Bills",
                "Uncategorized",
                "Subscription",
                "Other",
            ],
        },
        "category_confidence": {"type": "NUMBER", "nullable": True},
        "category_evidence": {"type": "STRING", "nullable": True},
        "status": {
            "type": "STRING",
            "nullable": True,
            "enum": [
                "paid",
                "overdue",
                "refunded",
                "cancelled",
                "trial",
                "delivered",
                "payment_failed",
                "suspended",
                "renewal_due",
            ],
        },
        "status_evidence": {"type": "STRING", "nullable": True},
        "recurrence": {
            "type": "STRING",
            "enum": ["recurring", "one_time", "unknown"],
        },
        "recurrence_evidence": {"type": "STRING", "nullable": True},
        "attention_state": {
            "type": "STRING",
            "enum": ["none", "needs_attention", "coming_up", "needs_review"],
        },
        "attention_reason": {
            "type": "STRING",
            "nullable": True,
            "enum": [
                "overdue",
                "payment_failed",
                "suspended",
                "renewal_due",
                "low_confidence",
            ],
        },
        "attention_evidence": {"type": "STRING", "nullable": True},
        "attention_is_prediction": {"type": "BOOLEAN"},
        "attention_date": {"type": "STRING", "nullable": True},
        "identifier_kind": {
            "type": "STRING",
            "nullable": True,
            "enum": ["order", "invoice", "receipt", "pnr"],
        },
        "identifier_value": {"type": "STRING", "nullable": True},
        "identifier_evidence": {"type": "STRING", "nullable": True},
        "short_detail": {"type": "STRING", "nullable": True},
        "cleaned_preview": {"type": "STRING", "nullable": True},
    },
    "required": [
        "is_receipt",
        "confidence",
        "receipt_evidence_ids",
        "event_type",
        "event_evidence_id",
        "merchant_name",
        "merchant_evidence_id",
        "merchant_evidence",
        "document_kind",
        "document_evidence",
        "transaction_date",
        "identifiers",
        "order_id",
        "order_evidence_id",
        "amount_evidence_id",
        "category",
        "category_confidence",
        "category_evidence",
        "status",
        "status_evidence",
        "recurrence",
        "recurrence_evidence",
        "attention_state",
        "attention_reason",
        "attention_evidence",
        "attention_is_prediction",
        "attention_date",
        "identifier_kind",
        "identifier_value",
        "identifier_evidence",
        "short_detail",
        "cleaned_preview",
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
    agent = build_single_turn_agent(
        gene,
        output_schema=output_schema,
    )
    request_timeout_seconds = (
        float(timeout_seconds)
        if timeout_seconds is not None
        else max(30.0, gene.performance.latency_p95_ms / 1000)
    )
    for attempt in range(2):
        try:
            result = await run_single_turn(
                agent,
                prompt_parts=str(prompt).strip(),
                user_id=str(user_id),
                consent_token=str(consent_token),
                timeout_seconds=request_timeout_seconds,
            )
            break
        except Exception as exc:
            if attempt or not _is_retryable_email_gene_error(exc):
                raise
            # Email genes are schema-only and have no tools or side effects, so
            # replaying a transient provider failure is safe.
            await asyncio.sleep(0.5)
    payload = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    if not isinstance(payload, dict):
        raise ValueError("Email gene returned a non-object payload")
    return json.loads(json.dumps(payload, separators=(",", ":")))


__all__ = [
    "EMAIL_DRAFT_SCHEMA",
    "EMAIL_LIVE_RECEIPT_EXTRACTOR_SCHEMA",
    "EMAIL_REQUEST_CLASSIFIER_SCHEMA",
    "EMAIL_RECEIPT_EXTRACTOR_SCHEMA",
    "EMAIL_RECEIPT_MEMORY_SCHEMA",
    "load_email_gene",
    "run_email_gene",
]
