"""Explicit email choice and a durable, coalesced subscription projection.

Firebase proves account identity, never messaging permission. The database is
the choice authority; Matrix availability is outside the write transaction.
The indexed per-account change queue can later move to a managed message bus
without changing revision/generation fences or acknowledgement semantics.
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
    account_deletion_user_hash,
)
from hushh_mcp.services.one_owner_admission import firebase_uid_for_owner_read

DISCLOSURE_VERSION = "one-email-updates-v1"
FREQUENCIES = frozenset({"daily", "weekly", "updates"})
PENDING_SQL = """SELECT c.user_hash,p.user_id FROM one_marketing_changes c
    LEFT JOIN one_marketing_preferences p USING(user_hash)
    WHERE c.pending ORDER BY c.updated_at,c.user_hash LIMIT 20"""
RECONCILE_SQL = """SELECT c.user_hash,p.user_id FROM one_marketing_changes c
    LEFT JOIN one_marketing_preferences p USING(user_hash)
    WHERE NOT c.pending AND NOT c.erased AND c.updated_at < NOW()-INTERVAL '1 hour'
    ORDER BY c.updated_at,c.user_hash LIMIT $1"""


class PreferenceConflict(ValueError):
    """A stale editor cannot overwrite a later choice."""


class VerifiedEmailRequired(ValueError):
    """Permission must be bound to a currently verified recipient."""


def _email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


async def verified_recipient(user_id: str) -> dict[str, Any]:
    # Do not use a cached or COALESCE-retained alias to grant fresh permission.
    from firebase_admin import auth

    from api.utils.firebase_admin import get_firebase_auth_app

    app = get_firebase_auth_app()
    if app is None:
        raise RuntimeError("Identity lookup unavailable")
    try:
        async with asyncio.timeout(10):
            identity_uid = await asyncio.to_thread(firebase_uid_for_owner_read, user_id)
            person = await asyncio.to_thread(auth.get_user, identity_uid, app=app)
    except auth.UserNotFoundError:
        raise VerifiedEmailRequired("A verified account email is required") from None
    email = str(getattr(person, "email", "") or "").strip().lower()
    if (
        getattr(person, "disabled", False)
        or not getattr(person, "email_verified", False)
        or not email
    ):
        raise VerifiedEmailRequired("A verified account email is required")
    created = getattr(getattr(person, "user_metadata", None), "creation_timestamp", None)
    return {
        "email": email,
        "email_hash": _email_hash(email),
        "name": str(getattr(person, "display_name", "") or "")[:100],
        "created_at": datetime.fromtimestamp(created / 1000, timezone.utc) if created else None,
    }


def public_preference(row: Any | None) -> dict[str, Any]:
    def stamp(key):
        value = row[key] if row else None
        return value.isoformat() if isinstance(value, datetime) else value

    return {
        "enabled": bool(row and row["enabled"]),
        "frequency": row["frequency"] if row else "weekly",
        "revision": row["revision"] if row else 0,
        "generation": str(row["generation"]) if row else None,
        "disclosureVersion": DISCLOSURE_VERSION,
        "consentAt": stamp("consent_at"),
        "chosenAt": stamp("chosen_at"),
    }


async def _active_owner(conn, user_id: str):
    if user_id not in await AccountDeletionLifecycleService.active_projection_user_ids(
        conn, user_ids=[user_id]
    ):
        raise PermissionError("Account unavailable")


async def preference(user_id: str) -> dict[str, Any]:
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _active_owner(conn, user_id)
        row = await conn.fetchrow(
            "SELECT * FROM one_marketing_preferences WHERE user_id=$1", user_id, timeout=5
        )
    return public_preference(row)


async def choose_preference(
    user_id: str,
    *,
    enabled: bool,
    frequency: str,
    expected_revision: int,
    disclosure_version: str,
    surface: str,
):
    if frequency not in FREQUENCIES or surface not in {"setup", "account"}:
        raise ValueError("Invalid email preference")
    if disclosure_version != DISCLOSURE_VERSION:
        raise ValueError("Email disclosure changed; refresh before choosing")
    # Turning off works even when the email provider/identity lookup is down.
    recipient = await verified_recipient(user_id) if enabled else None
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _active_owner(conn, user_id)
        # Acquire lifecycle barriers first, then this per-account choice lock.
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,370))", user_id, timeout=5
        )
        current = await conn.fetchrow(
            "SELECT * FROM one_marketing_preferences WHERE user_id=$1 FOR UPDATE",
            user_id,
            timeout=5,
        )
        revision = current["revision"] if current else 0
        if expected_revision != revision:
            raise PreferenceConflict("Email preferences changed; refresh and choose again")
        address_hash = (
            recipient["email_hash"] if recipient else (current["email_hash"] if current else None)
        )
        if (
            current
            and current["enabled"] == enabled
            and current["frequency"] == frequency
            and current["email_hash"] == address_hash
        ):
            return public_preference(current)
        renewed = enabled and (
            not current or not current["enabled"] or current["email_hash"] != address_hash
        )
        generation = uuid.uuid4() if renewed or not current else current["generation"]
        # The migration trigger commits a pending exact-revision projection in
        # this same transaction. No network call or provider send occurs here.
        row = await conn.fetchrow(
            """INSERT INTO one_marketing_preferences
              (user_id,user_hash,enabled,frequency,revision,generation,disclosure_version,email_hash,consent_at,surface)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN NOW() ELSE $10 END,$11)
            ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,
              frequency=EXCLUDED.frequency,revision=EXCLUDED.revision,generation=EXCLUDED.generation,
              disclosure_version=EXCLUDED.disclosure_version,email_hash=EXCLUDED.email_hash,
              consent_at=EXCLUDED.consent_at,chosen_at=NOW(),surface=EXCLUDED.surface
            RETURNING *""",
            user_id,
            account_deletion_user_hash(user_id),
            enabled,
            frequency,
            revision + 1,
            generation,
            DISCLOSURE_VERSION,
            address_hash,
            renewed,
            current["consent_at"] if current else None,
            surface,
            timeout=5,
        )
    return public_preference(row)


async def revoke_generation(user_hash: str, generation: uuid.UUID):
    """A delayed email-link opt-out cannot cancel a later explicit re-opt-in.

    Frequency changes keep the generation, so they cannot accidentally discard
    a pending opt-out. This backchannel has no subscribe capability.
    """
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        row = await conn.fetchrow(
            "SELECT user_id FROM one_marketing_preferences WHERE user_hash=$1", user_hash, timeout=5
        )
        if not row:
            return {"revoked": False}
        user_id = row["user_id"]
        await _active_owner(conn, user_id)
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,370))", user_id, timeout=5
        )
        changed = await conn.fetchrow(
            """UPDATE one_marketing_preferences SET enabled=FALSE,revision=revision+1,
                 chosen_at=NOW(),surface='email_link'
               WHERE user_id=$1 AND generation=$2 AND enabled RETURNING revision""",
            user_id,
            generation,
            timeout=5,
        )
    return {"revoked": changed is not None}


async def acknowledge(changes: list[tuple[str, int]]):
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await conn.execute(
            """UPDATE one_marketing_changes c SET pending=FALSE,updated_at=NOW()
               FROM unnest($1::text[],$2::bigint[]) AS ack(user_hash,revision)
               WHERE c.user_hash=ack.user_hash AND c.revision=ack.revision""",
            [key for key, _ in changes],
            [revision for _, revision in changes],
            timeout=5,
        )
    return {"received": True}


async def pending_changes():
    """A bounded acknowledged feed; no sequence/commit-order cursor can lose writes."""
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        rows = list(await conn.fetch(PENDING_SQL, timeout=5))
        # Reserve at least five slots for reconciliation, even during signup
        # bursts. Both candidate scans use their own ordered partial index.
        rows.extend(await conn.fetch(RECONCILE_SQL, 25 - len(rows), timeout=5))
        if not rows:
            return {"version": 1, "environment": "production", "changes": []}
        users = [r["user_id"] for r in rows if r["user_id"]]
        if users:
            await AccountDeletionLifecycleService.active_projection_user_ids(conn, user_ids=users)
        # Re-read after the lifecycle barriers; erasure may have committed while
        # the first bounded candidate query waited. Never publish its old UID.
        records = await conn.fetch(
            """SELECT c.user_hash,c.revision,c.erased,p.user_id,p.enabled,p.frequency,
                 p.generation,p.email_hash,p.consent_at,p.chosen_at,p.surface
               FROM one_marketing_changes c LEFT JOIN one_marketing_preferences p USING(user_hash)
               WHERE c.user_hash=ANY($1::text[]) ORDER BY c.updated_at,c.user_hash""",
            [r["user_hash"] for r in rows],
            timeout=5,
        )
    semaphore = asyncio.Semaphore(8)

    async def project(row):
        result = {
            "accountHash": row["user_hash"],
            "revision": row["revision"],
            "erased": row["erased"],
            "enabled": bool(row["enabled"]),
            "eligible": False,
        }
        if row["erased"]:
            return result
        if not row["user_id"]:
            raise RuntimeError("Permission projection is incomplete")
        result.update(
            {
                "generation": str(row["generation"]),
                "frequency": row["frequency"],
                "consentAt": row["consent_at"].isoformat() if row["consent_at"] else None,
                "chosenAt": row["chosen_at"].isoformat(),
                "disclosureVersion": DISCLOSURE_VERSION,
            }
        )
        if not row["enabled"]:
            return result
        try:
            async with semaphore:
                person = await verified_recipient(row["user_id"])
        except VerifiedEmailRequired:
            return result
        if person["email_hash"] != row["email_hash"]:
            return result
        # New means permission was chosen within 24h of canonical Firebase
        # account creation. Setup re-entry and auth isNewUser hints are not proof.
        created = person["created_at"]
        cohort = (
            "new"
            if created and timedelta(0) <= row["consent_at"] - created <= timedelta(days=1)
            else "existing"
        )
        result.update(
            {
                "eligible": True,
                "accountId": row["user_id"],
                "email": person["email"],
                "name": person["name"],
                "cohort": cohort,
            }
        )
        return result

    projected = await asyncio.gather(*(project(row) for row in records))
    # Identity lookups happen outside DB locks. Reacquire deletion barriers and
    # check the exact choice again before exporting any identity. A changed
    # revision stays pending for a fresh projection on the next pull.
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        users = [r["user_id"] for r in records if r["user_id"]]
        active = (
            await AccountDeletionLifecycleService.active_projection_user_ids(conn, user_ids=users)
            if users
            else set()
        )
        latest = await conn.fetch(
            """SELECT c.user_hash,c.revision,c.erased,p.user_id,p.enabled FROM one_marketing_changes c
                 LEFT JOIN one_marketing_preferences p USING(user_hash) WHERE c.user_hash=ANY($1::text[])""",
            [r["user_hash"] for r in records],
            timeout=5,
        )
        by_hash = {r["user_hash"]: r for r in latest}
        changes = []
        for item in projected:
            row = by_hash.get(item["accountHash"])
            if not row:
                raise RuntimeError("Permission projection is incomplete")
            if row["erased"] or (row["user_id"] and row["user_id"] not in active):
                changes.append(
                    {
                        "accountHash": row["user_hash"],
                        "revision": row["revision"],
                        "erased": True,
                        "enabled": False,
                        "eligible": False,
                    }
                )
            elif row["revision"] == item["revision"]:
                changes.append(item)
        checked_at = datetime.now(timezone.utc).isoformat()
        for item in changes:
            item["checkedAt"] = checked_at
    return {"version": 1, "environment": "production", "changes": changes}


async def current_permission(user_id: str, generation: uuid.UUID, email_hash: str, revision: int):
    """Fresh permission/address check before Matrix attempts an outbound send."""
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        active = await AccountDeletionLifecycleService.active_projection_user_ids(
            conn, user_ids=[user_id]
        )
        if user_id not in active:
            return {"allowed": False, "erased": True}
        row = await conn.fetchrow(
            "SELECT enabled,generation,email_hash,revision FROM one_marketing_preferences WHERE user_id=$1",
            user_id,
            timeout=5,
        )
        if (
            not row
            or not row["enabled"]
            or row["generation"] != generation
            or row["email_hash"] != email_hash
            or row["revision"] != revision
        ):
            return {"allowed": False, "erased": False}
    try:
        recipient = await verified_recipient(user_id)
    except VerifiedEmailRequired:
        return {"allowed": False, "erased": False}
    if recipient["email_hash"] != email_hash:
        return {"allowed": False, "erased": False}
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        active = await AccountDeletionLifecycleService.active_projection_user_ids(
            conn, user_ids=[user_id]
        )
        if user_id not in active:
            return {"allowed": False, "erased": True}
        # A revocation can arrive during the identity lookup. Re-check its
        # generation and enabled state after that lookup, not from a cached row.
        allowed = await conn.fetchval(
            """SELECT EXISTS(SELECT 1 FROM one_marketing_preferences WHERE user_id=$1
                 AND enabled AND generation=$2 AND email_hash=$3 AND revision=$4)""",
            user_id,
            generation,
            email_hash,
            revision,
            timeout=5,
        )
    return {"allowed": bool(allowed), "erased": False}


async def permitted_snapshot_accounts(user_ids: list[str]) -> set[str]:
    """Extend the bounded exporter cohort from canonical recorded permission."""
    if not user_ids:
        return set()
    if len(user_ids) > 20:
        raise ValueError("Snapshot permission batch exceeds its bound")
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        active = await AccountDeletionLifecycleService.active_projection_user_ids(
            conn, user_ids=user_ids
        )
        rows = await conn.fetch(
            "SELECT user_id FROM one_marketing_preferences WHERE user_id=ANY($1::text[]) AND enabled",
            sorted(active),
            timeout=5,
        )
    return {row["user_id"] for row in rows}
