"""Single-use tickets that open the One Live Voice WebSocket.

Browsers cannot attach ``Authorization`` to a WebSocket, so the client mints a
short-lived ticket over HTTPS with its vault-owner token and presents only that
opaque ticket in the socket URL. The ticket proves nothing beyond "may open":
the consent token and the Firebase proof arrive in the first frame after the
socket opens and are verified there.

Format (v1): ``v1.<b64url payload>.<b64url hmac-sha256>`` signed with the app
signing key. Payload: ``{uid, sid, cid, exp, nonce}``. Consumption registers
the nonce in ``relay_ticket_nonces`` (migration 084) with
``INSERT .. ON CONFLICT DO NOTHING`` so it is single-use across every
instance. Unlike the retired relay there is no fail-open branch: if the nonce
registry is unreachable the ticket is rejected. Voice is not emergency
infrastructure; Save My Soul still works through the tap UI.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.runtime_settings import get_core_security_settings

TICKET_VERSION = "v1"
TICKET_TTL_SECONDS = 60


class TicketError(ValueError):
    pass


@dataclass(frozen=True)
class TicketClaims:
    user_id: str
    session_id: str
    conversation_id: str
    expires_at: int
    nonce: str


def _secret() -> str:
    try:
        key = get_core_security_settings().app_signing_key
    except ValueError:
        key = ""
    if not key:
        raise TicketError("APP_SIGNING_KEY is required to mint voice tickets")
    return key


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def _sign(payload_segment: str, secret: str) -> str:
    return _b64url_encode(
        hmac.new(secret.encode("utf-8"), payload_segment.encode("ascii"), hashlib.sha256).digest()
    )


def _now() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def issue_ticket(*, user_id: str, session_id: str, conversation_id: str) -> tuple[str, int]:
    secret = _secret()
    expires_at = _now() + TICKET_TTL_SECONDS
    payload = {
        "uid": user_id,
        "sid": session_id,
        "cid": conversation_id,
        "exp": expires_at,
        "nonce": secrets.token_urlsafe(18),
    }
    segment = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    return f"{TICKET_VERSION}.{segment}.{_sign(segment, secret)}", expires_at


def parse_ticket(ticket: str | None) -> TicketClaims:
    """Verify signature and expiry. Does not consume the nonce."""
    clean = str(ticket or "").strip()
    parts = clean.split(".")
    if len(parts) != 3 or parts[0] != TICKET_VERSION:
        raise TicketError("ticket_malformed")
    _version, segment, signature = parts
    if not hmac.compare_digest(signature, _sign(segment, _secret())):
        raise TicketError("ticket_signature")
    try:
        payload: dict[str, Any] = json.loads(_b64url_decode(segment))
    except (TypeError, ValueError, binascii.Error):
        raise TicketError("ticket_malformed") from None
    expires_at = int(payload.get("exp") or 0)
    if expires_at <= _now():
        raise TicketError("ticket_expired")
    claims = TicketClaims(
        user_id=str(payload.get("uid") or ""),
        session_id=str(payload.get("sid") or ""),
        conversation_id=str(payload.get("cid") or ""),
        expires_at=expires_at,
        nonce=str(payload.get("nonce") or ""),
    )
    if (
        not claims.user_id
        or not claims.session_id
        or not claims.conversation_id
        or not claims.nonce
    ):
        raise TicketError("ticket_malformed")
    return claims


class NonceRegistry:
    """Cross-instance single-use registry backed by ``relay_ticket_nonces``."""

    async def register(self, nonce: str, expires_at: int) -> bool:
        from db.connection import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            result = str(
                await conn.execute(
                    "INSERT INTO relay_ticket_nonces (nonce, expires_at) "
                    "VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING",
                    nonce,
                    expires_at,
                )
            )
            await conn.execute("DELETE FROM relay_ticket_nonces WHERE expires_at <= $1", _now())
        return result.endswith("1")


async def consume_ticket(ticket: str | None, *, registry: Any | None = None) -> TicketClaims:
    """Verify and consume. Raises :class:`TicketError` on any failure,
    including an unreachable nonce registry (fail closed)."""
    claims = parse_ticket(ticket)
    store = registry or NonceRegistry()
    try:
        registered = await store.register(claims.nonce, claims.expires_at)
    except Exception:  # noqa: BLE001 - never fail open
        raise TicketError("ticket_registry_unavailable") from None
    if not registered:
        raise TicketError("ticket_replayed")
    return claims
