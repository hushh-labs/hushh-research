"""Durable persistence for Information Marketplace access requests.

A buyer's request to access a published data slice is a real record in
`marketplace_access_requests` (migration 076), not browser-only state. The owner
has a real inbox; approve/deny is server-side and can be driven from the direct
marketplace chat OR through Agent One over A2A (the same way Location approves a
grant). Consent-first: a request never grants access on its own — the owner must
approve, and only the safe-summary projection of the slice is ever involved.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

from db.db_client import get_db

logger = logging.getLogger(__name__)

_STATUSES = {"pending", "approved", "denied", "expired"}
_DEFAULT_KEY_ALGORITHM = "ECDH-P256-AES256-GCM"


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
        self._supabase = None

    @property
    def supabase(self):
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    async def _execute_query(self, query):
        return await asyncio.to_thread(query.execute)

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
        }
        result = await self._execute_query(
            self.supabase.table("marketplace_access_requests").insert(payload)
        )
        rows = getattr(result, "data", None) or []
        return _row_to_request(rows[0]) if rows else _row_to_request(payload)

    async def list_requests(
        self, *, owner_user_id: str, status: str | None = None
    ) -> list[dict[str, Any]]:
        """List the owner's requests (optionally filtered by status), newest first."""
        query = (
            self.supabase.table("marketplace_access_requests")
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
            self.supabase.table("marketplace_access_requests")
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
        envelope: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Approve a pending request and, when an encrypted envelope is provided,
        deliver it: the seller has sealed the slice against the buyer's recipient
        key on-device, so we persist the ciphertext and point the request at it.
        Without an envelope this is a plain status flip (legacy / no-delivery path).

        The envelope is validated *before* the status flip so a malformed payload
        cannot leave a request approved-but-undelivered."""
        if envelope is not None:
            self._validate_envelope(envelope)
        resolved = await self._resolve(
            owner_user_id=owner_user_id, request_id=request_id, next_status="approved"
        )
        if not resolved.get("ok") or envelope is None:
            return resolved
        request = resolved["request"]
        buyer_user_id = request.get("buyerUserId")
        if not buyer_user_id:
            # Approved, but there is no buyer account to seal a delivery for
            # (e.g. a labeled brand/agent request). Nothing to store.
            return resolved
        resolved["envelope"] = await self._store_delivery_envelope(
            request=request,
            owner_user_id=owner_user_id,
            buyer_user_id=str(buyer_user_id),
            envelope=envelope,
        )
        return resolved

    async def deliver_envelope(
        self,
        *,
        owner_user_id: str,
        request_id: str,
        envelope: dict[str, Any],
    ) -> dict[str, Any]:
        """Deliver a sealed slice for an ALREADY-approved request.

        This is the fulfilment half of an agent-driven approval. When Agent One
        (A2A) or the marketplace chat agent approves, it can only flip the request
        to ``approved`` — it has no device to run the ECDH/AES-GCM sealing. The
        seller's browser later runs a delivery sweep, seals the slice on-device,
        and posts the ciphertext here. Unlike :meth:`approve_request` this does
        NOT touch status: the request is already approved, so we only attach the
        envelope. Owner-scoped and gated on ``status == "approved"`` so it can
        never resurrect a denied/expired request or run cross-user.
        """
        self._validate_envelope(envelope)
        result = await self._execute_query(
            self.supabase.table("marketplace_access_requests")
            .select("*")
            .eq("id", request_id)
            .eq("owner_user_id", owner_user_id)
            .limit(1)
        )
        rows = getattr(result, "data", None) or []
        if not rows:
            return {"ok": False, "reason": "not_found", "requestId": request_id}
        request = _row_to_request(rows[0])
        if request.get("status") != "approved":
            return {"ok": False, "reason": "not_approved", "requestId": request_id}
        buyer_user_id = request.get("buyerUserId")
        if not buyer_user_id:
            return {"ok": False, "reason": "no_buyer", "requestId": request_id}
        stored = await self._store_delivery_envelope(
            request=request,
            owner_user_id=owner_user_id,
            buyer_user_id=str(buyer_user_id),
            envelope=envelope,
        )
        return {"ok": True, "request": request, "envelope": stored}

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
        if not isinstance(sender, dict) or not sender.get("kty"):
            raise ValueError("Envelope sender public key is invalid.")

    async def _store_delivery_envelope(
        self,
        *,
        request: dict[str, Any],
        owner_user_id: str,
        buyer_user_id: str,
        envelope: dict[str, Any],
    ) -> dict[str, Any]:
        """Persist a sealed slice envelope for an approved request and point the
        request at it (mirrors one_location_share_grants.latest_envelope_id)."""
        recipient_key_id = str(envelope.get("recipientKeyId") or "").strip()
        if not recipient_key_id:
            active = await self.get_recipient_key(user_id=buyer_user_id)
            recipient_key_id = str((active or {}).get("keyId") or "").strip()
        if not recipient_key_id:
            raise ValueError("A recipient key id is required to deliver this slice.")
        payload = {
            "request_id": request["id"],
            "owner_user_id": owner_user_id,
            "buyer_user_id": buyer_user_id,
            "recipient_key_id": recipient_key_id,
            "algorithm": envelope.get("algorithm") or _DEFAULT_KEY_ALGORITHM,
            "ciphertext": envelope.get("ciphertext"),
            "iv": envelope.get("iv"),
            "sender_ephemeral_public_key_jwk": envelope.get("senderEphemeralPublicKeyJwk"),
            "metadata": envelope.get("metadata") or {},
        }
        result = await self._execute_query(
            self.supabase.table("marketplace_delivery_envelopes").insert(payload)
        )
        rows = getattr(result, "data", None) or []
        stored = _envelope_row(rows[0]) if rows else _envelope_row(payload)
        envelope_id = stored.get("id")
        if envelope_id:
            await self._execute_query(
                self.supabase.table("marketplace_access_requests")
                .update({"latest_envelope_id": envelope_id})
                .eq("id", request["id"])
                .eq("owner_user_id", owner_user_id)
            )
        return stored

    async def list_buyer_requests(
        self, *, buyer_user_id: str, status: str | None = None
    ) -> list[dict[str, Any]]:
        """List the buyer's own outgoing requests (their "Received data" tab),
        newest first. Buyer-scoped mirror of list_requests."""
        query = (
            self.supabase.table("marketplace_access_requests")
            .select("*")
            .eq("buyer_user_id", buyer_user_id)
        )
        if status in _STATUSES:
            query = query.eq("status", status)
        query = query.order("created_at", desc=True)
        result = await self._execute_query(query)
        return [_row_to_request(r) for r in (getattr(result, "data", None) or [])]

    async def get_delivered_envelope(
        self, *, buyer_user_id: str, request_id: str
    ) -> dict[str, Any] | None:
        """Buyer-scoped fetch of the latest sealed envelope for one of their
        requests. Returns None if the request is not theirs; returns the request
        with envelope=None if nothing has been delivered yet."""
        req_result = await self._execute_query(
            self.supabase.table("marketplace_access_requests")
            .select("*")
            .eq("id", request_id)
            .eq("buyer_user_id", buyer_user_id)
            .limit(1)
        )
        req_rows = getattr(req_result, "data", None) or []
        if not req_rows:
            return None
        request = _row_to_request(req_rows[0])
        env_result = await self._execute_query(
            self.supabase.table("marketplace_delivery_envelopes")
            .select("*")
            .eq("request_id", request_id)
            .eq("buyer_user_id", buyer_user_id)
            .order("created_at", desc=True)
            .limit(1)
        )
        env_rows = getattr(env_result, "data", None) or []
        envelope = _envelope_row(env_rows[0]) if env_rows else None
        return {"request": request, "envelope": envelope}

    async def get_request_recipient_key(
        self, *, owner_user_id: str, request_id: str
    ) -> dict[str, Any] | None:
        """Owner-scoped: resolve the buyer of one of the owner's requests and
        return that buyer's active recipient key, so the seller can seal a slice
        for them at approve time. Returns None if the request is not the owner's;
        recipientKey is None if the buyer has not published a key yet."""
        result = await self._execute_query(
            self.supabase.table("marketplace_access_requests")
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

    async def register_recipient_key(
        self,
        *,
        user_id: str,
        public_key_jwk: dict[str, Any],
        key_id: str | None = None,
        algorithm: str = _DEFAULT_KEY_ALGORITHM,
    ) -> dict[str, Any]:
        """Publish a buyer's ECDH P-256 recipient public key so a seller can seal
        a slice envelope for them at approve time. Only the public JWK is stored;
        the private half never leaves the buyer's device. Idempotent: upserts on
        (user_id, key_id) and rotates any other active key for the user."""
        if not user_id:
            raise ValueError("A user is required to register a recipient key.")
        if not isinstance(public_key_jwk, dict) or not public_key_jwk.get("kty"):
            raise ValueError("Recipient public key material is required.")
        normalized_key_id = (key_id or _fingerprint_public_key(public_key_jwk)).strip()
        if len(normalized_key_id) < 8:
            raise ValueError("Recipient key id is too short.")
        fingerprint = _fingerprint_public_key(public_key_jwk)

        # Retire any other active key so a device rotation leaves exactly one.
        await self._execute_query(
            self.supabase.table("marketplace_recipient_keys")
            .update({"status": "rotated", "updated_at": _now_iso()})
            .eq("user_id", user_id)
            .eq("status", "active")
            .neq("key_id", normalized_key_id)
        )

        payload = {
            "user_id": user_id,
            "key_id": normalized_key_id,
            "public_key_jwk": public_key_jwk,
            "public_key_fingerprint": fingerprint,
            "algorithm": algorithm or _DEFAULT_KEY_ALGORITHM,
            "status": "active",
            "revoked_at": None,
            "updated_at": _now_iso(),
        }
        result = await self._execute_query(
            self.supabase.table("marketplace_recipient_keys").upsert(
                payload, on_conflict="user_id,key_id"
            )
        )
        rows = getattr(result, "data", None) or []
        return _recipient_key_row(rows[0]) if rows else _recipient_key_row(payload)

    async def get_recipient_key(self, *, user_id: str) -> dict[str, Any] | None:
        """Fetch a buyer's current active recipient key (newest first), or None."""
        query = (
            self.supabase.table("marketplace_recipient_keys")
            .select("*")
            .eq("user_id", user_id)
            .eq("status", "active")
            .order("created_at", desc=True)
            .limit(1)
        )
        result = await self._execute_query(query)
        rows = getattr(result, "data", None) or []
        return _recipient_key_row(rows[0]) if rows else None
