"""Metadata-only provider evidence for the optional attempt-email outbox.

The signed worker validates Gmail acceptance and RFC3464 reports. Stored
provider IDs, actual RFC headers and immutable recipient hashes must all match.
Reading a report never enrolls an owner or infers Inbox delivery.
"""

from db.connection import get_pool
from hushh_mcp.services.attempt_email import _owner_lock


async def _snapshot(conn):
    rows = await conn.fetch(
        """SELECT id,provider_id,recipient_hash FROM one_attempt_email_outbox
        WHERE provider_id IS NOT NULL AND rfc_message_id IS NULL ORDER BY created_at,id LIMIT 20""",
        timeout=5,
    )
    oldest = await conn.fetchval(
        """SELECT created_at FROM one_attempt_email_outbox
        WHERE claimed_at IS NOT NULL ORDER BY created_at,id LIMIT 1""",
        timeout=5,
    )
    unsettled = await conn.fetchval(
        """SELECT EXISTS(SELECT 1 FROM one_attempt_email_outbox
        WHERE status IN ('sending','uncertain') AND provider_id IS NULL)""",
        timeout=5,
    )
    return {
        "oldestAt": oldest.isoformat() if oldest else None,
        "unsettled": bool(unsettled),
        "unbound": [
            {
                "id": str(row["id"]),
                "providerId": row["provider_id"],
                "recipientHash": row["recipient_hash"],
            }
            for row in rows
        ],
    }


async def read():
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn:
        return await _snapshot(conn)


async def apply(*, submissions: list[dict], bounces: list[dict]):
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        # Serialize the final completeness decision with claims/settlements.
        # A send beginning while history is in flight must keep that page replayable.
        await conn.execute("SELECT pg_advisory_xact_lock(448,1)", timeout=5)
        for submission in submissions:
            row = await conn.fetchrow(
                "SELECT user_id FROM one_attempt_email_outbox WHERE provider_id=$1 AND recipient_hash=$2",
                submission["providerId"],
                submission["recipientHash"],
                timeout=5,
            )
            if not row:
                continue  # unrelated or erased; never recreate a reservation
            try:
                await _owner_lock(conn, row["user_id"])
            except PermissionError:
                # A cleanup barrier may be temporary (for example phone-orphan).
                # Keep the report replayable while its retained owner is blocked.
                return False
            changed = await conn.fetchval(
                """UPDATE one_attempt_email_outbox SET rfc_message_id=$3
                WHERE provider_id=$1 AND recipient_hash=$2 AND status='accepted'
                AND (rfc_message_id IS NULL OR rfc_message_id=$3) RETURNING id""",
                submission["providerId"],
                submission["recipientHash"],
                submission["messageId"],
                timeout=5,
            )
            if not changed:
                raise ValueError("Provider metadata conflict")
        # Do not consume a report while any earlier/current acceptance is unbound.
        snapshot = await _snapshot(conn)
        if snapshot["unsettled"] or snapshot["unbound"]:
            return False
        for report in bounces:
            row = await conn.fetchrow(
                """SELECT user_id,id FROM one_attempt_email_outbox
                WHERE rfc_message_id=$1 AND recipient_hash=$2 AND provider_id IS NOT NULL""",
                report["messageId"],
                report["recipientHash"],
                timeout=5,
            )
            if not row:
                continue
            try:
                await _owner_lock(conn, row["user_id"])
            except PermissionError:
                return False
            await conn.execute(
                "UPDATE one_attempt_email_outbox SET bounced_at=COALESCE(bounced_at,NOW()) WHERE id=$1",
                row["id"],
                timeout=5,
            )
            await conn.execute(
                """UPDATE one_attempt_email_preferences SET enabled=FALSE,delivery_blocked=TRUE,
                revision=revision+1,chosen_at=NOW() WHERE user_id=$1 AND NOT delivery_blocked""",
                row["user_id"],
                timeout=5,
            )
        return True
