"""Locked receipt persistence and commit-safe canonical commercial mirror.

ConsentAuditChainService remains the single append authority. This adapter is
called under its existing subject/ledger lock or from a separate committed drain.
"""

from __future__ import annotations

import hmac
import json
import logging
from typing import Any

from hushh_mcp.services.consent_audit_chain_service import (
    AuditSigningKeyMissing,
    _canonical_payload,
    _chain_hash,
    _sign,
    _signature_is_valid,
    consent_audit_chain_enabled,
)

logger = logging.getLogger(__name__)


async def _pool():
    # Preserve the canonical service's existing injected database port.
    from hushh_mcp.services.consent_audit_chain_service import get_pool

    return await get_pool()


def append_result(row: Any, ledger: str, *, already_present: bool) -> dict[str, Any]:
    """Project a verified existing receipt or the canonical signed append result."""
    return {
        "id": int(row["id"]),
        "ledger": ledger,
        "seq": int(row["seq"]),
        "event_type": row["event_type"],
        "prev_hash": row["prev_hash"],
        "hash": row["hash"],
        "signature": row["signature"],
        "signed": True,  # _sign refuses rather than writing an unsigned receipt
        "already_present": already_present,
    }


async def insert_locked_receipt(conn: Any, event: dict[str, Any], seq: int, prev_hash: str) -> Any:
    """Only append calls this after owning the subject/ledger lock and head."""
    payload = _canonical_payload(seq=seq, **event)
    hash_hex = _chain_hash(prev_hash, payload)
    signature = _sign(hash_hex)
    return await conn.fetchrow(
        """INSERT INTO consent_audit_receipts (
             subject_id,ledger,seq,event_type,agent_id,scope,request_id,token_id,
             audit_event_id,issued_at_ms,metadata,prev_hash,hash,signature)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
           RETURNING id,seq,prev_hash,hash,signature""",
        event["subject_id"],
        event["ledger"],
        seq,
        event["event_type"],
        event["agent_id"],
        event["scope"],
        event["request_id"],
        event["token_id"],
        event["audit_event_id"],
        event["issued_at_ms"],
        json.dumps(event["metadata"], separators=(",", ":")),
        prev_hash,
        hash_hex,
        signature,
    )


async def existing_event_receipt(service: Any, conn: Any, event: dict[str, Any]) -> dict | None:
    existing = await conn.fetchrow(
        """SELECT id,subject_id,ledger,seq,event_type,agent_id,scope,
             request_id,token_id,audit_event_id,issued_at_ms,metadata,
             prev_hash,hash,signature FROM consent_audit_receipts
           WHERE subject_id=$1 AND ledger=$2 AND audit_event_id=$3 ORDER BY seq LIMIT 1""",
        event["subject_id"],
        event["ledger"],
        event["audit_event_id"],
    )
    if not existing:
        return None
    prior = service._row_to_receipt(existing)
    payload = _canonical_payload(
        **{
            key: value
            for key, value in prior.items()
            if key not in {"prev_hash", "hash", "signature"}
        }
    )
    requested = _canonical_payload(seq=prior["seq"], **event)
    if not hmac.compare_digest(payload.encode(), requested.encode()):
        raise ValueError("audit_event_identity_conflict")
    if _chain_hash(prior["prev_hash"], payload) != prior["hash"] or not _signature_is_valid(
        prior["hash"], prior["signature"]
    ):
        raise ValueError("audit_event_receipt_signature_invalid")
    return service._append_result(existing, event["ledger"], already_present=True)


async def reconcile_committed_paid_events(service: Any, *, limit: int = 100) -> dict[str, Any]:
    """Mirror a bounded committed ledger snapshot outside money transactions.

    The canonical audit remains authoritative. A fresh pool connection sees
    committed events only; event-id admission under the existing chain lock
    makes concurrent/restarted drains idempotent. Counters reveal no identity,
    scope, token or metadata. The optional chain flag/key behavior is preserved.
    """
    counts = {
        "enabled": consent_audit_chain_enabled(),
        "scanned": 0,
        "appended": 0,
        "already_present": 0,
        "failed": 0,
        "signing_key_missing": False,
    }
    if not counts["enabled"]:
        return counts
    limit = max(1, min(int(limit), 500))
    try:
        await service.ensure_table()
        pool = await _pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT a.id,a.user_id,a.agent_id,a.scope,a.action,a.request_id,
                     a.token_id,a.issued_at,a.metadata FROM consent_audit a
                   JOIN scope_commerce_purchases p
                     ON p.purchase_id::text=a.metadata::jsonb->>'commerce_purchase_id'
                    AND p.request_id=a.request_id AND p.owner_user_id=a.user_id
                    AND p.machine_scope=a.scope
                   WHERE a.metadata::jsonb->'commercial_required'='true'::jsonb
                     AND a.action IN ('CONSENT_PAID_APPROVED','CONSENT_PAID_FUNDED',
                       'CONSENT_GRANTED','REVOKED','CANCELLED')
                     AND NOT EXISTS(SELECT 1 FROM consent_audit_receipts r
                       WHERE r.subject_id=a.user_id AND r.ledger='consent'
                         AND r.audit_event_id=a.id)
                   ORDER BY a.id LIMIT $1""",
                limit,
            )
    except Exception as exc:
        counts["failed"] = 1
        logger.warning(
            "consent_audit_chain_reconcile_unavailable error_type=%s", type(exc).__name__
        )
        return counts
    counts["scanned"] = len(rows)
    for row in rows:
        try:
            metadata = row["metadata"]
            if isinstance(metadata, str):
                metadata = json.loads(metadata)
            result = await service.append(
                subject_id=str(row["user_id"]),
                event_type=str(row["action"]),
                issued_at_ms=int(row["issued_at"]),
                agent_id=row["agent_id"],
                scope=row["scope"],
                request_id=row["request_id"],
                token_id=row["token_id"],
                audit_event_id=int(row["id"]),
                metadata=dict(metadata or {}),
            )
            counts["already_present" if result["already_present"] else "appended"] += 1
        except AuditSigningKeyMissing:
            counts["failed"] += 1
            counts["signing_key_missing"] = True
            logger.error("consent_audit_chain_reconcile_unsigned")
            break
        except Exception as exc:
            counts["failed"] += 1
            logger.warning("consent_audit_chain_reconcile_failed error_type=%s", type(exc).__name__)
    return counts
