"""Fresh account identity and setup admission for independent One features."""

from __future__ import annotations

import os
import re
from collections.abc import Awaitable, Callable
from typing import Any

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool


class OwnerIdentityUnavailable(RuntimeError):
    """The current account identity could not be established."""


async def owner_setup_resolved(
    user_id: str, *, pool_provider: Callable[[], Awaitable[Any]] | None = None, conn: Any = None
) -> bool:
    """Read canonical completion without writes or feature-specific eligibility."""

    async def read(connection):
        return await connection.fetchrow(
            "SELECT setup_completed, vault_status FROM vault_keys WHERE user_id = $1 LIMIT 1",
            user_id,
            timeout=5,
        )

    if conn is not None:
        row = await read(conn)
    else:
        pool = await (pool_provider or get_pool)()
        async with pool.acquire() as connection:
            row = await read(connection)
    return bool(row and row["setup_completed"] is True and row["vault_status"] == "active")


def lookup_fresh_owner_identity(user_id: str, *, app_provider: Callable[[], Any] | None = None):
    """Run this synchronous provider read off the API event loop."""
    # Firebase's shared helper sets a four-second HTTP timeout.
    app = (app_provider or get_firebase_auth_app)()
    if app is None:
        raise OwnerIdentityUnavailable()
    from firebase_admin import auth as firebase_auth

    try:
        return firebase_auth.get_user(firebase_uid_for_owner_read(user_id), app=app)
    except Exception:
        raise OwnerIdentityUnavailable() from None


def firebase_uid_for_owner_read(owner_id: str) -> str:
    """Map the captured owner for an SDK read, never select UID's latest owner.

    Pre-generation installations keep their existing admitted generation-zero
    reads. Replacement IDs always require the installed mapping; generation-aware
    consumers recheck retirement even for generation zero. This is no write grant.
    """
    if os.getenv(
        "ACCOUNT_GENERATION_ADMISSION_ENABLED", ""
    ).strip().lower() == "true" or re.fullmatch(r"acct_[0-9a-f]{32}", owner_id):
        from hushh_mcp.services.account_generation_service import AccountGenerationService

        return AccountGenerationService.firebase_identity_for_owner(owner_id)
    return owner_id


def firebase_record_matches_owner(owner_id: str, record: Any) -> bool:
    """Check a freshly looked-up SDK record without renaming its external UID."""
    return getattr(record, "uid", None) == firebase_uid_for_owner_read(owner_id)


def firebase_uids_for_owner_reads(owner_ids: list[str]) -> dict[str, str]:
    if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() == "true" or any(
        re.fullmatch(r"acct_[0-9a-f]{32}", owner) for owner in owner_ids
    ):
        from hushh_mcp.services.account_generation_service import AccountGenerationService

        return AccountGenerationService.firebase_identities_for_owners(owner_ids)
    return {owner: owner for owner in owner_ids}
