"""Tamper-evident receipt chain for the primary consent-audit ledger.

``consent_audit`` is event-sourced and HMAC-signed at the token layer, but the
table itself is mutable and unchained: a silent edit or delete of an audit row is
not detectable. This service adds the missing tamper-evidence -- NIST 800-53
AU-9 (protection of audit information) + AU-10 (non-repudiation) -- WITHOUT
touching the operational consent write path.

On every consent event, :func:`append_consent_receipt_safe` mirrors the event,
fail-safe, into a per-subject append-only hash chain::

    hash      = sha256( prev_hash || "\\n" || canonical_payload )
    signature = HMAC-SHA256( APP_SIGNING_KEY, hash )

:meth:`ConsentAuditChainService.verify_chain` replays the chain and reports the
first dropped, reordered, or tampered receipt. The construction mirrors the
proven Preference Subscription Fabric ledger (``fabric_receipts_service``,
migration 119); this one is keyed on the consent subject and covers the general
consent ledger (migration 904).

The mirror is FAIL-SAFE and FLAG-GATED (``CONSENT_AUDIT_CHAIN_ENABLED``, default
off): when off, nothing is computed or written and the consent path is
byte-for-byte unchanged; when on, a chain-append failure never blocks the
operational consent write -- it is logged for reconcile and surfaces as a gap
that ``verify_chain`` will flag.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import Any

from db.connection import get_pool
from hushh_mcp.config import APP_SIGNING_KEY
from hushh_mcp.runtime_settings import consent_audit_chain_enabled

logger = logging.getLogger(__name__)

GENESIS_HASH = "0" * 64


def _canonical_payload(
    *,
    subject_id: str,
    seq: int,
    event_type: str,
    agent_id: str | None,
    scope: str | None,
    request_id: str | None,
    token_id: str | None,
    audit_event_id: int | None,
    issued_at_ms: int,
    metadata: dict[str, Any],
) -> str:
    """Deterministic JSON for the hashed body (stable key order, compact)."""
    return json.dumps(
        {
            "subject_id": subject_id,
            "seq": seq,
            "event_type": event_type,
            "agent_id": agent_id,
            "scope": scope,
            "request_id": request_id,
            "token_id": token_id,
            "audit_event_id": audit_event_id,
            "issued_at_ms": issued_at_ms,
            "metadata": metadata,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def _chain_hash(prev_hash: str, payload: str) -> str:
    return hashlib.sha256(f"{prev_hash}\n{payload}".encode()).hexdigest()


def _sign(hash_hex: str) -> str:
    # Mirrors hushh_mcp.consent.token._sign and fabric_receipts_service._sign:
    # HMAC-SHA256 keyed with APP_SIGNING_KEY.
    return hmac.new(APP_SIGNING_KEY.encode(), hash_hex.encode(), hashlib.sha256).hexdigest()


class ConsentAuditChainService:
    """Append-only, per-subject hash-chained mirror of consent_audit events."""

    def __init__(self) -> None:
        self._table_ready = False

    async def ensure_table(self) -> None:
        """Idempotent safety-net; migration 904 is authoritative."""
        if self._table_ready:
            return
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS consent_audit_receipts (
                    id BIGSERIAL PRIMARY KEY,
                    subject_id TEXT NOT NULL,
                    seq BIGINT NOT NULL,
                    event_type TEXT NOT NULL,
                    agent_id TEXT,
                    scope TEXT,
                    request_id TEXT,
                    token_id TEXT,
                    audit_event_id BIGINT,
                    issued_at_ms BIGINT NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                    prev_hash TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    signature TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    UNIQUE (subject_id, seq),
                    UNIQUE (subject_id, hash)
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_consent_audit_receipts_subject "
                "ON consent_audit_receipts (subject_id, id)"
            )
        self._table_ready = True

    async def append(
        self,
        *,
        subject_id: str,
        event_type: str,
        issued_at_ms: int,
        agent_id: str | None = None,
        scope: str | None = None,
        request_id: str | None = None,
        token_id: str | None = None,
        audit_event_id: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one receipt in its own per-subject advisory-locked transaction.

        The advisory lock serializes concurrent appends for a subject so two
        events cannot read the same head and fork the chain.
        """
        await self.ensure_table()
        meta = dict(metadata or {})
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))",
                    f"consent_audit_receipts:{subject_id}",
                )
                prev = await conn.fetchrow(
                    "SELECT seq, hash FROM consent_audit_receipts "
                    "WHERE subject_id = $1 ORDER BY seq DESC LIMIT 1",
                    subject_id,
                )
                seq = (int(prev["seq"]) + 1) if prev is not None else 1
                prev_hash = str(prev["hash"]) if prev is not None else GENESIS_HASH

                payload = _canonical_payload(
                    subject_id=subject_id,
                    seq=seq,
                    event_type=event_type,
                    agent_id=agent_id,
                    scope=scope,
                    request_id=request_id,
                    token_id=token_id,
                    audit_event_id=audit_event_id,
                    issued_at_ms=issued_at_ms,
                    metadata=meta,
                )
                hash_hex = _chain_hash(prev_hash, payload)
                signature = _sign(hash_hex)

                row = await conn.fetchrow(
                    """
                    INSERT INTO consent_audit_receipts (
                        subject_id, seq, event_type, agent_id, scope, request_id,
                        token_id, audit_event_id, issued_at_ms, metadata,
                        prev_hash, hash, signature
                    )
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
                    RETURNING id, seq, prev_hash, hash, signature
                    """,
                    subject_id,
                    seq,
                    event_type,
                    agent_id,
                    scope,
                    request_id,
                    token_id,
                    audit_event_id,
                    issued_at_ms,
                    json.dumps(meta, separators=(",", ":")),
                    prev_hash,
                    hash_hex,
                    signature,
                )
        return {
            "id": int(row["id"]),
            "seq": int(row["seq"]),
            "event_type": event_type,
            "prev_hash": row["prev_hash"],
            "hash": row["hash"],
            "signature": row["signature"],
        }

    async def list_receipts(self, subject_id: str, *, limit: int = 1000) -> list[dict[str, Any]]:
        await self.ensure_table()
        limit = max(1, min(int(limit), 5000))
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT subject_id, seq, event_type, agent_id, scope, request_id,
                       token_id, audit_event_id, issued_at_ms, metadata,
                       prev_hash, hash, signature
                FROM consent_audit_receipts
                WHERE subject_id = $1
                ORDER BY seq ASC
                LIMIT $2
                """,
                subject_id,
                limit,
            )
        return [self._row_to_receipt(row) for row in rows]

    @staticmethod
    def _row_to_receipt(row: Any) -> dict[str, Any]:
        def _as_obj(value: Any) -> dict[str, Any]:
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except (ValueError, TypeError):
                    return {}
                return parsed if isinstance(parsed, dict) else {}
            return dict(value) if isinstance(value, dict) else {}

        return {
            "subject_id": row["subject_id"],
            "seq": int(row["seq"]),
            "event_type": row["event_type"],
            "agent_id": row["agent_id"],
            "scope": row["scope"],
            "request_id": row["request_id"],
            "token_id": row["token_id"],
            "audit_event_id": (
                int(row["audit_event_id"]) if row["audit_event_id"] is not None else None
            ),
            "issued_at_ms": int(row["issued_at_ms"]),
            "metadata": _as_obj(row["metadata"]),
            "prev_hash": row["prev_hash"],
            "hash": row["hash"],
            "signature": row["signature"],
        }

    @staticmethod
    def verify_receipts(subject_id: str, receipts: list[dict[str, Any]]) -> dict[str, Any]:
        """Pure chain verification -- recompute hashes + signatures, report first break.

        Separated from the DB fetch so drop / reorder / tamper detection is
        unit-testable without a database.
        """
        prev_hash = GENESIS_HASH
        expected_seq = 1
        for receipt in receipts:
            if receipt["seq"] != expected_seq:
                return {"ok": False, "broken_at_seq": receipt["seq"], "reason": "seq_gap"}
            payload = _canonical_payload(
                subject_id=subject_id,
                seq=receipt["seq"],
                event_type=receipt["event_type"],
                agent_id=receipt["agent_id"],
                scope=receipt["scope"],
                request_id=receipt["request_id"],
                token_id=receipt["token_id"],
                audit_event_id=receipt["audit_event_id"],
                issued_at_ms=receipt["issued_at_ms"],
                metadata=receipt["metadata"],
            )
            expected_hash = _chain_hash(prev_hash, payload)
            if receipt["prev_hash"] != prev_hash:
                return {
                    "ok": False,
                    "broken_at_seq": receipt["seq"],
                    "reason": "prev_hash_mismatch",
                }
            if receipt["hash"] != expected_hash:
                return {"ok": False, "broken_at_seq": receipt["seq"], "reason": "hash_mismatch"}
            if not hmac.compare_digest(receipt["signature"], _sign(receipt["hash"])):
                return {
                    "ok": False,
                    "broken_at_seq": receipt["seq"],
                    "reason": "signature_mismatch",
                }
            prev_hash = receipt["hash"]
            expected_seq += 1
        return {
            "ok": True,
            "count": len(receipts),
            "head_seq": len(receipts),
            "head_hash": prev_hash,
        }

    async def verify_chain(
        self,
        subject_id: str,
        *,
        expected_head_seq: int | None = None,
        expected_head_hash: str | None = None,
    ) -> dict[str, Any]:
        """Fetch the subject's receipts and verify the chain integrity.

        **Head anchoring.** A ``prev_hash`` walk proves every surviving link, and
        proves nothing about links that no longer exist. Dropping the newest
        receipts, or all of them, leaves rows 1..k -- or zero rows -- chaining
        perfectly, so an unanchored check answers ``ok`` for a chain that has been
        truncated or wiped. A tamper-evident ledger that reports success after
        being emptied is not tamper-evident, and this is exactly the case an
        auditor would test first.

        The caller pins the last head it saw (trust-on-first-use, the same shape
        the Fabric receipt chain already uses) and passes it back. A head that has
        regressed below, or diverged from, the pinned one fails closed. With no
        pin this returns the head so the caller can pin it for next time.
        """
        receipts = await self.list_receipts(subject_id, limit=5000)
        result = self.verify_receipts(subject_id, receipts)
        if not result.get("ok"):
            return result

        head_seq = int(result.get("head_seq") or 0)
        head_hash = str(result.get("head_hash") or "")
        if expected_head_seq is not None:
            if head_seq < int(expected_head_seq):
                return {
                    "ok": False,
                    "broken_at_seq": head_seq,
                    "reason": "head_regressed",
                    "head_seq": head_seq,
                    "head_hash": head_hash,
                    "expected_head_seq": int(expected_head_seq),
                }
            if (
                head_seq == int(expected_head_seq)
                and expected_head_hash is not None
                and not hmac.compare_digest(head_hash, str(expected_head_hash))
            ):
                return {
                    "ok": False,
                    "broken_at_seq": head_seq,
                    "reason": "head_diverged",
                    "head_seq": head_seq,
                    "head_hash": head_hash,
                }
        return result


_consent_audit_chain_service: ConsentAuditChainService | None = None


def get_consent_audit_chain_service() -> ConsentAuditChainService:
    global _consent_audit_chain_service
    if _consent_audit_chain_service is None:
        _consent_audit_chain_service = ConsentAuditChainService()
    return _consent_audit_chain_service


async def append_consent_receipt_safe(
    *,
    subject_id: str,
    event_type: str,
    issued_at_ms: int,
    agent_id: str | None = None,
    scope: str | None = None,
    request_id: str | None = None,
    token_id: str | None = None,
    audit_event_id: int | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Flag-gated, FAIL-SAFE mirror of one consent event into the receipt chain.

    Does nothing unless ``CONSENT_AUDIT_CHAIN_ENABLED`` is on. A chain-append
    failure is logged (for reconcile) and swallowed so it can NEVER break the
    operational consent-audit write -- the missing receipt surfaces as a gap that
    ``verify_chain`` reports. Callable from any consent_audit writer path.
    """
    if not subject_id or not consent_audit_chain_enabled():
        return
    try:
        await get_consent_audit_chain_service().append(
            subject_id=subject_id,
            event_type=event_type,
            issued_at_ms=issued_at_ms,
            agent_id=agent_id,
            scope=scope,
            request_id=request_id,
            token_id=token_id,
            audit_event_id=audit_event_id,
            metadata=metadata,
        )
    except Exception:  # noqa: BLE001 -- fail-safe: the audit mirror must never break the consent write
        logger.exception(
            "consent_audit_chain_append_failed subject=%s event=%s", subject_id, event_type
        )
