"""Brand-initiated consent requests for the Permission Gateway (PCHP RFC-002).

The missing verb of the subscription fabric: a verified subscriber (brand or
professional) *requests* scoped access, and the person approves it into a
fabric grant from their own agent.

Modeled as a device-authorization-style pairing flow (the same shape as the
OAuth 2.0 Device Authorization Grant) so the brand never learns who the person
is before consent:

    1. subscriber: create_request(...)      -> request_id + short pairing code
    2. person:     lookup_by_code(code)     -> who is asking, for what, why,
                                               how long, at what price
    3. person:     approve(...)             -> binds the verified uid, mints
                                               the grant (+ GRANT receipt),
                                               parks the handle for ONE claim
       or          deny(...)
    4. subscriber: poll(...)                -> status; on approval returns the
                                               signed handle exactly once

Trust contract:
- the person's uid enters only at approve time, and only from the verified
  token; the subscriber never sees it through this flow
- the pairing code is high-entropy, single-use, and expires in minutes
- the signed handle is stored only between approval and its single claim,
  then cleared; every read after that flows through the receipted read API
- fail-closed everywhere: expired, denied, claimed, or mismatched requests
  return errors, never data
"""

from __future__ import annotations

import secrets
import time
import uuid
from typing import Any

from db.connection import get_pool
from hushh_mcp.services.fabric_grant_service import (
    FabricGrantError,
    get_fabric_grant_service,
)
from hushh_mcp.services.fabric_scope_registry import resolve_fields

# Unambiguous alphabet (no vowels -> no words; no 0/O/1/I/L lookalikes).
_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789"
_CODE_LENGTH = 8
_REQUEST_TTL_MS = 15 * 60 * 1000  # a pairing request lives minutes, not days
_MAX_PENDING_PER_SUBSCRIBER = 100  # backstop against pairing-code farming


def _now_ms() -> int:
    return int(time.time() * 1000)


def _mint_pairing_code() -> str:
    raw = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))
    return f"{raw[:4]}-{raw[4:]}"


def _normalize_code(code: str) -> str:
    cleaned = "".join(ch for ch in code.upper() if ch.isalnum())
    return f"{cleaned[:4]}-{cleaned[4:]}" if len(cleaned) == _CODE_LENGTH else code.strip().upper()


