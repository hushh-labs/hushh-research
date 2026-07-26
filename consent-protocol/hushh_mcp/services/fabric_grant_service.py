"""Preference Subscription Fabric grants (PCHP RFC-002).

A grant binds ``{ subscriber, scopes[], purpose, ttl, price? }`` to the owner's
uid and yields a signed, expiring, revocable **grant handle** plus a
hash-chained GRANT receipt. The subscriber later presents the handle to the read
API to receive the granted PWM fields at their current values -- each read
writing a READ receipt. Revocation writes a REVOKE receipt and is fail-closed:
any read after revocation is denied.

Reuse:
- The grant **handle** is signed with the same HMAC-SHA256 primitive and
  ``APP_SIGNING_KEY`` the consent tokens use, under an ``HFG`` (Hushh Fabric
  Grant) prefix. It carries the owner uid, subscriber, issue/expiry, and the
  priced (``commercial``) flag, all covered by the signature. Only its
  fingerprint is persisted; the plaintext handle is returned once, at creation.
  Revocation is enforced fail-closed by the grant-row status, so a revoked
  handle stops working immediately even though it remains cryptographically
  well-formed.
- Receipts use the hash-chained ledger (``fabric_receipts_service``).
- Field resolution uses the server-side scope registry (fail-closed).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Any

from db.connection import get_pool
from hushh_mcp.config import APP_SIGNING_KEY
from hushh_mcp.services.fabric_receipts_service import get_fabric_receipts_service
from hushh_mcp.services.fabric_scope_registry import resolve_fields

logger = logging.getLogger(__name__)

FABRIC_GRANT_PREFIX = "HFG"  # noqa: S105 - Hushh Fabric Grant handle prefix, not a secret
_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000  # one year ceiling
_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000  # 30 days


class FabricGrantError(Exception):
    """Base error carrying a stable code + HTTP-ish status for the route layer."""

    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _fingerprint(handle: str) -> str:
    return hashlib.sha256(handle.encode()).hexdigest()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sign_handle_body(raw: str) -> str:
    return hmac.new(APP_SIGNING_KEY.encode(), raw.encode(), hashlib.sha256).hexdigest()


def mint_handle(
    *,
    grant_id: str,
    user_id: str,
    subscriber_id: str,
    issued_ms: int,
    expires_ms: int,
    commercial: bool,
) -> str:
    """Mint a signed, opaque grant handle: ``HFG:<b64url(payload)>.<hmac>``."""
    payload = {
        "gid": grant_id,
        "uid": user_id,
        "sub": subscriber_id,
        "iat": issued_ms,
        "exp": expires_ms,
        "c": bool(commercial),
    }
    raw = (
        base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"{FABRIC_GRANT_PREFIX}:{raw}.{_sign_handle_body(raw)}"


def verify_handle(handle: str) -> dict[str, Any] | None:
    """Verify a handle's signature and decode its payload, or None if invalid."""
    try:
        prefix, rest = handle.split(":", 1)
        raw, signature = rest.rsplit(".", 1)
    except ValueError:
        return None
    if prefix != FABRIC_GRANT_PREFIX:
        return None
    if not hmac.compare_digest(signature, _sign_handle_body(raw)):
        return None
    try:
        padded = raw + "=" * (-len(raw) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode())
    except (ValueError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


class FabricGrantService:
    def __init__(self) -> None:
        self._table_ready = False
        self._receipts = get_fabric_receipts_service()

    async def ensure_table(self) -> None:
        """Idempotent safety-net; migration 119 is authoritative."""
        if self._table_ready:
            return
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS fabric_subscription_grants (
                    grant_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    subscriber_id TEXT NOT NULL,
                    subscriber_label TEXT,
                    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                    fields JSONB NOT NULL DEFAULT '[]'::jsonb,
                    purpose TEXT NOT NULL,
                    price_cents BIGINT,
                    currency TEXT,
                    token_fingerprint TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    expires_at TIMESTAMPTZ,
                    revoked_at TIMESTAMPTZ
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fabric_grants_user_created "
                "ON fabric_subscription_grants (user_id, created_at DESC)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fabric_grants_subscriber "
                "ON fabric_subscription_grants (subscriber_id)"
            )
        await self._receipts.ensure_table()
        self._table_ready = True

    async def create_grant(
        self,
        *,
        user_id: str,
        subscriber_id: str,
        scopes: list[str],
        purpose: str,
        subscriber_label: str | None = None,
        ttl_ms: int | None = None,
        price_cents: int | None = None,
        currency: str | None = None,
    ) -> dict[str, Any]:
        await self.ensure_table()
        subscriber_id = subscriber_id.strip()
        purpose = purpose.strip()
        scopes = [s.strip() for s in scopes if s and s.strip()]
        if not subscriber_id:
            raise FabricGrantError("FABRIC_SUBSCRIBER_REQUIRED", "A subscriber is required.", 422)
        if not scopes:
            raise FabricGrantError("FABRIC_SCOPES_REQUIRED", "At least one scope is required.", 422)
        if not purpose:
            raise FabricGrantError("FABRIC_PURPOSE_REQUIRED", "A purpose is required.", 422)
        if price_cents is not None and (price_cents < 0 or currency is None):
            raise FabricGrantError(
                "FABRIC_PRICE_INVALID",
                "A priced grant needs a non-negative price_cents and a currency.",
                422,
            )

        ttl_ms = _DEFAULT_TTL_MS if ttl_ms is None else max(1, min(int(ttl_ms), _MAX_TTL_MS))
        fields, _unmapped = resolve_fields(scopes)

        grant_id = uuid.uuid4().hex
        now_ms = _now_ms()
        expires_ms = now_ms + ttl_ms
        # Signed with the same HMAC primitive/key as consent tokens. `commercial`
        # records that this is a priced subscription.
        handle = mint_handle(
            grant_id=grant_id,
            user_id=user_id,
            subscriber_id=subscriber_id,
            issued_ms=now_ms,
            expires_ms=expires_ms,
            commercial=price_cents is not None,
        )

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", f"fabric_receipts:{user_id}"
                )
                await conn.execute(
                    """
                    INSERT INTO fabric_subscription_grants (
                        grant_id, user_id, subscriber_id, subscriber_label,
                        scopes, fields, purpose, price_cents, currency,
                        token_fingerprint, status, created_at, expires_at
                    )
                    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,'active',
                            to_timestamp($11/1000.0), to_timestamp($12/1000.0))
                    """,
                    grant_id,
                    user_id,
                    subscriber_id,
                    subscriber_label,
                    _json(scopes),
                    _json(fields),
                    purpose,
                    price_cents,
                    currency,
                    _fingerprint(handle),
                    now_ms,
                    expires_ms,
                )
                receipt = await self._receipts.append_in_conn(
                    conn,
                    user_id=user_id,
                    event_type="GRANT",
                    created_at_ms=now_ms,
                    subscriber_id=subscriber_id,
                    grant_id=grant_id,
                    scopes=scopes,
                    fields=fields,
                    purpose=purpose,
                    metadata={"price_cents": price_cents, "currency": currency, "ttl_ms": ttl_ms},
                )

        return {
            "grant_id": grant_id,
            "handle": handle,  # returned once, at creation
            "subscriber_id": subscriber_id,
            "scopes": scopes,
            "fields": fields,
            "purpose": purpose,
            "price_cents": price_cents,
            "currency": currency,
            "expires_at_ms": expires_ms,
            "receipt": receipt,
        }

    async def list_grants(self, user_id: str) -> list[dict[str, Any]]:
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT grant_id, subscriber_id, subscriber_label, scopes, fields,
                       purpose, price_cents, currency, status,
                       (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS created_at_ms,
                       (EXTRACT(EPOCH FROM expires_at) * 1000)::BIGINT AS expires_at_ms,
                       (EXTRACT(EPOCH FROM revoked_at) * 1000)::BIGINT AS revoked_at_ms
                FROM fabric_subscription_grants
                WHERE user_id = $1
                ORDER BY created_at DESC
                """,
                user_id,
            )
        return [_row_to_grant(row) for row in rows]

    async def revoke_grant(self, *, user_id: str, grant_id: str) -> dict[str, Any]:
        await self.ensure_table()
        now_ms = _now_ms()
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))", f"fabric_receipts:{user_id}"
                )
                row = await conn.fetchrow(
                    """
                    SELECT subscriber_id, scopes, fields, purpose, status
                    FROM fabric_subscription_grants
                    WHERE grant_id = $1 AND user_id = $2
                    FOR UPDATE
                    """,
                    grant_id,
                    user_id,
                )
                if row is None:
                    raise FabricGrantError("FABRIC_GRANT_NOT_FOUND", "Grant not found.", 404)
                if row["status"] != "active":
                    # Idempotent: already revoked.
                    return {"grant_id": grant_id, "status": "revoked", "already": True}
                await conn.execute(
                    """
                    UPDATE fabric_subscription_grants
                    SET status = 'revoked', revoked_at = to_timestamp($3/1000.0)
                    WHERE grant_id = $1 AND user_id = $2
                    """,
                    grant_id,
                    user_id,
                    now_ms,
                )
                receipt = await self._receipts.append_in_conn(
                    conn,
                    user_id=user_id,
                    event_type="REVOKE",
                    created_at_ms=now_ms,
                    subscriber_id=row["subscriber_id"],
                    grant_id=grant_id,
                    scopes=_as_list(row["scopes"]),
                    fields=_as_list(row["fields"]),
                    purpose=row["purpose"],
                )
        return {"grant_id": grant_id, "status": "revoked", "already": False, "receipt": receipt}

    async def read_for_subscriber(
        self, *, handle: str, subscriber_id: str, pwm_doc_loader: Any
    ) -> dict[str, Any]:
        """Resolve a subscriber's read against a grant handle.

        Fail-closed at every step: the handle signature must verify and be
        unexpired; its subscriber must equal the authenticated subscriber; a
        matching, active grant row must exist. Returns only the granted fields
        present in the current PWM document and writes a READ receipt.

        ``pwm_doc_loader`` is an async callable ``uid -> dict | None`` (the PWM
        service), injected to keep this service free of a hard import cycle.
        """
        await self.ensure_table()
        payload = verify_handle(handle)
        if payload is None:
            raise FabricGrantError("FABRIC_HANDLE_INVALID", "Invalid grant handle.", 403)
        if int(payload.get("exp", 0)) <= _now_ms():
            raise FabricGrantError("FABRIC_HANDLE_EXPIRED", "This grant handle has expired.", 403)
        if payload.get("sub") != subscriber_id:
            raise FabricGrantError(
                "FABRIC_SUBSCRIBER_MISMATCH",
                "This grant handle was not issued to the calling subscriber.",
                403,
            )
        user_id = str(payload.get("uid") or "")
        fingerprint = _fingerprint(handle)

        pool = await get_pool()
        async with pool.acquire() as conn:
            grant = await conn.fetchrow(
                """
                SELECT grant_id, scopes, fields, purpose, status
                FROM fabric_subscription_grants
                WHERE token_fingerprint = $1 AND user_id = $2 AND subscriber_id = $3
                """,
                fingerprint,
                user_id,
                subscriber_id,
            )
        if grant is None:
            raise FabricGrantError("FABRIC_GRANT_NOT_FOUND", "No grant for this handle.", 404)
        if grant["status"] != "active":
            raise FabricGrantError("FABRIC_GRANT_REVOKED", "This grant has been revoked.", 403)

        fields = _as_list(grant["fields"])
        doc = await pwm_doc_loader(user_id) or {}
        from hushh_mcp.services.fabric_scope_registry import project_fields

        projected = project_fields(doc, fields)

        now_ms = _now_ms()
        receipt = await self._receipts.append(
            user_id=user_id,
            event_type="READ",
            created_at_ms=now_ms,
            subscriber_id=subscriber_id,
            grant_id=grant["grant_id"],
            scopes=_as_list(grant["scopes"]),
            fields=list(projected.keys()),
            purpose=grant["purpose"],
        )
        return {
            "user_id": user_id,
            "subscriber_id": subscriber_id,
            "grant_id": grant["grant_id"],
            "scopes": _as_list(grant["scopes"]),
            "fields": projected,
            "receipt": receipt,
        }


def _json(value: Any) -> str:
    import json

    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _as_list(value: Any) -> list[str]:
    import json

    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return []
        return list(parsed) if isinstance(parsed, list) else []
    return list(value) if isinstance(value, (list, tuple)) else []


def _row_to_grant(row: Any) -> dict[str, Any]:
    return {
        "grant_id": row["grant_id"],
        "subscriber_id": row["subscriber_id"],
        "subscriber_label": row["subscriber_label"],
        "scopes": _as_list(row["scopes"]),
        "fields": _as_list(row["fields"]),
        "purpose": row["purpose"],
        "price_cents": row["price_cents"],
        "currency": row["currency"],
        "status": row["status"],
        "created_at_ms": int(row["created_at_ms"]) if row["created_at_ms"] is not None else None,
        "expires_at_ms": int(row["expires_at_ms"]) if row["expires_at_ms"] is not None else None,
        "revoked_at_ms": int(row["revoked_at_ms"]) if row["revoked_at_ms"] is not None else None,
    }


_fabric_grant_service: FabricGrantService | None = None


def get_fabric_grant_service() -> FabricGrantService:
    global _fabric_grant_service
    if _fabric_grant_service is None:
        _fabric_grant_service = FabricGrantService()
    return _fabric_grant_service
