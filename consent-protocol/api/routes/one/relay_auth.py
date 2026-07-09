"""Relay ticket auth for the One ADK live WebSocket.

Browsers cannot attach an Authorization header to a WebSocket, so the client
first mints a short-lived, single-use relay ticket over HTTPS (with optional
Firebase bearer) and presents only that opaque ticket in the ws URL.

Ticket format (v1, stateless): ``v1.<b64url payload>.<b64url hmac-sha256>``
signed with the app signing key. Payload carries uid, persona tier, expiry,
and a one-time nonce. When no signing key is configured (tests), tickets
fall back to an in-memory one-time store.

This is the same contract the legacy Gemini relay used, extracted here so
the One ADK relay owns its auth without dragging persona-hint plumbing along.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi.concurrency import run_in_threadpool

from hushh_mcp.runtime_settings import get_core_security_settings

PersonaTier = Literal[
    "anon_onboarding",
    "anon_browsing",
    "signed_locked",
    "signed_unlocked",
]

_SIGNED_RELAY_TICKET_PREFIX = "v1"
_SESSION_START_WINDOW_SECONDS = 60
_DISABLED_FLAG_VALUES = {"0", "false", "off", "disabled", "no"}

# Fallback one-time ticket store used only when no signing key is configured.
_RELAY_TICKETS: dict[str, tuple[Optional[str], PersonaTier, float]] = {}
# One-time nonce registry for signed tickets (replay protection).
_RELAY_TICKET_NONCES: dict[str, int] = {}


def one_voice_enabled() -> bool:
    configured = os.getenv("AGENT_GEMINI_LIVE_ENABLED", "").strip().lower()
    return configured not in _DISABLED_FLAG_VALUES


async def resolve_optional_uid(authorization: Optional[str]) -> Optional[str]:
    """Best-effort Firebase UID for tier selection + rate-limit bucketing.

    Never raises: a missing/invalid token simply means the anonymous tier.
    Specialist tools still fail closed without a consent token, so the lower
    tier only shapes conversation, never data access.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        from api.utils.firebase_auth import verify_firebase_bearer

        return await run_in_threadpool(verify_firebase_bearer, authorization)
    except Exception:  # noqa: BLE001 - optional auth, anonymous is acceptable
        return None


def resolve_persona_tier(uid: Optional[str], requested_access_tier: Optional[str]) -> PersonaTier:
    if uid:
        return "signed_unlocked" if requested_access_tier == "signed_unlocked" else "signed_locked"
    requested = (requested_access_tier or "").strip().lower()
    if requested == "anon_browsing":
        return "anon_browsing"
    return "anon_onboarding"


def _relay_ticket_secret() -> Optional[str]:
    try:
        return get_core_security_settings().app_signing_key
    except ValueError:
        return None


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def _sign_relay_ticket_payload(payload_segment: str, secret: str) -> str:
    signature = hmac.new(
        secret.encode("utf-8"),
        payload_segment.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return _b64url_encode(signature)


def _prune_relay_tickets(now_monotonic: float) -> None:
    expired = [
        ticket
        for ticket, (_uid, _tier, expires_monotonic) in _RELAY_TICKETS.items()
        if expires_monotonic <= now_monotonic
    ]
    for ticket in expired:
        _RELAY_TICKETS.pop(ticket, None)
    now_epoch = int(datetime.now(tz=timezone.utc).timestamp())
    expired_nonces = [
        nonce for nonce, expires_at in _RELAY_TICKET_NONCES.items() if expires_at <= now_epoch
    ]
    for nonce in expired_nonces:
        _RELAY_TICKET_NONCES.pop(nonce, None)


def issue_relay_ticket(uid: Optional[str], persona_tier: PersonaTier) -> tuple[str, int]:
    now_monotonic = time.monotonic()
    _prune_relay_tickets(now_monotonic)
    expires_at = int(datetime.now(tz=timezone.utc).timestamp()) + _SESSION_START_WINDOW_SECONDS
    secret = _relay_ticket_secret()
    if secret:
        payload = {
            "uid": uid,
            "tier": persona_tier,
            "exp": expires_at,
            "nonce": secrets.token_urlsafe(18),
        }
        payload_segment = _b64url_encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        )
        signature = _sign_relay_ticket_payload(payload_segment, secret)
        return f"{_SIGNED_RELAY_TICKET_PREFIX}.{payload_segment}.{signature}", expires_at

    ticket = secrets.token_urlsafe(32)
    expires_monotonic = now_monotonic + _SESSION_START_WINDOW_SECONDS
    _RELAY_TICKETS[ticket] = (uid, persona_tier, expires_monotonic)
    return ticket, expires_at


