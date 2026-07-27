"""Hash-chained receipt ledger for the Preference Subscription Fabric (PCHP RFC-002).

Every subscription event -- a grant, a subscribed-field read, or a revocation --
appends one receipt to a per-owner append-only chain:

    hash      = sha256( prev_hash || "\\n" || canonical_payload )
    signature = HMAC-SHA256( APP_SIGNING_KEY, hash )

The chain lets the owner verify no receipt was inserted, dropped, or reordered;
the signature makes each receipt tamper-evident on its own. This is the PCHP
receipt primitive built here: hushh-research's consent ledger is event-sourced
and HMAC-signed but not chained, so the fabric adds the chain rather than
extending a chain that does not exist.

Appends are serialized per owner with a transaction-scoped Postgres advisory
lock so concurrent events cannot fork the chain.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import Any

import asyncpg

from db.connection import get_pool
from hushh_mcp.config import APP_SIGNING_KEY

logger = logging.getLogger(__name__)

GENESIS_HASH = "0" * 64
_ALLOWED_EVENTS = frozenset({"GRANT", "READ", "REVOKE"})


def _canonical_payload(
    *,
    user_id: str,
    seq: int,
    event_type: str,
    subscriber_id: str | None,
    grant_id: str | None,
    scopes: list[str],
    fields: list[str],
    purpose: str | None,
    created_at_ms: int,
    metadata: dict[str, Any],
) -> str:
    """Deterministic JSON for the hashed body (stable key order, compact)."""
    return json.dumps(
        {
            "user_id": user_id,
            "seq": seq,
            "event_type": event_type,
            "subscriber_id": subscriber_id,
            "grant_id": grant_id,
            "scopes": scopes,
            "fields": fields,
            "purpose": purpose,
            "created_at_ms": created_at_ms,
            "metadata": metadata,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def _chain_hash(prev_hash: str, payload: str) -> str:
    return hashlib.sha256(f"{prev_hash}\n{payload}".encode()).hexdigest()


def _sign(hash_hex: str) -> str:
    # Mirrors hushh_mcp.consent.token._sign: HMAC-SHA256 with APP_SIGNING_KEY.
    return hmac.new(APP_SIGNING_KEY.encode(), hash_hex.encode(), hashlib.sha256).hexdigest()


class FabricReceiptsService:
    def __init__(self) -> None:
        self._table_ready = False

    async def ensure_table(self) -> None:
        """Idempotent safety-net; migration 119 is authoritative."""
        if self._table_ready:
            return
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS fabric_receipts (
                    id BIGSERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    seq BIGINT NOT NULL,
                    event_type TEXT NOT NULL,
                    subscriber_id TEXT,
                    grant_id TEXT,
                    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                    fields JSONB NOT NULL DEFAULT '[]'::jsonb,
                    purpose TEXT,
                    prev_hash TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    signature TEXT NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at_ms BIGINT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    UNIQUE (user_id, seq),
                    UNIQUE (user_id, hash)
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fabric_receipts_user_id "
                "ON fabric_receipts (user_id, id)"
            )
        self._table_ready = True

    async def append_in_conn(
        self,
        conn: asyncpg.Connection,
        *,
        user_id: str,
        event_type: str,
        created_at_ms: int,
        subscriber_id: str | None = None,
        grant_id: str | None = None,
        scopes: list[str] | None = None,
        fields: list[str] | None = None,
        purpose: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one receipt using an existing connection/transaction.

        The caller MUST already hold the per-owner advisory lock (see
        ``append``); this lets a grant/revoke insert its row and its receipt in
        one atomic transaction. Serialization is what keeps the chain sound.
        """
        if event_type not in _ALLOWED_EVENTS:
            raise ValueError(f"Unknown fabric receipt event: {event_type!r}")
        scopes = list(scopes or [])
        fields = list(fields or [])
        metadata = dict(metadata or {})

        prev = await conn.fetchrow(
            "SELECT seq, hash FROM fabric_receipts WHERE user_id = $1 ORDER BY seq DESC LIMIT 1",
            user_id,
        )
        seq = (int(prev["seq"]) + 1) if prev is not None else 1
        prev_hash = str(prev["hash"]) if prev is not None else GENESIS_HASH

        payload = _canonical_payload(
            user_id=user_id,
            seq=seq,
            event_type=event_type,
            subscriber_id=subscriber_id,
            grant_id=grant_id,
            scopes=scopes,
            fields=fields,
            purpose=purpose,
            created_at_ms=created_at_ms,
            metadata=metadata,
        )
        hash_hex = _chain_hash(prev_hash, payload)
        signature = _sign(hash_hex)

        row = await conn.fetchrow(
            """
            INSERT INTO fabric_receipts (
                user_id, seq, event_type, subscriber_id, grant_id,
                scopes, fields, purpose, prev_hash, hash, signature,
                metadata, created_at_ms
            )
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13)
            RETURNING id, seq, prev_hash, hash, signature, created_at_ms
            """,
            user_id,
            seq,
            event_type,
            subscriber_id,
            grant_id,
            json.dumps(scopes, separators=(",", ":")),
            json.dumps(fields, separators=(",", ":")),
            purpose,
            prev_hash,
            hash_hex,
            signature,
            json.dumps(metadata, separators=(",", ":")),
            created_at_ms,
        )
        return {
            "id": int(row["id"]),
            "seq": int(row["seq"]),
            "event_type": event_type,
            "prev_hash": row["prev_hash"],
            "hash": row["hash"],
            "signature": row["signature"],
            "created_at_ms": int(row["created_at_ms"]),
        }

    async def append(
        self,
        *,
        user_id: str,
        event_type: str,
        created_at_ms: int,
        subscriber_id: str | None = None,
        grant_id: str | None = None,
        scopes: list[str] | None = None,
        fields: list[str] | None = None,
        purpose: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one receipt in its own advisory-locked transaction."""
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", f"fabric_receipts:{user_id}"
                )
                return await self.append_in_conn(
                    conn,
                    user_id=user_id,
                    event_type=event_type,
                    created_at_ms=created_at_ms,
                    subscriber_id=subscriber_id,
                    grant_id=grant_id,
                    scopes=scopes,
                    fields=fields,
                    purpose=purpose,
                    metadata=metadata,
                )

    async def list_receipts(self, user_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        await self.ensure_table()
        limit = max(1, min(int(limit), 1000))
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT seq, event_type, subscriber_id, grant_id, scopes, fields,
                       purpose, prev_hash, hash, signature, metadata, created_at_ms
                FROM fabric_receipts
                WHERE user_id = $1
                ORDER BY seq ASC
                LIMIT $2
                """,
                user_id,
                limit,
            )
        return [self._row_to_receipt(row) for row in rows]

    @staticmethod
    def _row_to_receipt(row: Any) -> dict[str, Any]:
        def _as_list(value: Any) -> list[str]:
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except (ValueError, TypeError):
                    return []
                return list(parsed) if isinstance(parsed, list) else []
            return list(value) if isinstance(value, (list, tuple)) else []

        def _as_obj(value: Any) -> dict[str, Any]:
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except (ValueError, TypeError):
                    return {}
                return parsed if isinstance(parsed, dict) else {}
            return dict(value) if isinstance(value, dict) else {}

        return {
            "seq": int(row["seq"]),
            "event_type": row["event_type"],
            "subscriber_id": row["subscriber_id"],
            "grant_id": row["grant_id"],
            "scopes": _as_list(row["scopes"]),
            "fields": _as_list(row["fields"]),
            "purpose": row["purpose"],
            "prev_hash": row["prev_hash"],
            "hash": row["hash"],
            "signature": row["signature"],
            "metadata": _as_obj(row["metadata"]),
            "created_at_ms": int(row["created_at_ms"]),
        }

    async def verify_chain(self, user_id: str) -> dict[str, Any]:
        """Recompute the chain and signatures; report the first break, if any."""
        receipts = await self.list_receipts(user_id, limit=1000)
        prev_hash = GENESIS_HASH
        for receipt in receipts:
            payload = _canonical_payload(
                user_id=user_id,
                seq=receipt["seq"],
                event_type=receipt["event_type"],
                subscriber_id=receipt["subscriber_id"],
                grant_id=receipt["grant_id"],
                scopes=receipt["scopes"],
                fields=receipt["fields"],
                purpose=receipt["purpose"],
                created_at_ms=receipt["created_at_ms"],
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
        return {"ok": True, "count": len(receipts), "head_hash": prev_hash}


_fabric_receipts_service: FabricReceiptsService | None = None


def get_fabric_receipts_service() -> FabricReceiptsService:
    global _fabric_receipts_service
    if _fabric_receipts_service is None:
        _fabric_receipts_service = FabricReceiptsService()
    return _fabric_receipts_service
