"""Canonical verified-phone write using caller-owned identity service ports."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import asyncpg
from fastapi import HTTPException

if TYPE_CHECKING:
    from hushh_mcp.services.phone_transfer_service import ConfirmedTransfer
logger = logging.getLogger("hushh_mcp.services.actor_identity_service")

claim_insert_with_custom_photo = """
    INSERT INTO actor_identity_cache (
      user_id, phone_number, phone_verified, source,
      last_synced_at, created_at, updated_at
    )
    VALUES ($1, $2, TRUE, $3, NOW(), NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      phone_number = EXCLUDED.phone_number,
      phone_verified = TRUE,
      source = $3,
      last_synced_at = NOW(),
      updated_at = NOW()
    RETURNING
      user_id, display_name, email, phone_number,
      COALESCE(custom_photo_url, photo_url) AS photo_url,
      email_verified, phone_verified, source,
      last_synced_at, created_at, updated_at
"""


claim_insert_plain_photo = """
    INSERT INTO actor_identity_cache (
      user_id, phone_number, phone_verified, source,
      last_synced_at, created_at, updated_at
    )
    VALUES ($1, $2, TRUE, $3, NOW(), NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      phone_number = EXCLUDED.phone_number,
      phone_verified = TRUE,
      source = $3,
      last_synced_at = NOW(),
      updated_at = NOW()
    RETURNING
      user_id, display_name, email, phone_number,
      photo_url AS photo_url,
      email_verified, phone_verified, source,
      last_synced_at, created_at, updated_at
"""


async def claim_verified_phone(
    self,
    get_pool,
    *,
    user_id: str,
    phone_number: str,
    source: str = "firebase_phone_claim",
    transfer: ConfirmedTransfer | None = None,
) -> dict[str, Any] | None:
    from hushh_mcp.services.actor_identity_service import ActorIdentityPhoneClaimConflictError

    normalized_user_id = str(user_id or "").strip()
    normalized_phone_number = str(phone_number or "").strip()
    normalized_source = str(source or "").strip() or "firebase_phone_claim"
    if not normalized_user_id or not normalized_phone_number:
        return None

    pool = await get_pool()

    # Two fully static SQL literals (no string interpolation/concatenation,
    # so the query is never dynamically built). They differ only in the
    # RETURNING photo_url projection: the COALESCE variant preserves a custom
    # avatar (post-107); the plain-photo_url variant keeps the phone claim
    # working during the 107 migration gap (no custom avatar can exist yet).

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                if transfer is not None:
                    from hushh_mcp.services.phone_transfer_service import consume, lock_transfer

                    await lock_transfer(conn, normalized_user_id, transfer)
                await self._ensure_actor_spine(conn, normalized_user_id)
                if transfer is not None:
                    await consume(conn, normalized_user_id, normalized_phone_number, transfer)
                phone_write_allowed = await self._lock_and_clear_verified_phone_binding(
                    conn,
                    user_id=normalized_user_id,
                    phone_number=normalized_phone_number,
                    # Fixed test codes do not prove fresh phone possession.
                    # Only the Firebase phone-token route can transfer a
                    # verified owner; retries by the same owner remain valid.
                    allow_owner_transfer=transfer is not None,
                )
                if not phone_write_allowed:
                    raise ActorIdentityPhoneClaimConflictError()
                row = await _write_claim(
                    conn, normalized_user_id, normalized_phone_number, normalized_source
                )
    except (ActorIdentityPhoneClaimConflictError, HTTPException):
        raise
    except (asyncpg.UndefinedTableError, asyncpg.UndefinedColumnError):
        logger.debug("actor_identity_cache phone claim skipped; phone shadow schema unavailable")
        return None
    except Exception as exc:
        logger.debug(
            "actor_identity_cache phone claim skipped error=%s",
            type(exc).__name__,
        )
        return None

    # Phone-verify seam: provisioning and the resume run in the background, never in the claim.
    try:
        self.schedule_provision_personal_agent(normalized_user_id, normalized_phone_number)
    except Exception:  # noqa: S110 -- provisioning kickoff must never break phone verify
        pass
    self._schedule_phone_resume(normalized_user_id, normalized_phone_number)
    await self._sync_referral_qualification_best_effort(normalized_user_id)

    return self._normalize_row(row)


async def _write_claim(conn, user_id: str, phone_number: str, source: str):
    try:
        # The nested transaction is an asyncpg savepoint. If
        # custom_photo_url is absent during a rolling migration,
        # it clears the failed statement before the fallback.
        async with conn.transaction():
            # Preserve a custom avatar in the returned (and client-cached)
            # identity, matching get_many/upsert_identity/set_custom_photo_url.
            row = await conn.fetchrow(
                claim_insert_with_custom_photo,
                user_id,
                phone_number,
                source,
            )
    except asyncpg.UndefinedColumnError as exc:
        if "custom_photo_url" not in str(exc):
            raise
        # Pre-107 gap: no custom avatar can exist yet, so the plain
        # photo_url is equivalent — keep the phone claim working.
        row = await conn.fetchrow(
            claim_insert_plain_photo,
            user_id,
            phone_number,
            source,
        )
    return row