def _parse_signed_relay_ticket(
    clean: str,
) -> Optional[tuple[str, int, Optional[str], PersonaTier]]:
    """Verify a signed ticket's HMAC + expiry; return (nonce, exp, uid, tier).

    Does NOT register the nonce: single-use enforcement is the caller's job so
    the registry backend (memory vs Postgres) stays swappable.
    """
    secret = _relay_ticket_secret()
    if not secret:
        return None
    parts = clean.split(".")
    if len(parts) != 3:
        return None
    _version, payload_segment, signature = parts
    expected_signature = _sign_relay_ticket_payload(payload_segment, secret)
    if not hmac.compare_digest(signature, expected_signature):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_segment))
    except (TypeError, ValueError, json.JSONDecodeError, binascii.Error):
        return None
    expires_at = int(payload.get("exp") or 0)
    if expires_at <= int(datetime.now(tz=timezone.utc).timestamp()):
        return None
    nonce = str(payload.get("nonce") or "").strip()
    if not nonce:
        return None
    uid_value = payload.get("uid")
    uid = uid_value if isinstance(uid_value, str) and uid_value else None
    tier_value = payload.get("tier")
    tier: PersonaTier = (
        tier_value
        if tier_value in {"anon_onboarding", "anon_browsing", "signed_locked", "signed_unlocked"}
        else resolve_persona_tier(uid, None)
    )
    return nonce, expires_at, uid, tier


def consume_relay_ticket(
    ticket: Optional[str],
) -> tuple[bool, Optional[str], PersonaTier]:
    """Consume a relay ticket with the process-local nonce registry.

    Prefer ``consume_relay_ticket_shared`` on multi-instance deployments; this
    sync variant remains for tests and single-process callers.
    """
    clean = (ticket or "").strip()
    if not clean:
        return False, None, "anon_onboarding"
    now_monotonic = time.monotonic()
    _prune_relay_tickets(now_monotonic)
    if clean.startswith(f"{_SIGNED_RELAY_TICKET_PREFIX}."):
        parsed = _parse_signed_relay_ticket(clean)
        if parsed is None:
            return False, None, "anon_onboarding"
        nonce, expires_at, uid, tier = parsed
        if nonce in _RELAY_TICKET_NONCES:
            return False, None, "anon_onboarding"
        _RELAY_TICKET_NONCES[nonce] = expires_at
        return True, uid, tier

    stored = _RELAY_TICKETS.pop(clean, None)
    if stored is None:
        return False, None, "anon_onboarding"
    uid, tier, expires_monotonic = stored
    if expires_monotonic <= now_monotonic:
        return False, None, "anon_onboarding"
    return True, uid, tier


async def consume_relay_ticket_shared(
    ticket: Optional[str],
) -> tuple[bool, Optional[str], PersonaTier]:
    """Consume a relay ticket with CROSS-INSTANCE single-use enforcement.

    Signed-ticket nonces register in Postgres (relay_ticket_nonces, migration
    084) via INSERT .. ON CONFLICT DO NOTHING: a conflicting insert means the
    ticket was already consumed on some worker/instance, so it is rejected.
    The process-local registry stays as a fast pre-check and as the fallback
    when the shared tier is unreachable (fail-open to per-process semantics,
    matching the pre-shared behavior; tickets still expire in 60s).

    Scale-plane doctrine (AGENTS.md): Postgres now, Redis later. Redis swap =
    SETNX with TTL replacing _register_nonce_shared, contract unchanged.
    """
    clean = (ticket or "").strip()
    if not clean:
        return False, None, "anon_onboarding"
    if not clean.startswith(f"{_SIGNED_RELAY_TICKET_PREFIX}."):
        return consume_relay_ticket(clean)

    now_monotonic = time.monotonic()
    _prune_relay_tickets(now_monotonic)
    parsed = _parse_signed_relay_ticket(clean)
    if parsed is None:
        return False, None, "anon_onboarding"
    nonce, expires_at, uid, tier = parsed
    if nonce in _RELAY_TICKET_NONCES:
        return False, None, "anon_onboarding"
    registered = await _register_nonce_shared(nonce, expires_at)
    if not registered:
        return False, None, "anon_onboarding"
    _RELAY_TICKET_NONCES[nonce] = expires_at
    return True, uid, tier


async def _register_nonce_shared(nonce: str, expires_at: int) -> bool:
    """Register a nonce in the shared Postgres registry; False on replay.

    On shared-tier failure, fall back to process-local registration so a DB
    blip does not take voice down (the ticket is still HMAC-verified, expiry
    bound to 60s, and single-use per process).
    """
    try:
        from db.connection import get_pool

        pool = await get_pool()
        now_epoch = int(datetime.now(tz=timezone.utc).timestamp())
        async with pool.acquire() as conn:
            result = str(
                await conn.execute(
                    "INSERT INTO relay_ticket_nonces (nonce, expires_at) "
                    "VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING",
                    nonce,
                    expires_at,
                )
            )
            # Opportunistic prune keeps the table tiny (60s ticket TTL).
            await conn.execute(
                "DELETE FROM relay_ticket_nonces WHERE expires_at <= $1",
                now_epoch,
            )
        return result.endswith("1")
    except Exception:  # noqa: BLE001 - degrade to per-process single-use
        return nonce not in _RELAY_TICKET_NONCES
