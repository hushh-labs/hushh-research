"""Explicit area consent over the existing One identity; no private-memory reads.

Postgres is the cross-instance authority for consent, CAS and search budgets.
A future Redis budget adapter must preserve atomic limits; positive discovery
results must never be cached independently of consent/lifecycle revisions.
"""

from __future__ import annotations

import asyncio
from typing import Any

from db.connection import get_pool
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.area_discovery_policy import (
    CONSENT_VERSION,
    DAILY_SEARCH_LIMIT,
    MAX_CANDIDATES,
    AreaDiscoveryError,
    postal_area,
    result_page,
)
from hushh_mcp.services.directory_identity_service import (
    DirectoryIdentityUnavailableError,
    active_directory_user_ids,
    directory_auth_profiles,
)
from hushh_mcp.services.requester_identity import label_from_identity_row


async def _active_owner(conn, uid: str):
    if uid not in await AccountDeletionLifecycleService.active_projection_user_ids(
        conn, user_ids=[uid]
    ):
        raise AreaDiscoveryError("ACCOUNT_UNAVAILABLE", "Account unavailable.", 403)


async def _identity(conn, uid: str, *, recover: bool = True):
    row = await conn.fetchrow(
        """SELECT a.user_id,i.display_name,
        EXISTS(SELECT 1 FROM vault_keys v WHERE v.user_id=a.user_id
          AND v.vault_status='active' AND v.environment_enrolled_at IS NOT NULL) AS enrolled
        FROM actor_profiles a LEFT JOIN actor_identity_cache i USING(user_id)
        WHERE a.user_id=$1 AND a.public_profile_status='active'""",
        uid,
        timeout=5,
    )
    name = label_from_identity_row(dict(row) if row else None, allow_email_handle=False)
    if not name and recover:
        profiles = await asyncio.wait_for(asyncio.to_thread(directory_auth_profiles, [uid]), 10)
        name = profiles.get(uid, {}).get("display_name", "")
    return name, bool(row and row["enrolled"])


def _view(row, name: str, enrolled: bool):
    return {
        "enabled": bool(row and row["enabled"]),
        "postalCode": row["postal_code"] if row else None,
        "revision": row["revision"] if row else 0,
        "consentVersion": CONSENT_VERSION,
        "displayName": name or None,
        "canEnable": bool(name and enrolled),
        "unavailableReason": None
        if name and enrolled
        else "name_required"
        if not name
        else "vault_not_connected",
        "ageBasis": "self_declared" if row and row["adult_self_attested_at"] else None,
    }


async def preference(uid: str) -> dict[str, Any]:
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _active_owner(conn, uid)
        identity_unavailable = False
        try:
            name, enrolled = await _identity(conn, uid)
        except (DirectoryIdentityUnavailableError, TimeoutError):
            name, enrolled = await _identity(conn, uid, recover=False)
            identity_unavailable = True
        row = await conn.fetchrow(
            "SELECT * FROM one_area_discovery_preferences WHERE user_id=$1", uid, timeout=5
        )
        result = _view(row, name, enrolled)
        if identity_unavailable:
            result["unavailableReason"] = "identity_unavailable"
        return result


async def choose_preference(
    uid: str,
    *,
    enabled: bool,
    postal_code: str | None,
    expected_revision: int,
    consent_version: str,
    adult_confirmed: bool,
):
    if enabled:
        postal_area(postal_code or "")
        if consent_version != CONSENT_VERSION or adult_confirmed is not True:
            raise AreaDiscoveryError(
                "CONSENT_REQUIRED", "Confirm you are 18 or older and choose area discovery."
            )
        active = await asyncio.wait_for(
            asyncio.to_thread(active_directory_user_ids, [uid], use_cache=False), 10
        )
        if uid not in active:
            raise AreaDiscoveryError("ACCOUNT_UNAVAILABLE", "Account unavailable.", 403)
    # Off never depends on Firebase lookup, ZIP, adult confirmation or vault unlock.
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _active_owner(conn, uid)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,412))", uid, timeout=5)
        current = await conn.fetchrow(
            "SELECT * FROM one_area_discovery_preferences WHERE user_id=$1 FOR UPDATE",
            uid,
            timeout=5,
        )
        if expected_revision != (current["revision"] if current else 0):
            raise AreaDiscoveryError(
                "PREFERENCE_CHANGED", "Your area settings changed. Refresh and choose again.", 409
            )
        name, enrolled = await _identity(conn, uid, recover=enabled)
        if enabled and not (name and enrolled):
            raise AreaDiscoveryError(
                "PROFILE_REQUIRED",
                "Refresh your shared One profile and check its name and vault connection.",
                409,
            )
        row = await conn.fetchrow(
            """INSERT INTO one_area_discovery_preferences
            (user_id,enabled,postal_code,revision,consent_version,adult_self_attested_at,consent_at)
            VALUES($1,$2,$3,$4,$5,CASE WHEN $2 THEN NOW() END,CASE WHEN $2 THEN NOW() END)
            ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,postal_code=EXCLUDED.postal_code,
            revision=EXCLUDED.revision,consent_version=EXCLUDED.consent_version,
            adult_self_attested_at=EXCLUDED.adult_self_attested_at,consent_at=EXCLUDED.consent_at,updated_at=NOW()
            RETURNING *""",
            uid,
            enabled,
            postal_code if enabled else None,
            expected_revision + 1,
            CONSENT_VERSION,
            timeout=5,
        )
        return _view(row, name, enrolled)


