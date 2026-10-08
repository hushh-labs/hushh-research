"""Durable persistence for Information Marketplace access requests.

A buyer's request to access a published data slice is a real record in
`marketplace_access_requests` (migration 076), not browser-only state. The owner
has a real inbox; approve/deny is server-side and can be driven from the direct
marketplace chat OR through Agent One over A2A (the same way Location approves a
grant). Consent-first: a request never grants access on its own — the owner must
approve, and only owner-authorized ciphertext is relayed. Published discovery contains shape metadata.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from db.connection import get_pool
from db.db_client import get_db

logger = logging.getLogger(__name__)

_STATUSES = {"pending", "approved", "denied", "expired", "revoked"}
_DEFAULT_KEY_ALGORITHM = "ECDH-P256-AES256-GCM"


def _parse_metadata(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _request_unexpired(row: dict, now: datetime | None = None) -> bool:
    if row.get("status") != "approved":
        return False
    resolved = row.get("resolved_at")
    if isinstance(resolved, str):
        try:
            resolved = datetime.fromisoformat(resolved.replace("Z", "+00:00"))
        except ValueError:
            return False
    if not isinstance(resolved, datetime) or resolved.tzinfo is None:
        return False
    metadata = _parse_metadata(row.get("metadata"))
    seconds = (
        metadata.get("approved_duration_seconds") or int(row.get("duration_days") or 0) * 86400
    )
    return (
        isinstance(seconds, int)
        and seconds > 0
        and (now or datetime.now(UTC)) < resolved + timedelta(seconds=seconds)
    )


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _fingerprint_public_key(public_key_jwk: dict[str, Any]) -> str:
    """Stable SHA-256 over the canonicalized JWK (matches the client key id)."""
    encoded = json.dumps(public_key_jwk, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _recipient_key_row(row: dict) -> dict[str, Any]:
    """Shape a recipient-key DB row into the camelCase contract the client uses."""
    return {
        "userId": _str_or_none(row.get("user_id")),
        "keyId": row.get("key_id"),
        "publicKeyJwk": row.get("public_key_jwk"),
        "algorithm": row.get("algorithm") or _DEFAULT_KEY_ALGORITHM,
        "createdAt": _str_or_none(row.get("created_at")),
    }


def _str_or_none(value: Any) -> str | None:
    """Coerce UUID/datetime/etc. to a JSON-safe string. The DB returns UUID and
    datetime objects that json.dumps (used when feeding tool results back to the
    model) cannot serialize; the REST layer is fine, but the chat path is not."""
    return None if value is None else str(value)


def _row_to_request(row: dict) -> dict[str, Any]:
    """Shape a DB row into the JSON-safe camelCase contract the agent/frontend consume."""
    return {
        "id": _str_or_none(row.get("id")),
        "ownerUserId": _str_or_none(row.get("owner_user_id")),
        "buyerUserId": _str_or_none(row.get("buyer_user_id")),
        "buyerLabel": row.get("buyer_label"),
        "domain": row.get("domain"),
        "scopeHandle": row.get("scope_handle"),
        "sliceName": row.get("slice_label"),
        "priceCents": row.get("price_cents"),
        "currency": row.get("currency"),
        "durationDays": row.get("duration_days"),
        "message": row.get("message"),
        "status": row.get("status"),
        "createdAt": _str_or_none(row.get("created_at")),
        "resolvedAt": _str_or_none(row.get("resolved_at")),
        "latestEnvelopeId": _str_or_none(row.get("latest_envelope_id")),
        "metadata": _parse_metadata(row.get("metadata")),
    }


def _envelope_row(row: dict) -> dict[str, Any]:
    """Shape a delivery-envelope DB row into the JSON-safe camelCase contract the
    buyer's device consumes to decrypt the slice. Ciphertext only — no plaintext
    slice value is ever stored or returned (the server is a blind relay)."""
    return {
        "id": _str_or_none(row.get("id")),
        "requestId": _str_or_none(row.get("request_id")),
        "ownerUserId": _str_or_none(row.get("owner_user_id")),
        "buyerUserId": _str_or_none(row.get("buyer_user_id")),
        "recipientKeyId": row.get("recipient_key_id"),
        "algorithm": row.get("algorithm") or _DEFAULT_KEY_ALGORITHM,
        "ciphertext": row.get("ciphertext"),
        "iv": row.get("iv"),
        "senderEphemeralPublicKeyJwk": row.get("sender_ephemeral_public_key_jwk"),
        "createdAt": _str_or_none(row.get("created_at")),
        "metadata": row.get("metadata") or {},
    }


class MarketplaceRequestService:
    """CRUD for durable marketplace access requests (owner-scoped)."""

    def __init__(self) -> None:
        self._db = None
        self._pool = None

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _execute_query(self, query):
        return await asyncio.to_thread(query.execute)

    @asynccontextmanager
    async def _transaction(self):
        from hushh_mcp.services.scope_commerce.service import COMMERCE_GATE

        pool = self._pool or await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            # Lock order matches the paid stage/approval boundary.
            await conn.execute("SELECT pg_advisory_xact_lock($1)", COMMERCE_GATE)
            yield conn

    @staticmethod
    async def _lock_request(conn, request_id, *, owner_user_id=None, buyer_user_id=None):
        from hushh_mcp.services.marketplace_consent_ports import lock_request

        return await lock_request(
            conn, request_id, owner_user_id=owner_user_id, buyer_user_id=buyer_user_id
        )

    @staticmethod
    async def _exact_scope(conn, row):
        from hushh_mcp.services.marketplace_consent_ports import exact_scope

        return await exact_scope(conn, row)

    @staticmethod
    async def _tariff(conn, row, handle, machine_scope):
        from hushh_mcp.services.marketplace_consent_ports import tariff

        return await tariff(conn, row, handle, machine_scope)

    @staticmethod
    async def _active_recipient(conn, buyer_user_id):
        from hushh_mcp.services.marketplace_consent_ports import active_recipient

        return await active_recipient(conn, buyer_user_id)

    async def _store_locked_envelope(self, conn, row, envelope):
        from hushh_mcp.services.marketplace_consent_ports import store_locked_envelope

        return await store_locked_envelope(self, conn, row, envelope)

    async def create_request(
        self,
        *,
        owner_user_id: str,
        slice_label: str,
        domain: str,
        scope_handle: str | None = None,
        buyer_user_id: str | None = None,
        buyer_label: str | None = None,
        price_cents: int = 0,
        currency: str = "USD",
        duration_days: int = 30,
        message: str | None = None,
        metadata: dict | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """File a new pending access request for a published slice."""
        payload = {
            "owner_user_id": owner_user_id,
            "buyer_user_id": buyer_user_id,
            "buyer_label": buyer_label,
            "domain": domain,
            "scope_handle": scope_handle,
            "slice_label": slice_label,
            "price_cents": int(price_cents or 0),
            "currency": currency or "USD",
            "duration_days": int(duration_days or 30),
            "message": message,
            "status": "pending",
            "metadata": metadata or {},
        }
        from hushh_mcp.services.marketplace_consent_ports import create_request

        return await create_request(self, payload, request_id, buyer_user_id, metadata)

    async def list_requests(
        self, *, owner_user_id: str, status: str | None = None
    ) -> list[dict[str, Any]]:
        """List the owner's requests (optionally filtered by status), newest first."""
        query = (
            self.db.table("marketplace_access_requests")
            .select("*")
            .eq("owner_user_id", owner_user_id)
        )
        if status in _STATUSES:
            query = query.eq("status", status)
        query = query.order("created_at", desc=True)
        result = await self._execute_query(query)
        return [_row_to_request(r) for r in (getattr(result, "data", None) or [])]

    async def _resolve(
        self, *, owner_user_id: str, request_id: str, next_status: str
    ) -> dict[str, Any]:
        """Owner-scoped status transition; only a pending request the owner owns
        can be resolved (prevents cross-user or double resolution)."""
        if next_status not in ("approved", "denied"):
            raise ValueError("next_status must be 'approved' or 'denied'")
        update = {"status": next_status, "resolved_at": _now_iso()}
        result = await self._execute_query(
            self.db.table("marketplace_access_requests")
            .update(update)
            .eq("id", request_id)
            .eq("owner_user_id", owner_user_id)
            .eq("status", "pending")
        )
        rows = getattr(result, "data", None) or []
        if not rows:
            return {"ok": False, "reason": "not_found_or_not_pending", "requestId": request_id}
        return {"ok": True, "request": _row_to_request(rows[0])}

    async def approve_request(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        envelope: dict | None = None,
        duration_seconds: int | None = None,
    ) -> dict:
        if envelope is not None:
            self._validate_envelope(envelope)
        async with self._transaction() as conn:
            row = await self._lock_request(conn, request_id, owner_user_id=owner_user_id)
            if not row or row["status"] != "pending":
                return {"ok": False, "reason": "not_found_or_not_pending", "requestId": request_id}
            scope, handle = await self._exact_scope(conn, row)
            requested = int(
                _parse_metadata(row.get("metadata")).get("duration_seconds")
                or row["duration_days"] * 86400
            )
            approved = duration_seconds if duration_seconds is not None else requested
            if (
                isinstance(approved, bool)
                or not isinstance(approved, int)
                or not 0 < approved <= requested
            ):
                raise ValueError("Approved duration must be within the requested duration.")
            tariff = await self._tariff(conn, row, handle, scope)
            if (tariff and tariff["price_cents"] > 0) or _parse_metadata(row.get("metadata")).get(
                "commercial_required"
            ):
                from hushh_mcp.consent.paid_admission import approve_paid_request

                paid = await approve_paid_request(
                    owner_user_id,
                    request_id,
                    approved,
                    "owner-approve:" + request_id,
                    connection=conn,
                )
                if paid is None:
                    raise ValueError("Paid authorization is unavailable.")
                return {"ok": True, **paid}
            metadata = {
                **_parse_metadata(row.get("metadata")),
                "machine_scope": scope,
                "approved_duration_seconds": approved,
            }
            row = dict(
                await conn.fetchrow(
                    "UPDATE marketplace_access_requests SET status='approved',resolved_at=now(),metadata=$2::jsonb WHERE id=$1 RETURNING *",
                    row["id"],
                    json.dumps(metadata),
                )
            )
            result = {"ok": True, "request": _row_to_request(row)}
            if envelope is not None and row.get("buyer_user_id"):
                result["envelope"] = await self._store_locked_envelope(conn, row, envelope)
            return result

    async def deliver_envelope(
        self, *, owner_user_id: str, request_id: str, envelope: dict
    ) -> dict:
        self._validate_envelope(envelope)
        async with self._transaction() as conn:
            row = await self._lock_request(conn, request_id, owner_user_id=owner_user_id)
            if not row or not _request_unexpired(row):
                return {"ok": False, "reason": "not_approved", "requestId": request_id}
            scope, handle = await self._exact_scope(conn, row)
            tariff = await self._tariff(conn, row, handle, scope)
            if (tariff and tariff["price_cents"] > 0) or _parse_metadata(row.get("metadata")).get(
                "commercial_required"
            ):
                raise ValueError("Paid delivery requires the canonical encrypted export stage.")
            stored = await self._store_locked_envelope(conn, row, envelope)
            return {"ok": True, "request": _row_to_request(row), "envelope": stored}

    @staticmethod
    def _validate_envelope(envelope: dict[str, Any]) -> None:
        """Reject anything that is not a well-formed ciphertext envelope. Slice
        plaintext must never appear here — only sealed material."""
        if not isinstance(envelope, dict):
            raise ValueError("Encrypted envelope is required.")
        for field in ("ciphertext", "iv", "senderEphemeralPublicKeyJwk"):
            if not envelope.get(field):
                raise ValueError(f"Encrypted envelope is missing {field}.")
        sender = envelope.get("senderEphemeralPublicKeyJwk")
        if (
            not isinstance(sender, dict)
            or sender.get("kty") != "EC"
            or sender.get("crv") != "P-256"
            or "d" in sender
        ):
            raise ValueError("Envelope sender public key is invalid.")

    async def list_buyer_requests(
        self, *, buyer_user_id: str, status: str | None = None
    ) -> list[dict[str, Any]]:
        """List the buyer's own outgoing requests (their "Received data" tab),
        newest first. Buyer-scoped mirror of list_requests."""
        query = (
            self.db.table("marketplace_access_requests")
            .select("*")
            .eq("buyer_user_id", buyer_user_id)
        )
        if status in _STATUSES:
            query = query.eq("status", status)
        query = query.order("created_at", desc=True)
        result = await self._execute_query(query)
        return [_row_to_request(r) for r in (getattr(result, "data", None) or [])]

    async def get_delivered_envelope(self, *, buyer_user_id: str, request_id: str) -> dict | None:
        from hushh_mcp.services.marketplace_consent_ports import get_delivered_envelope

        return await get_delivered_envelope(
            self, buyer_user_id=buyer_user_id, request_id=request_id
        )

    async def get_request_recipient_key(
        self, *, owner_user_id: str, request_id: str
    ) -> dict[str, Any] | None:
        """Owner-scoped: resolve the buyer of one of the owner's requests and
        return that buyer's active recipient key, so the seller can seal a slice
        for them at approve time. Returns None if the request is not the owner's;
        recipientKey is None if the buyer has not published a key yet."""
        result = await self._execute_query(
            self.db.table("marketplace_access_requests")
            .select("*")
            .eq("id", request_id)
            .eq("owner_user_id", owner_user_id)
            .limit(1)
        )
        rows = getattr(result, "data", None) or []
        if not rows:
            return None
        request = _row_to_request(rows[0])
        buyer_user_id = request.get("buyerUserId")
        recipient_key = (
            await self.get_recipient_key(user_id=str(buyer_user_id)) if buyer_user_id else None
        )
        return {"request": request, "recipientKey": recipient_key}

    async def deny_request(self, *, owner_user_id: str, request_id: str) -> dict[str, Any]:
        return await self._resolve(
            owner_user_id=owner_user_id, request_id=request_id, next_status="denied"
        )

    async def revoke_request(self, *, owner_user_id: str, request_id: str) -> dict:
        async with self._transaction() as conn:
            row = await self._lock_request(conn, request_id, owner_user_id=owner_user_id)
            if not row or row["status"] != "approved":
                return {"ok": False, "reason": "not_found_or_not_approved", "requestId": request_id}
            metadata = _parse_metadata(row.get("metadata"))
            if metadata.get("commercial_required"):
                from hushh_mcp.services.scope_commerce.service import ScopeCommerceService

                await ScopeCommerceService().revoke_purchase(
                    owner_user_id=owner_user_id,
                    purchase_id=metadata["commerce_purchase_id"],
                    conn=conn,
                )
            row = dict(
                await conn.fetchrow(
                    "UPDATE marketplace_access_requests SET status='revoked',resolved_at=now(),latest_envelope_id=NULL WHERE id=$1 RETURNING *",
                    row["id"],
                )
            )
            await conn.execute(
                "DELETE FROM marketplace_delivery_envelopes WHERE request_id=$1", row["id"]
            )
            return {"ok": True, "request": _row_to_request(row)}

    async def register_recipient_key(
        self,
        *,
        user_id: str,
        public_key_jwk: dict,
        key_id: str | None = None,
        algorithm: str = _DEFAULT_KEY_ALGORITHM,
    ) -> dict:
        if (
            not user_id
            or not isinstance(public_key_jwk, dict)
            or public_key_jwk.get("kty") != "EC"
            or public_key_jwk.get("crv") != "P-256"
            or not public_key_jwk.get("x")
            or not public_key_jwk.get("y")
            or "d" in public_key_jwk
            or algorithm != _DEFAULT_KEY_ALGORITHM
        ):
            raise ValueError("A public P-256 recipient key is required.")
        normalized_key_id = (key_id or _fingerprint_public_key(public_key_jwk)).strip()
        if len(normalized_key_id) < 8:
            raise ValueError("Recipient key id is too short.")
        async with self._transaction() as conn:
            await self._active_recipient(conn, user_id)
            existing = await conn.fetchrow(
                "SELECT public_key_fingerprint FROM marketplace_recipient_keys WHERE user_id=$1 AND key_id=$2 FOR UPDATE",
                user_id,
                normalized_key_id,
            )
            fingerprint = _fingerprint_public_key(public_key_jwk)
            if existing and existing["public_key_fingerprint"] != fingerprint:
                raise ValueError("A key id cannot be rebound to different key material.")
            await conn.execute(
                "UPDATE marketplace_recipient_keys SET status='rotated',updated_at=now() WHERE user_id=$1 AND status='active' AND key_id<>$2",
                user_id,
                normalized_key_id,
            )
            row = await conn.fetchrow(
                """INSERT INTO marketplace_recipient_keys(user_id,key_id,public_key_jwk,public_key_fingerprint,algorithm,status)
                   VALUES($1,$2,$3::jsonb,$4,$5,'active') ON CONFLICT(user_id,key_id) DO UPDATE SET status='active',revoked_at=NULL,updated_at=now() RETURNING *""",
                user_id,
                normalized_key_id,
                json.dumps(public_key_jwk),
                fingerprint,
                algorithm,
            )
            return _recipient_key_row(dict(row))

    async def get_recipient_key(self, *, user_id: str) -> dict[str, Any] | None:
        """Fetch a buyer's current active recipient key (newest first), or None."""
        query = (
            self.db.table("marketplace_recipient_keys")
            .select("*")
            .eq("user_id", user_id)
            .eq("status", "active")
            .order("created_at", desc=True)
            .limit(1)
        )
        result = await self._execute_query(query)
        rows = getattr(result, "data", None) or []
        return _recipient_key_row(rows[0]) if rows else None
