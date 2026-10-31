"""Who can receive a Calendar meeting file request, and why a request is refused.

Resolves the organizer only among the requester's own active One peers, without
directory disclosure, and turns every refusal into a closed reason with a
count-only operator log. Kept apart from the request service so the identity
rules can be read, and tested, on their own.
"""

from __future__ import annotations

import asyncio
import logging

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


async def _refresh_unproven_peers(pool, user_id: str) -> tuple[int, int]:
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
            _PEERS_NEEDING_REFRESH,
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


async def connected_organizer(user_id: str, email: str) -> str:
    """Resolve only the requester's active One peers, without directory disclosure.

    Refusals carry a closed reason; the finer cause is a count-only operator log.
    A lookup that could not finish is retryable and never reads as "no organizer".
    """
    pool = await get_pool()
    attempted = failed = 0
    try:
        async with pool.acquire() as connection:
            rows = await connection.fetch(_ORGANIZER_PEERS, user_id, email, timeout=5)
        if not rows:
            attempted, failed = await _refresh_unproven_peers(pool, user_id)
            if attempted > failed:
                async with pool.acquire() as connection:
                    rows = await connection.fetch(_ORGANIZER_PEERS, user_id, email, timeout=5)
    except _LOOKUP_ERRORS:
        raise refuse(
            "recipient_verification_unavailable",
            "organizer_lookup_unavailable",
            outcome="lookup_error",
            retryable=True,
        ) from None
    if not rows:
        raise refuse(
            "calendar_organizer_unavailable",
            "organizer_unresolved",
            outcome="no_active_peer_with_verified_email",
            refreshed=attempted - failed,
            refresh_failed=failed,
        )
    if len(rows) != 1:
        raise refuse(
            "calendar_organizer_unavailable",
            "organizer_unresolved",
            outcome="ambiguous_peers",
            matches=len(rows),
        )
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
        raise refuse(
            "calendar_organizer_unavailable",
            "organizer_unresolved",
            outcome="identity_changed_on_fresh_read",
        )
    return peer


def require_attending(event: dict, email: str) -> None:
    """The requester must be an invited attendee who has not declined."""
    attendee, refusal = attendee_status(event, email, raw=True)
    if refusal:
        raise refuse("calendar_attendee_required", refusal)
    if attendee.get("responseStatus") == "declined":
        raise refuse("calendar_attendee_required", "requester_declined")
