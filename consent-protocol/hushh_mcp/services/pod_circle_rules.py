"""Sealed commit-log persistence and offline evaluator for Circle Auto-Approve rules.

Rules and privacy-safe audit receipts live strictly inside the owner's encrypted
pod commit log (``PodCommitLog``), sealed under the pod's own storage key:

* ``circle_auto_approve_rules_v1``: complete snapshot of this owner's rules.
  Toggling or deleting a rule immediately appends a new snapshot so instant
  revocation takes effect on the very next offline evaluation.
* ``circle_auto_approve_receipt_v1``: append-only structural audit receipts
  (zero requester PII, zero document content) used both for 24-hour daily cap
  enforcement and owner Activity transparency.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable, Mapping
from typing import Any

from hushh_mcp.operons.circle_auto_approve import (
    MAX_RULES_PER_OWNER,
    AutoApproveDecision,
    CircleAutoApproveRule,
    CircleRuleValidationError,
    SemanticMatcher,
    evaluate_circle_auto_approve,
    validate_circle_rule,
    validate_rule_id,
)
from hushh_mcp.services.pod_config import resolve_pod_config

logger = logging.getLogger(__name__)

CIRCLE_RULES_RECORD_KIND = "circle_auto_approve_rules_v1"
CIRCLE_RULES_SCHEMA_VERSION = 1
CIRCLE_RECEIPT_RECORD_KIND = "circle_auto_approve_receipt_v1"
_ONE_DAY_MS = 24 * 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


def rules_from_records(records: Any, *, hushh_id: str) -> list[CircleAutoApproveRule]:
    """Extract the newest ``circle_auto_approve_rules_v1`` snapshot for ``hushh_id``."""
    chosen: list[Any] | None = None
    for record in records or []:
        if str((record or {}).get("kind") or "") != CIRCLE_RULES_RECORD_KIND:
            continue
        payload = (record or {}).get("payload") or {}
        if str(payload.get("hushh_id") or "") != hushh_id:
            continue
        raw_rules = payload.get("rules")
        if isinstance(raw_rules, list):
            chosen = raw_rules

    if chosen is None:
        return []

    parsed: list[CircleAutoApproveRule] = []
    for item in chosen:
        if not isinstance(item, Mapping):
            continue
        try:
            parsed.append(validate_circle_rule(item))
        except CircleRuleValidationError as exc:
            logger.warning("pod_circle_rules.stored_rule_ignored code=%s", exc.code)
    return parsed


def receipts_from_records(records: Any, *, hushh_id: str, limit: int = 25) -> list[dict[str, Any]]:
    """Extract recent privacy-safe audit receipts for ``hushh_id`` (newest first)."""
    matched: list[dict[str, Any]] = []
    for record in records or []:
        if str((record or {}).get("kind") or "") != CIRCLE_RECEIPT_RECORD_KIND:
            continue
        payload = (record or {}).get("payload") or {}
        if str(payload.get("hushh_id") or "") != hushh_id:
            continue
        receipt = payload.get("receipt")
        if isinstance(receipt, Mapping):
            entry = dict(receipt)
            entry["recorded_at_ms"] = int(payload.get("recorded_at_ms") or 0)
            matched.append(entry)
    matched.reverse()
    return matched[: max(1, min(limit, 100))]


def count_fulfillments_last_24h(
    records: Any, *, hushh_id: str, now_ms: int | None = None
) -> dict[str, int]:
    """Count auto-approved fulfillments per rule within the rolling 24-hour window."""
    cutoff = (now_ms if now_ms is not None else _now_ms()) - _ONE_DAY_MS
    counts: dict[str, int] = {}
    for record in records or []:
        if str((record or {}).get("kind") or "") != CIRCLE_RECEIPT_RECORD_KIND:
            continue
        payload = (record or {}).get("payload") or {}
        if str(payload.get("hushh_id") or "") != hushh_id:
            continue
        ts = int(payload.get("recorded_at_ms") or 0)
        if ts < cutoff:
            continue
        receipt = payload.get("receipt") or {}
        if str(receipt.get("decision") or "") != "auto_approve":
            continue
        rule_id = str(receipt.get("matched_rule_id") or "").strip()
        if rule_id:
            counts[rule_id] = counts.get(rule_id, 0) + 1
    return counts


async def _write_rules_snapshot(
    log: Any, *, hushh_id: str, rules: list[CircleAutoApproveRule], now_ms: int
) -> None:
    if log is None:
        raise CircleRuleValidationError(
            "CIRCLE_RULES_STORE_UNAVAILABLE",
            "This pod has no durable encrypted store for Circle rules.",
        )
    if not str(hushh_id or "").strip():
        raise CircleRuleValidationError(
            "OWNER_IDENTITY_REQUIRED",
            "Owner identity is required to store Circle rules.",
        )
    await log.append(
        CIRCLE_RULES_RECORD_KIND,
        {
            "hushh_id": hushh_id,
            "version": CIRCLE_RULES_SCHEMA_VERSION,
            "rules": [rule.as_dict() for rule in rules],
            "recorded_at_ms": now_ms,
        },
    )


async def list_circle_rules(
    log: Any, *, hushh_id: str
) -> tuple[list[CircleAutoApproveRule], list[dict[str, Any]]]:
    """Return all active/paused Circle rules plus recent structural receipts."""
    if log is None or not str(hushh_id or "").strip():
        return [], []
    records = await log.replay()
    return (
        rules_from_records(records, hushh_id=hushh_id),
        receipts_from_records(records, hushh_id=hushh_id),
    )


async def upsert_circle_rule(
    log: Any,
    *,
    hushh_id: str,
    rule_payload: Mapping[str, Any],
    now_ms: int | None = None,
) -> CircleAutoApproveRule:
    """Create or update a Dual-Lock Circle Auto-Approve rule."""
    if log is None:
        raise CircleRuleValidationError(
            "CIRCLE_RULES_STORE_UNAVAILABLE",
            "This pod has no durable encrypted store for Circle rules.",
        )
    ts = now_ms if now_ms is not None else _now_ms()
    records = await log.replay()
    existing = rules_from_records(records, hushh_id=hushh_id)

    requested_id = (
        str(rule_payload.get("rule_id") or rule_payload.get("ruleId") or "").strip().lower()
    )
    prior = next((r for r in existing if r.rule_id == requested_id), None) if requested_id else None

    validated = validate_circle_rule(
        rule_payload,
        existing_rule_id=prior.rule_id if prior else None,
        now_ms=ts,
        existing_created_at_ms=prior.created_at_ms if prior else ts,
    )

    updated: list[CircleAutoApproveRule] = []
    replaced = False
    for rule in existing:
        if rule.rule_id == validated.rule_id:
            updated.append(validated)
            replaced = True
        else:
            updated.append(rule)
    if not replaced:
        if len(updated) >= MAX_RULES_PER_OWNER:
            raise CircleRuleValidationError(
                "MAX_RULES_REACHED",
                f"At most {MAX_RULES_PER_OWNER} Circle auto-approve rules are supported.",
            )
        updated.append(validated)

    await _write_rules_snapshot(log, hushh_id=hushh_id, rules=updated, now_ms=ts)
    return validated


async def toggle_circle_rule(
    log: Any,
    *,
    hushh_id: str,
    rule_id: str,
    enabled: bool,
    now_ms: int | None = None,
) -> CircleAutoApproveRule:
    """Instant 1-tap enable or revocation of an existing Circle Auto-Approve rule."""
    if log is None:
        raise CircleRuleValidationError(
            "CIRCLE_RULES_STORE_UNAVAILABLE",
            "This pod has no durable encrypted store for Circle rules.",
        )
    clean_id = validate_rule_id(rule_id)
    ts = now_ms if now_ms is not None else _now_ms()
    records = await log.replay()
    existing = rules_from_records(records, hushh_id=hushh_id)

    target: CircleAutoApproveRule | None = None
    updated: list[CircleAutoApproveRule] = []
    for rule in existing:
        if rule.rule_id == clean_id:
            toggled = CircleAutoApproveRule(
                rule_id=rule.rule_id,
                circle_id=rule.circle_id,
                label=rule.label,
                scope_patterns=rule.scope_patterns,
                nl_policy_filter=rule.nl_policy_filter,
                delegation_subkey_ref=rule.delegation_subkey_ref,
                enabled=bool(enabled),
                daily_cap=rule.daily_cap,
                require_confidence=rule.require_confidence,
                created_at_ms=rule.created_at_ms,
                updated_at_ms=ts,
            )
            target = toggled
            updated.append(toggled)
        else:
            updated.append(rule)

    if target is None:
        raise CircleRuleValidationError(
            "RULE_NOT_FOUND", f"Circle rule '{clean_id}' was not found."
        )

    await _write_rules_snapshot(log, hushh_id=hushh_id, rules=updated, now_ms=ts)
    return target


async def delete_circle_rule(
    log: Any,
    *,
    hushh_id: str,
    rule_id: str,
    now_ms: int | None = None,
) -> bool:
    """Permanently delete a Circle Auto-Approve rule from the encrypted log."""
    if log is None:
        raise CircleRuleValidationError(
            "CIRCLE_RULES_STORE_UNAVAILABLE",
            "This pod has no durable encrypted store for Circle rules.",
        )
    clean_id = validate_rule_id(rule_id)
    ts = now_ms if now_ms is not None else _now_ms()
    records = await log.replay()
    existing = rules_from_records(records, hushh_id=hushh_id)
    remaining = [r for r in existing if r.rule_id != clean_id]
    if len(remaining) == len(existing):
        return False
    await _write_rules_snapshot(log, hushh_id=hushh_id, rules=remaining, now_ms=ts)
    return True


async def evaluate_incoming_circle_request(
    log: Any,
    *,
    hushh_id: str,
    circle_id: str,
    requester_in_circle: bool,
    requested_scope: str,
    candidate_summary: str,
    candidate_tags: Iterable[str] = (),
    requester_prompt_text: str = "",
    request_ref: str = "",
    available_subkey_refs: Iterable[str] | None = None,
    semantic_matcher: SemanticMatcher | None = None,
    record_receipt: bool = True,
    now_ms: int | None = None,
) -> AutoApproveDecision:
    """Evaluate an inbound Circle request against persisted rules & pod lockdown."""
    ts = now_ms if now_ms is not None else _now_ms()
    pod_cfg = await resolve_pod_config(log, hushh_id=hushh_id)
    records = await log.replay() if log is not None else []
    rules = rules_from_records(records, hushh_id=hushh_id)
    counts = count_fulfillments_last_24h(records, hushh_id=hushh_id, now_ms=ts)

    decision = evaluate_circle_auto_approve(
        rules=rules,
        circle_id=circle_id,
        requester_in_circle=requester_in_circle,
        requested_scope=requested_scope,
        candidate_summary=candidate_summary,
        candidate_tags=candidate_tags,
        session_only_lockdown=pod_cfg.session_only_lockdown,
        fulfilled_today_by_rule=counts,
        available_subkey_refs=available_subkey_refs,
        requester_prompt_text=requester_prompt_text,
        request_ref=request_ref,
        semantic_matcher=semantic_matcher,
    )

    if record_receipt and log is not None and str(hushh_id or "").strip():
        await log.append(
            CIRCLE_RECEIPT_RECORD_KIND,
            {
                "hushh_id": hushh_id,
                "version": CIRCLE_RULES_SCHEMA_VERSION,
                "receipt": dict(decision.receipt_summary),
                "recorded_at_ms": ts,
            },
        )
    return decision


__all__ = [
    "CIRCLE_RECEIPT_RECORD_KIND",
    "CIRCLE_RULES_RECORD_KIND",
    "CIRCLE_RULES_SCHEMA_VERSION",
    "count_fulfillments_last_24h",
    "delete_circle_rule",
    "evaluate_incoming_circle_request",
    "list_circle_rules",
    "receipts_from_records",
    "rules_from_records",
    "toggle_circle_rule",
    "upsert_circle_rule",
]
