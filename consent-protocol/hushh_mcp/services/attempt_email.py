"""Optional owner-attempt email authority and durable outbox claims.

No provider call lives here. A claim commits before an external submission;
lost responses stay uncertain and are never put back on the pending queue.
Marketing opt-in, a catalog entry, or an SDK tool callback cannot grant this
permission. The SQL outbox only covers accepted interactive terminal reports.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
from uuid import UUID, uuid4

from db.connection import get_pool
from hushh_mcp.services import marketing_preferences, product_activity
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.plg_catalog import activity_catalog

DISCLOSURE = "one-attempt-email-v1"


def worker_authority():
    from api.utils.firebase_auth import current_auth_lane

    lane = current_auth_lane()
    expected = {"production": "hushh-pda", "uat": "hushh-pda-uat"}.get(lane)
    secret = os.getenv("ONE_PLG_ATTEMPT_EMAIL_SECRET", "")
    if not expected or os.getenv("GOOGLE_CLOUD_PROJECT") != expected or len(secret) < 32:
        raise PermissionError("Attempt email worker unavailable")
    if secret in [
        os.getenv(name, "")
        for name in (
            "ONE_PLG_EXPORT_SECRET",
            "ONE_PLG_AUDIENCE_SECRET",
            "ONE_PLG_UAT_EXPORT_SECRET",
            "ONE_PLG_SUBSCRIPTION_SECRET",
        )
    ]:
        raise PermissionError("Attempt email worker unavailable")
    return lane, secret


def unsubscribe_token(uid: str, generation: UUID):
    lane, secret = worker_authority()
    owner_hash = hashlib.sha256(uid.encode()).hexdigest()
    value = f"{owner_hash}.{generation}"
    signature = hmac.new(
        secret.encode(), f"attempt-email-unsubscribe.{lane}.{value}".encode(), hashlib.sha256
    ).hexdigest()
    return f"{value}.{signature}"


async def unsubscribe(token: str):
    lane, secret = worker_authority()
    if not re.fullmatch(r"[0-9a-f]{64}\.[0-9a-f-]{36}\.[0-9a-f]{64}", token):
        raise ValueError("Invalid unsubscribe link")
    owner_hash, generation, signature = token.split(".")
    generation = UUID(generation)
    value = f"{owner_hash}.{generation}"
    expected = hmac.new(
        secret.encode(), f"attempt-email-unsubscribe.{lane}.{value}".encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("Invalid unsubscribe link")
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        uid = await conn.fetchval(
            "SELECT user_id FROM one_attempt_email_preferences WHERE user_hash=$1",
            f"sha256:{owner_hash}",
            timeout=5,
        )
        if uid:
            try:
                await _owner_lock(conn, uid)
            except PermissionError:
                return
            await conn.execute(
                """UPDATE one_attempt_email_preferences SET enabled=FALSE,
              revision=revision+1,chosen_at=NOW() WHERE user_id=$1 AND generation=$2 AND enabled""",
                uid,
                generation,
                timeout=5,
            )


def allowed_accounts() -> set[str]:
    from api.utils.firebase_auth import current_auth_lane

    lane = current_auth_lane()
    expected = {"production": "hushh-pda", "uat": "hushh-pda-uat"}.get(lane)
    accounts = {
        uid.strip()
        for uid in os.getenv("ONE_PLG_ATTEMPT_EMAIL_ACCOUNT_IDS", "").split(",")
        if uid.strip()
    }
    if (
        not expected
        or os.getenv("GOOGLE_CLOUD_PROJECT") != expected
        or os.getenv("ONE_PLG_ATTEMPT_EMAIL_ENABLED") != "true"
        or not 1 <= len(accounts) <= 100
        or any(len(uid) > 128 for uid in accounts)
    ):
        return set()
    return accounts


async def _owner_lock(conn, uid: str):
    if uid not in await AccountDeletionLifecycleService.active_projection_user_ids(
        conn, user_ids=[uid]
    ):
        raise PermissionError("Account unavailable")
    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,448))", uid, timeout=5)


def _public(row):
    return {
        "enabled": bool(row and row["enabled"]),
        "revision": row["revision"] if row else 0,
        "disclosureVersion": DISCLOSURE,
        "frequency": "one_per_attempt",
    }


async def preference(uid: str):
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _owner_lock(conn, uid)
        row = await conn.fetchrow(
            "SELECT * FROM one_attempt_email_preferences WHERE user_id=$1", uid, timeout=5
        )
    return {
        **_public(row),
        "available": uid in allowed_accounts()
        and product_activity.enabled_for(uid)
        and not (row and row["delivery_blocked"]),
    }


async def choose(uid: str, *, enabled: bool, expected_revision: int, disclosure: str):
    if disclosure != DISCLOSURE or type(enabled) is not bool or expected_revision < 0:
        raise ValueError("Invalid attempt email preference")
    if enabled and (uid not in allowed_accounts() or not product_activity.enabled_for(uid)):
        raise PermissionError("Attempt email unavailable")
    pool = await get_pool()
    if enabled:
        # Reject an already-erased owner before identity/provider lookup or an
        # activity epoch admission. Repeat this barrier at the actual write.
        async with pool.acquire(timeout=5) as conn, conn.transaction():
            await _owner_lock(conn, uid)
    # Opt-out works without the provider, Firebase or collection being available.
    recipient = await marketing_preferences.verified_recipient(uid) if enabled else None
    admitted = await asyncio.to_thread(product_activity.admission, uid) if enabled else None
    if enabled and not admitted:
        raise PermissionError("Activity capture unavailable")
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _owner_lock(conn, uid)
        current = await conn.fetchrow(
            "SELECT * FROM one_attempt_email_preferences WHERE user_id=$1 FOR UPDATE",
            uid,
            timeout=5,
        )
        revision = current["revision"] if current else 0
        if enabled and current and current["delivery_blocked"]:
            raise PermissionError("Provider delivery is held")
        if expected_revision != revision:
            raise marketing_preferences.PreferenceConflict("Refresh the current email choice")
        if not enabled and not current:
            return _public(None)
        epoch = await conn.fetchval(
            "SELECT generation FROM one_product_activity_epochs WHERE user_id=$1 FOR SHARE",
            uid,
            timeout=5,
        )
        if enabled and str(epoch) != admitted["generation"]:
            raise marketing_preferences.PreferenceConflict("Account changed; choose again")
        email_hash = recipient["email_hash"] if recipient else current["email_hash"]
        if (
            current
            and current["enabled"] == enabled
            and (
                not enabled
                or (current["email_hash"] == email_hash and current["activity_generation"] == epoch)
            )
        ):
            return _public(current)
        row = await conn.fetchrow(
            """INSERT INTO one_attempt_email_preferences
            (user_id,enabled,revision,generation,activity_generation,email_hash,disclosure_version,consent_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $2 THEN NOW() ELSE NULL END)
            ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,revision=EXCLUDED.revision,
              generation=EXCLUDED.generation,activity_generation=EXCLUDED.activity_generation,
              email_hash=EXCLUDED.email_hash,consent_at=EXCLUDED.consent_at,chosen_at=NOW()
            RETURNING *""",
            uid,
            enabled,
            revision + 1,
            uuid4() if enabled else current["generation"],
            epoch if enabled else current["activity_generation"],
            email_hash,
            DISCLOSURE,
            timeout=5,
        )
    return _public(row)


async def pending():
    accounts = sorted(allowed_accounts())
    if not accounts:
        return []
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn:
        # Bound maintenance by indexed state/time. Lost worker acknowledgements
        # become visibly uncertain, never eligible for another submission.
        await conn.execute(
            """UPDATE one_attempt_email_outbox SET status='uncertain' WHERE id IN
          (SELECT id FROM one_attempt_email_outbox WHERE status='sending'
           AND claimed_at<NOW()-INTERVAL '2 minutes' ORDER BY claimed_at,id LIMIT 100)""",
            timeout=5,
        )
        await conn.execute(
            """UPDATE one_attempt_email_outbox SET status='suppressed' WHERE id IN
          (SELECT id FROM one_attempt_email_outbox WHERE status='pending'
           AND expires_at<=NOW() ORDER BY expires_at,id LIMIT 100)""",
            timeout=5,
        )
        rows = await conn.fetch(
            """SELECT id,user_id FROM one_attempt_email_outbox
            WHERE status='pending' AND submission_attempts<3 AND expires_at>NOW() AND user_id=ANY($1::text[])
            ORDER BY created_at,id LIMIT 20""",
            accounts,
            timeout=5,
        )
    # No address or activity content is needed for worker selection.
    return [{"id": str(row["id"]), "accountId": row["user_id"]} for row in rows]


async def claim(uid: str, delivery_id: UUID, claim_id: UUID):
    """One successful claim only; a repeated claim never repeats its send grant."""
    if uid not in allowed_accounts() or not product_activity.enabled_for(uid):
        return None
    recipient = await marketing_preferences.verified_recipient(uid)
    lane, _ = worker_authority()
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(448,1)", timeout=5)
        await _owner_lock(conn, uid)
        row = await conn.fetchrow(
            """SELECT o.*,p.enabled,p.delivery_blocked,p.generation AS current_permission,p.revision AS current_revision,
              p.email_hash AS current_email,e.generation AS current_epoch
            FROM one_attempt_email_outbox o
            JOIN one_attempt_email_preferences p ON p.user_id=o.user_id
            JOIN one_product_activity_epochs e ON e.user_id=o.user_id
            WHERE o.id=$1 AND o.user_id=$2 FOR UPDATE OF o,p FOR SHARE OF e""",
            delivery_id,
            uid,
            timeout=5,
        )
        if not row or row["status"] != "pending":
            return None
        catalog = activity_catalog()
        action = next((a for a in catalog["actions"] if a["id"] == row["action_id"]), None)
        agent = next((a for a in catalog["agents"] if a["id"] == row["agent_id"]), None)
        current = (
            action is not None
            and action["proof"] == "client_reported"
            and action["agentId"] == row["agent_id"]
            and agent is not None
            and agent["public"]
            and agent["available"]
            and row["enabled"]
            and not row["delivery_blocked"]
            and row["permission_generation"] == row["current_permission"]
            and row["permission_revision"] == row["current_revision"]
            and row["activity_generation"] == row["current_epoch"]
            and row["recipient_hash"] == row["current_email"] == recipient["email_hash"]
        )
        if not current:
            await conn.execute(
                "UPDATE one_attempt_email_outbox SET status='suppressed' WHERE id=$1",
                delivery_id,
                timeout=5,
            )
            return None
        changed = await conn.fetchval(
            """UPDATE one_attempt_email_outbox SET status='sending',claim_id=$2,claimed_at=NOW(),
              submission_attempts=submission_attempts+1
            WHERE id=$1 AND submission_attempts<3 AND expires_at>NOW() RETURNING id""",
            delivery_id,
            claim_id,
            timeout=5,
        )
        if not changed:
            return None
    # Only the trusted worker sees the address, after fresh verified-identity
    # and exact owner/permission/epoch checks. Never log this response.
    return {
        "id": str(delivery_id),
        "claimId": str(claim_id),
        "to": recipient["email"],
        "agentId": row["agent_id"],
        "actionId": row["action_id"],
        "agentLabel": agent["label"],
        "actionLabel": action["label"],
        "phase": row["phase"],
        "observedAt": row["observed_at"].isoformat(),
        "source": "client_reported",
        "permissionGeneration": str(row["permission_generation"]),
        "unsubscribeUrl": (
            ("https://api.uat.hushh.ai" if lane == "uat" else "https://api.hushh.ai")
            + "/api/one/plg/attempt-email/unsubscribe?token="
            + unsubscribe_token(uid, row["permission_generation"])
        ),
    }


async def acknowledge(
    delivery_id: UUID, claim_id: UUID, provider_id: str | None, *, not_submitted: bool = False
):
    """Idempotent receipt, never a send grant. No owner identifier leaves One.

    The durable mailbox acknowledgement queue needs only opaque delivery/claim
    IDs. An erased/reset delivery is already retired; acknowledging that absence
    creates no row and does not assert acceptance or Inbox delivery.
    """
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn:
        uid = await conn.fetchval(
            "SELECT user_id FROM one_attempt_email_outbox WHERE id=$1", delivery_id, timeout=5
        )
    if uid is None:
        return True
    try:
        received = await settle(
            uid, delivery_id, claim_id, provider_id, not_submitted=not_submitted
        )
    except PermissionError:
        received = False
    if received:
        return True
    async with pool.acquire(timeout=5) as conn:
        # A concurrent full erasure/reset may have removed the row after lookup.
        # A retained row behind a temporary lifecycle barrier must be replayed.
        return not await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM one_attempt_email_outbox WHERE id=$1)",
            delivery_id,
            timeout=5,
        )


async def settle(
    uid: str,
    delivery_id: UUID,
    claim_id: UUID,
    provider_id: str | None,
    *,
    not_submitted: bool = False,
):
    """Lost/ambiguous submission stays claimed; acknowledgement can be retried."""
    if provider_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", provider_id):
        raise ValueError("Invalid provider acceptance")
    if not_submitted and provider_id is not None:
        raise ValueError("Conflicting submission outcome")
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(448,1)", timeout=5)
        await _owner_lock(conn, uid)
        if not_submitted:
            # Only the trusted transport's definite pre-submission rejection
            # can release a current claim. Unknown submissions never return here.
            changed = await conn.fetchval(
                """UPDATE one_attempt_email_outbox SET
                status=CASE WHEN submission_attempts>=3 THEN 'suppressed' ELSE 'pending' END,claimed_at=NULL
                WHERE id=$1 AND user_id=$2 AND claim_id=$3 AND status='sending' AND provider_id IS NULL RETURNING id""",
                delivery_id,
                uid,
                claim_id,
                timeout=5,
            )
            return bool(
                changed
                or await conn.fetchval(
                    """SELECT EXISTS(SELECT 1 FROM one_attempt_email_outbox WHERE id=$1 AND user_id=$2
                AND claim_id=$3 AND status IN ('pending','suppressed') AND claimed_at IS NULL)""",
                    delivery_id,
                    uid,
                    claim_id,
                    timeout=5,
                )
            )
        changed = await conn.fetchval(
            """UPDATE one_attempt_email_outbox SET
              status=CASE WHEN $4::text IS NULL THEN 'uncertain' ELSE 'accepted' END,
              provider_id=$4,accepted_at=CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END
            WHERE id=$1 AND user_id=$2 AND claim_id=$3 AND status IN ('sending','uncertain')
            RETURNING id""",
            delivery_id,
            uid,
            claim_id,
            provider_id,
            timeout=5,
        )
        if changed:
            return True
        return bool(
            await conn.fetchval(
                """SELECT EXISTS(SELECT 1 FROM one_attempt_email_outbox
            WHERE id=$1 AND user_id=$2 AND claim_id=$3 AND status='accepted' AND provider_id=$4)""",
                delivery_id,
                uid,
                claim_id,
                provider_id,
                timeout=5,
            )
        )
