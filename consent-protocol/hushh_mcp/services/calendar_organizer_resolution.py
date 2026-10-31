"""Who can receive a Calendar meeting file request, and why a request is refused.

Resolves the organizer only among the requester's own active One peers, without
directory disclosure, and turns every refusal into a closed reason with a
count-only operator log. Kept apart from the request service so the identity
rules can be read, and tested, on their own.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, NamedTuple

import asyncpg

from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import _IDENTITY_STALE_AFTER, ActorIdentityService
from hushh_mcp.services.calendar_invitations import attendee_status
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

logger = logging.getLogger(__name__)

_PEER_REFRESH_LIMIT = 12
_PEER_REFRESH_SECONDS = 8
_LOOKUP_ERRORS = (asyncpg.PostgresError, OSError, TimeoutError)


def _log_token(value: str) -> str:
    """Dotted, so the log redactor does not mask a fixed code as an identifier.

    mcp_modules.log_redaction masks any 24-128 character argument made of letters,
    digits, `_` and `-` that contains `_` or `-`. These values are a closed
    vocabulary, so they are logged as ``organizer.unresolved``; see
    ``one_adk.run_errors.error_code`` for the same convention.
    """
    return value.replace("_", ".")


def refuse(
    code: str,
    reason: str,
    *,
    outcome: str = "none",
    retryable: bool = False,
    **counts: int,
) -> DriveSharingError:
    """Count-only operator log (no emails, IDs or event text), then the closed error."""
    (logger.warning if retryable else logger.info)(
        "calendar_request_refused code=%s reason=%s outcome=%s %s",
        _log_token(code),
        _log_token(reason),
        _log_token(outcome),
        " ".join(f"{key}={int(value)}" for key, value in sorted(counts.items())),
    )
    return DriveSharingError(code, diagnostic_reason=reason, retryable=retryable)


_ORGANIZER_PEERS = """SELECT DISTINCT CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END AS peer
     FROM connections c
     WHERE c.status='active' AND (c.user_a_id=$1 OR c.user_b_id=$1)
       AND (EXISTS (SELECT 1 FROM actor_identity_cache i
           WHERE i.user_id=CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END
             AND i.email_verified AND lower(i.email)=$2)
         OR EXISTS (SELECT 1 FROM actor_verified_email_aliases a
           WHERE a.user_id=CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END
             AND a.email_normalized=$2 AND a.verification_status='verified'
             AND a.revoked_at IS NULL))
     LIMIT 3"""

# Active peers whose cached identity cannot yet vouch for any email: no cache row,
# no email, unverified, or older than the cache's own freshness window.
_PEERS_NEEDING_REFRESH = """SELECT p.peer FROM (
       SELECT DISTINCT CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END AS peer
         FROM connections c
         WHERE c.status='active' AND (c.user_a_id=$1 OR c.user_b_id=$1)) p
     LEFT JOIN actor_identity_cache i ON i.user_id=p.peer
     WHERE i.user_id IS NULL OR i.email IS NULL OR NOT i.email_verified
        OR i.last_synced_at < NOW() - make_interval(secs => $2)
     ORDER BY i.last_synced_at ASC NULLS FIRST
     LIMIT $3"""

# The requester's own pending connection requests, in either direction. Both
# sides already know about these, so reading them discloses nothing new. The SQL
# is written out in full rather than assembled, so no query is ever built from
# strings.
_PENDING_ORGANIZER = """SELECT 1 FROM connection_requests r
     WHERE r.status='pending' AND (r.requester_user_id=$1 OR r.addressee_user_id=$1)
       AND (EXISTS (SELECT 1 FROM actor_identity_cache i
           WHERE i.user_id=CASE WHEN r.requester_user_id=$1 THEN r.addressee_user_id ELSE r.requester_user_id END
             AND i.email_verified AND lower(i.email)=$2)
         OR EXISTS (SELECT 1 FROM actor_verified_email_aliases a
           WHERE a.user_id=CASE WHEN r.requester_user_id=$1 THEN r.addressee_user_id ELSE r.requester_user_id END
             AND a.email_normalized=$2 AND a.verification_status='verified'
             AND a.revoked_at IS NULL))
     LIMIT 1"""
_PENDING_NEEDING_REFRESH = """SELECT p.peer FROM (
       SELECT DISTINCT CASE WHEN r.requester_user_id=$1 THEN r.addressee_user_id ELSE r.requester_user_id END AS peer
         FROM connection_requests r
         WHERE r.status='pending'
           AND (r.requester_user_id=$1 OR r.addressee_user_id=$1)) p
     LEFT JOIN actor_identity_cache i ON i.user_id=p.peer
     WHERE i.user_id IS NULL OR i.email IS NULL OR NOT i.email_verified
        OR i.last_synced_at < NOW() - make_interval(secs => $2)
     ORDER BY i.last_synced_at ASC NULLS FIRST
     LIMIT $3"""


async def _refresh_unproven_peers(
    pool, user_id: str, query: str = _PEERS_NEEDING_REFRESH
) -> tuple[int, int]:
    """Re-read Firebase for this requester's own active peers with unproven cached email.

    A missing or stale cache row is not evidence that an organizer has no One
    account, so it must not decide the outcome. This is scoped to the requester's
    existing relationships, bounded in count and time, and only runs when the
    cached lookup found nobody. Returns (attempted, failed).

    A peer that cannot be re-read (deleted, disabled, provider error) raises the
    same error as an outage, so per-peer failure is counted, never treated as a
    reason to retry: that would trap a requester behind one dead peer. Only an
    overall timeout or database error is retryable, and both propagate.
    """
    async with pool.acquire() as connection:
        rows = await connection.fetch(
            query,
            user_id,
            _IDENTITY_STALE_AFTER.total_seconds(),
            _PEER_REFRESH_LIMIT,
            timeout=5,
        )
    peers = [str(row["peer"]) for row in rows]
    if not peers:
        return 0, 0
    service = ActorIdentityService()
    async with asyncio.timeout(_PEER_REFRESH_SECONDS):
        results = await asyncio.gather(
            *(service.sync_from_firebase(p, force=True, require_success=True) for p in peers),
            return_exceptions=True,
        )
    return len(peers), sum(isinstance(result, BaseException) for result in results)


class _Resolution(NamedTuple):
    """Where the requester stands with an organizer, and the count-only evidence."""

    state: str  # ready | pending | not_connected | ambiguous | changed
    peer: str | None
    outcome: str
    counts: dict[str, Any]


async def _pending_organizer(pool, user_id: str, email: str) -> bool:
    """Does the requester have a pending connection request with this verified email?"""
    async with pool.acquire() as connection:
        if await connection.fetchval(_PENDING_ORGANIZER, user_id, email, timeout=5):
            return True
    attempted, failed = await _refresh_unproven_peers(pool, user_id, _PENDING_NEEDING_REFRESH)
    if attempted <= failed:
        return False
    async with pool.acquire() as connection:
        return bool(await connection.fetchval(_PENDING_ORGANIZER, user_id, email, timeout=5))


async def _resolve(user_id: str, email: str, *, include_pending: bool) -> _Resolution:
    """Resolve only the requester's active One peers, without directory disclosure.

    A lookup that could not finish is retryable and never reads as "no organizer".
    ``include_pending`` also looks at the requester's own pending connection
    requests; the request path leaves it off, so nothing about creating a request
    changes.
    """
    pool = await get_pool()
    attempted = failed = 0
    pending = False
    try:
        async with pool.acquire() as connection:
            rows = await connection.fetch(_ORGANIZER_PEERS, user_id, email, timeout=5)
        if not rows:
            attempted, failed = await _refresh_unproven_peers(pool, user_id)
            if attempted > failed:
                async with pool.acquire() as connection:
                    rows = await connection.fetch(_ORGANIZER_PEERS, user_id, email, timeout=5)
        if not rows and include_pending:
            pending = await _pending_organizer(pool, user_id, email)
    except _LOOKUP_ERRORS:
        raise refuse(
            "recipient_verification_unavailable",
            "organizer_lookup_unavailable",
            outcome="lookup_error",
            retryable=True,
        ) from None
    if not rows:
        return _Resolution(
            "pending" if pending else "not_connected",
            None,
            "no_active_peer_with_verified_email",
            {"refreshed": attempted - failed, "refresh_failed": failed},
        )
    if len(rows) != 1:
        return _Resolution("ambiguous", None, "ambiguous_peers", {"matches": len(rows)})
    peer = str(rows[0]["peer"])
    try:
        fresh = await ActorIdentityService().sync_from_firebase(
            peer, force=True, require_success=True
        )
        async with pool.acquire() as connection:
            alias_verified = await connection.fetchval(
                """SELECT EXISTS (SELECT 1 FROM actor_verified_email_aliases
                   WHERE user_id=$1 AND email_normalized=$2
                     AND verification_status='verified' AND revoked_at IS NULL)""",
                peer,
                email,
                timeout=5,
            )
    except Exception:
        raise DriveSharingError("recipient_verification_unavailable", retryable=True) from None
    if (
        not (
            (fresh or {}).get("email_verified") is True
            and str((fresh or {}).get("email") or "").casefold() == email
        )
        and not alias_verified
    ):
        return _Resolution("changed", None, "identity_changed_on_fresh_read", {})
    return _Resolution("ready", peer, "", {})


async def connected_organizer(user_id: str, email: str) -> str:
    """The organizer's user id, only when an active, uniquely verified peer.

    Refusals carry a closed reason; the finer cause is a count-only operator log.
    This is the authoritative check, run again whenever a request is created.
    """
    resolution = await _resolve(user_id, email, include_pending=False)
    if resolution.state != "ready" or resolution.peer is None:
        raise refuse(
            "calendar_organizer_unavailable",
            "organizer_unresolved",
            outcome=resolution.outcome,
            **resolution.counts,
        )
    return resolution.peer


async def organizer_readiness(user_id: str, email: str) -> str:
    """ready | pending | not_connected | unavailable, for a requester who has not sent yet.

    Read-only and advisory: the request path decides again with
    ``connected_organizer``. Only the requester's own active peers and pending
    requests are read, so an organizer who is not connected looks the same as one
    who has no One account.
    """
    resolution = await _resolve(user_id, email, include_pending=True)
    state = "unavailable" if resolution.state in {"ambiguous", "changed"} else resolution.state
    logger.info(
        "calendar_request_readiness state=%s outcome=%s %s",
        _log_token(state),
        _log_token(resolution.outcome or "verified"),
        " ".join(f"{key}={int(value)}" for key, value in sorted(resolution.counts.items())),
    )
    return state


def require_attending(event: dict, email: str) -> None:
    """The requester must be an invited attendee who has not declined."""
    attendee, refusal = attendee_status(event, email, raw=True)
    if refusal:
        raise refuse("calendar_attendee_required", refusal)
    if attendee.get("responseStatus") == "declined":
        raise refuse("calendar_attendee_required", "requester_declined")