async def _charge_search(uid: str):
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _active_owner(conn, uid)
        if not (await _identity(conn, uid))[1]:
            raise AreaDiscoveryError(
                "PROFILE_REQUIRED", "Connect your existing One vault before searching by area.", 409
            )
        await conn.execute(
            "DELETE FROM one_area_discovery_search_budgets WHERE user_id=$1 AND bucket_date < (NOW() AT TIME ZONE 'UTC')::date-2",
            uid,
            timeout=5,
        )
        charged = await conn.fetchval(
            """INSERT INTO one_area_discovery_search_budgets(user_id) VALUES($1)
            ON CONFLICT(user_id,bucket_date) DO UPDATE SET searches=one_area_discovery_search_budgets.searches+1
            WHERE one_area_discovery_search_budgets.searches < $2 RETURNING searches""",
            uid,
            DAILY_SEARCH_LIMIT,
            timeout=5,
        )
        if charged is None:
            raise AreaDiscoveryError(
                "SEARCH_LIMIT", "Your area-search limit is reached. Try again tomorrow.", 429
            )


async def search(uid: str, *, postal_code: str, page: int):
    postal_area(postal_code)
    result_page([], page)  # Reject unbounded page requests before charging.
    await _charge_search(uid)
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await _active_owner(conn, uid)
        # Share-lock consent rows until the response projection is complete.
        # An opt-out waits for an already admitted read; every read beginning
        # after opt-out commits excludes that row, without a positive cache.
        rows = await conn.fetch(
            """SELECT p.user_id,i.display_name,
            CASE WHEN EXISTS(SELECT 1 FROM connections c WHERE c.status='active'
              AND ((c.user_a_id=$1 AND c.user_b_id=p.user_id) OR (c.user_b_id=$1 AND c.user_a_id=p.user_id)))
              THEN 'connected'
              WHEN EXISTS(SELECT 1 FROM connection_requests r WHERE r.status='pending' AND r.requester_user_id=$1 AND r.addressee_user_id=p.user_id) THEN 'pending_outgoing'
              WHEN EXISTS(SELECT 1 FROM connection_requests r WHERE r.status='pending' AND r.addressee_user_id=$1 AND r.requester_user_id=p.user_id) THEN 'pending_incoming'
              ELSE 'none' END AS relationship
            FROM one_area_discovery_preferences p JOIN actor_profiles a USING(user_id)
            LEFT JOIN actor_identity_cache i USING(user_id)
            JOIN vault_keys v USING(user_id)
            WHERE p.enabled AND p.postal_code=$2 AND p.user_id<>$1
              AND p.consent_version=$3 AND p.adult_self_attested_at IS NOT NULL
              AND a.public_profile_status='active' AND v.vault_status='active'
              AND v.environment_enrolled_at IS NOT NULL
              AND NOT EXISTS(SELECT 1 FROM account_deletion_tombstones t
                WHERE t.user_id_hash='sha256:' || encode(digest(p.user_id,'sha256'),'hex'))
            ORDER BY p.user_id LIMIT $4 FOR SHARE OF p""",
            uid,
            postal_code,
            CONSENT_VERSION,
            MAX_CANDIDATES,
            timeout=5,
        )
        ids = [r["user_id"] for r in rows]
        active = await asyncio.wait_for(
            asyncio.to_thread(active_directory_user_ids, [uid, *ids], use_cache=False), 15
        )
        if uid not in active:
            raise AreaDiscoveryError("ACCOUNT_UNAVAILABLE", "Account unavailable.", 403)
        missing = [
            r["user_id"]
            for r in rows
            if r["user_id"] in active
            and not label_from_identity_row(dict(r), allow_email_handle=False)
        ]
        recovered = (
            await asyncio.wait_for(asyncio.to_thread(directory_auth_profiles, missing), 10)
            if missing
            else {}
        )
        people = []
        for row in rows:
            name = label_from_identity_row(dict(row), allow_email_handle=False) or recovered.get(
                row["user_id"], {}
            ).get("display_name", "")
            if row["user_id"] in active and name:
                people.append(
                    {
                        "userId": row["user_id"],
                        "displayName": name,
                        "relationship": row["relationship"],
                    }
                )
        people.sort(key=lambda person: (person["displayName"].casefold(), person["userId"]))
        return result_page(people, page)