class FabricRequestService:
    def __init__(self) -> None:
        self._table_ready = False

    async def ensure_table(self) -> None:
        """Idempotent safety-net; migration 120 is authoritative."""
        if self._table_ready:
            return
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS fabric_consent_requests (
                    request_id TEXT PRIMARY KEY,
                    pairing_code TEXT NOT NULL UNIQUE,
                    subscriber_id TEXT NOT NULL,
                    subscriber_label TEXT,
                    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                    purpose TEXT NOT NULL,
                    ttl_ms BIGINT,
                    price_cents BIGINT,
                    currency TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    user_id TEXT,
                    grant_id TEXT,
                    handle_once TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    expires_at TIMESTAMPTZ NOT NULL,
                    responded_at TIMESTAMPTZ,
                    claimed_at TIMESTAMPTZ
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fabric_requests_subscriber_created "
                "ON fabric_consent_requests (subscriber_id, created_at DESC)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fabric_requests_status_expires "
                "ON fabric_consent_requests (status, expires_at)"
            )
        self._table_ready = True

    async def create_request(
        self,
        *,
        subscriber_id: str,
        scopes: list[str],
        purpose: str,
        subscriber_label: str | None = None,
        ttl_ms: int | None = None,
        price_cents: int | None = None,
        currency: str | None = None,
    ) -> dict[str, Any]:
        """Subscriber side: open a pairing request and get the code to show."""
        await self.ensure_table()
        scopes = [s.strip() for s in scopes if s and s.strip()]
        purpose = purpose.strip()
        if not scopes:
            raise FabricGrantError("FABRIC_SCOPES_REQUIRED", "At least one scope is required.", 422)
        if not purpose:
            raise FabricGrantError("FABRIC_PURPOSE_REQUIRED", "A purpose is required.", 422)
        if price_cents is not None and (price_cents < 0 or currency is None):
            raise FabricGrantError(
                "FABRIC_PRICE_INVALID",
                "A priced request needs a non-negative price_cents and a currency.",
                422,
            )

        now_ms = _now_ms()
        pool = await get_pool()
        async with pool.acquire() as conn:
            pending = await conn.fetchval(
                "SELECT COUNT(*) FROM fabric_consent_requests "
                "WHERE subscriber_id = $1 AND status = 'pending' AND expires_at > now()",
                subscriber_id,
            )
            if int(pending or 0) >= _MAX_PENDING_PER_SUBSCRIBER:
                raise FabricGrantError(
                    "FABRIC_REQUESTS_RATE_LIMITED",
                    "Too many pending requests for this subscriber.",
                    429,
                )
            request_id = uuid.uuid4().hex
            # Pairing codes are UNIQUE; retry the 1-in-3.8e11 collision.
            for _ in range(3):
                code = _mint_pairing_code()
                try:
                    await conn.execute(
                        """
                        INSERT INTO fabric_consent_requests (
                            request_id, pairing_code, subscriber_id, subscriber_label,
                            scopes, purpose, ttl_ms, price_cents, currency,
                            status, expires_at
                        )
                        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'pending',
                                to_timestamp($10/1000.0))
                        """,
                        request_id,
                        code,
                        subscriber_id,
                        subscriber_label,
                        _json(scopes),
                        purpose,
                        ttl_ms,
                        price_cents,
                        currency,
                        now_ms + _REQUEST_TTL_MS,
                    )
                    break
                except Exception as exc:  # unique_violation on pairing_code
                    if "unique" not in str(exc).lower():
                        raise
            else:
                raise FabricGrantError(
                    "FABRIC_CODE_MINT_FAILED", "Could not mint a pairing code.", 500
                )
        return {
            "request_id": request_id,
            "pairing_code": code,
            "expires_at_ms": now_ms + _REQUEST_TTL_MS,
            "poll_interval_ms": 2500,
        }

    async def lookup_by_code(self, code: str) -> dict[str, Any]:
        """Person side: what am I being asked to share? (no uid binding yet)."""
        await self.ensure_table()
        row = await self._fetch_by_code(code)
        self._require_pending(row)
        scopes = _as_list(row["scopes"])
        fields, unmapped = resolve_fields(scopes)
        return {
            "request_id": row["request_id"],
            "subscriber_id": row["subscriber_id"],
            "subscriber_label": row["subscriber_label"],
            "scopes": scopes,
            "fields": fields,
            "unmapped_scopes": unmapped,
            "purpose": row["purpose"],
            "ttl_ms": row["ttl_ms"],
            "price_cents": row["price_cents"],
            "currency": row["currency"],
            "expires_at_ms": _dt_ms(row["expires_at"]),
        }

    async def approve(self, *, user_id: str, request_id: str, pairing_code: str) -> dict[str, Any]:
        """Person side: approve -> mint the grant, park the handle for one claim.

        uid comes ONLY from the verified token of the caller; the pairing code
        must match the request so a request_id alone is never enough.
        """
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM fabric_consent_requests WHERE request_id = $1 FOR UPDATE",
                    request_id,
                )
                self._require_pending(row)
                if row["pairing_code"] != _normalize_code(pairing_code):
                    raise FabricGrantError(
                        "FABRIC_CODE_MISMATCH", "Pairing code does not match.", 403
                    )
                grant = await get_fabric_grant_service().create_grant(
                    user_id=user_id,
                    subscriber_id=row["subscriber_id"],
                    scopes=_as_list(row["scopes"]),
                    purpose=row["purpose"],
                    subscriber_label=row["subscriber_label"],
                    ttl_ms=int(row["ttl_ms"]) if row["ttl_ms"] is not None else None,
                    price_cents=int(row["price_cents"]) if row["price_cents"] is not None else None,
                    currency=row["currency"],
                )
                await conn.execute(
                    """
                    UPDATE fabric_consent_requests
                    SET status = 'approved', user_id = $2, grant_id = $3,
                        handle_once = $4, responded_at = now()
                    WHERE request_id = $1
                    """,
                    request_id,
                    user_id,
                    grant["grant_id"],
                    grant["handle"],
                )
        # The owner gets the grant summary + receipt — never the handle; the
        # handle belongs to the subscriber and is claimable exactly once.
        return {
            "request_id": request_id,
            "status": "approved",
            "grant_id": grant["grant_id"],
            "scopes": grant["scopes"],
            "fields": grant["fields"],
            "receipt": grant["receipt"],
        }

    async def deny(self, *, user_id: str, request_id: str, pairing_code: str) -> dict[str, Any]:
        """Person side: one-tap no. Fail-closed and terminal."""
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM fabric_consent_requests WHERE request_id = $1 FOR UPDATE",
                    request_id,
                )
                self._require_pending(row)
                if row["pairing_code"] != _normalize_code(pairing_code):
                    raise FabricGrantError(
                        "FABRIC_CODE_MISMATCH", "Pairing code does not match.", 403
                    )
                await conn.execute(
                    "UPDATE fabric_consent_requests "
                    "SET status = 'denied', user_id = $2, responded_at = now() "
                    "WHERE request_id = $1",
                    request_id,
                    user_id,
                )
        return {"request_id": request_id, "status": "denied"}

    async def poll(self, *, subscriber_id: str, request_id: str) -> dict[str, Any]:
        """Subscriber side: status; on approval the handle is returned ONCE."""
        await self.ensure_table()
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM fabric_consent_requests WHERE request_id = $1 FOR UPDATE",
                    request_id,
                )
                if row is None or row["subscriber_id"] != subscriber_id:
                    # Same error for absent and foreign requests: no oracle.
                    raise FabricGrantError("FABRIC_REQUEST_NOT_FOUND", "Request not found.", 404)
                status = self._effective_status(row)
                if status == "approved" and row["handle_once"]:
                    await conn.execute(
                        "UPDATE fabric_consent_requests "
                        "SET status = 'claimed', handle_once = NULL, claimed_at = now() "
                        "WHERE request_id = $1",
                        request_id,
                    )
                    return {
                        "request_id": request_id,
                        "status": "approved",
                        "handle": row["handle_once"],
                        "grant_id": row["grant_id"],
                    }
        return {"request_id": request_id, "status": status}

    # ------------------------------------------------------------------ utils

    async def _fetch_by_code(self, code: str) -> Any:
        pool = await get_pool()
        async with pool.acquire() as conn:
            return await conn.fetchrow(
                "SELECT * FROM fabric_consent_requests WHERE pairing_code = $1",
                _normalize_code(code),
            )

    @staticmethod
    def _effective_status(row: Any) -> str:
        status = str(row["status"])
        if status == "pending" and _dt_ms(row["expires_at"]) <= _now_ms():
            return "expired"
        return status

    @classmethod
    def _require_pending(cls, row: Any) -> None:
        if row is None:
            raise FabricGrantError("FABRIC_REQUEST_NOT_FOUND", "Request not found.", 404)
        status = cls._effective_status(row)
        if status != "pending":
            raise FabricGrantError(
                "FABRIC_REQUEST_NOT_PENDING",
                f"This request is {status}.",
                410 if status == "expired" else 409,
            )


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


def _dt_ms(value: Any) -> int:
    try:
        return int(value.timestamp() * 1000)
    except (AttributeError, TypeError, ValueError):
        return 0


_fabric_request_service: FabricRequestService | None = None


def get_fabric_request_service() -> FabricRequestService:
    global _fabric_request_service
    if _fabric_request_service is None:
        _fabric_request_service = FabricRequestService()
    return _fabric_request_service
