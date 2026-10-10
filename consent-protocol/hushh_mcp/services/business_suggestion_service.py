"""Owner-bound B2B discovery. No directory, profile or PKM writes."""

from __future__ import annotations

import asyncio
from typing import Any

from starlette.concurrency import run_in_threadpool

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool
from hushh_mcp.runtime_settings import (
    one_business_directory_enabled,
    one_business_local_rehearsal_enabled,
)
from hushh_mcp.services.business_directory_suggestions import (
    DirectoryUnavailable,
    lookup_directory,
    verified_contacts,
)


class BusinessSuggestionUnavailable(RuntimeError):
    """Current verified identity could not be established; never use cached identity."""


async def _setup_resolved(user_id: str) -> bool:
    # Read canonical setup state without creating a placeholder or changing login metadata.
    # Fresh admission must not queue behind the synchronous Location projection.
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT setup_completed, vault_status FROM vault_keys WHERE user_id = $1 LIMIT 1",
            user_id,
        )
    return bool(row and row["setup_completed"] is True and row["vault_status"] == "active")


def _lookup_identity(user_id: str):
    # Both Admin initialization and its synchronous provider I/O stay off the
    # API event loop. Firebase's shared helper sets a four-second HTTP timeout.
    app = get_firebase_auth_app()
    if app is None:
        raise BusinessSuggestionUnavailable()
    from firebase_admin import auth as firebase_auth

    return firebase_auth.get_user(user_id, app=app)


async def get_business_suggestion(user_id: str, *, local_loopback: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "contract_version": "b2b-profile-suggestion.v1",
        "scope": "b2b",
        "status": "disabled",
        "candidates": [],
        "pkm_written": False,
    }
    # Gate BEFORE provider access. A conflicting deployment label always wins.
    real_enabled = one_business_directory_enabled()
    local_rehearsal = one_business_local_rehearsal_enabled(user_id, loopback=local_loopback)
    if not (real_enabled or local_rehearsal):
        return result
    try:
        record = await asyncio.wait_for(run_in_threadpool(_lookup_identity, user_id), timeout=5)
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    # A fresh primary Firebase email, not token claims, aliases or request input.
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise BusinessSuggestionUnavailable()
    result["contract_version"] = "b2b-profile-suggestion.v2"
    try:
        resolved = await asyncio.wait_for(_setup_resolved(user_id), 5)
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    if not resolved:
        result["status"] = "no_match"
        return result
    phone = getattr(record, "phone_number", None)
    if not phone:
        # The account OTP flow may claim a phone without linking it to the
        # primary Firebase account. Its canonical verified shadow is valid;
        # unverified profile fields and aliases are never substituted.
        from hushh_mcp.services.actor_identity_service import ActorIdentityService

        try:
            identities = await asyncio.wait_for(ActorIdentityService().get_many([user_id]), 5)
            identity = identities.get(user_id, {})
            if identity.get("phone_verified") is True:
                phone = identity.get("phone_number")
        except Exception:
            raise BusinessSuggestionUnavailable() from None
    contacts = verified_contacts(record, phone=phone)
    if contacts is None:
        result["status"] = "insufficient_signals"
        return result
    try:
        # Local rehearsal and hosted UAT/production use the same directory
        # lookup and response contract. There is no email-specific fixture or
        # synthetic fallback in this path.
        result.update(await lookup_directory(*contacts, local=local_rehearsal))
    except DirectoryUnavailable:
        raise BusinessSuggestionUnavailable() from None
    return result
