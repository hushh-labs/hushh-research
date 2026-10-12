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
from hushh_mcp.services.business_profile_completion import business_profile_saved
from hushh_mcp.services.magic_intelligence_admission import (
    magic_intelligence_owner_admitted,
    magic_intelligence_rollout_enabled,
)
from hushh_mcp.services.magic_intelligence_completion import magic_intelligence_saved
from hushh_mcp.services.one_owner_admission import (
    OwnerIdentityUnavailable,
    lookup_fresh_owner_identity,
    owner_setup_resolved,
)


class BusinessSuggestionUnavailable(RuntimeError):
    """Current verified identity could not be established; never use cached identity."""


async def _setup_resolved(user_id: str) -> bool:
    # Preserve the existing business service's provider injection boundary.
    return await owner_setup_resolved(user_id, pool_provider=get_pool)


def _lookup_identity(user_id: str):
    try:
        return lookup_fresh_owner_identity(user_id, app_provider=get_firebase_auth_app)
    except OwnerIdentityUnavailable:
        raise BusinessSuggestionUnavailable() from None


async def get_business_suggestion(user_id: str, *, local_loopback: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "contract_version": "b2b-profile-suggestion.v2",
        "scope": "b2b",
        "status": "disabled",
        "candidates": [],
        "pkm_written": False,
    }
    # Gate BEFORE provider access. A conflicting deployment label always wins.
    real_enabled = one_business_directory_enabled()
    local_rehearsal = one_business_local_rehearsal_enabled(user_id, loopback=local_loopback)
    if not (local_rehearsal or (real_enabled and magic_intelligence_rollout_enabled())):
        return result
    try:
        if await asyncio.wait_for(magic_intelligence_saved(user_id), timeout=5):
            return result  # The optional subsection cannot re-offer completed Magic.
        if await asyncio.wait_for(business_profile_saved(user_id), timeout=5):
            result["status"] = "no_match"
            return result
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    try:
        record = await asyncio.wait_for(run_in_threadpool(_lookup_identity, user_id), timeout=5)
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    # A fresh primary Firebase email, not token claims, aliases or request input.
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise BusinessSuggestionUnavailable()
    if not local_rehearsal and not magic_intelligence_owner_admitted(user_id, record):
        return result
    admitted_email = getattr(record, "email", None)
    admitted_verified = getattr(record, "email_verified", False)
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
        offered = await lookup_directory(*contacts, local=local_rehearsal)
    except DirectoryUnavailable:
        raise BusinessSuggestionUnavailable() from None
    # Both identity and revision policy can change while the provider is running.
    # Withdrawing the localhost exception must not fall through to a hosted grant.
    if local_rehearsal:
        active = one_business_local_rehearsal_enabled(user_id, loopback=local_loopback)
    else:
        active = one_business_directory_enabled() and magic_intelligence_rollout_enabled()
    if not active:
        return result
    try:
        current_record = await asyncio.wait_for(run_in_threadpool(_lookup_identity, user_id), 5)
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    if getattr(current_record, "uid", None) != user_id or getattr(current_record, "disabled", True):
        raise BusinessSuggestionUnavailable()
    try:
        if await asyncio.wait_for(magic_intelligence_saved(user_id), timeout=5):
            return result
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    if local_rehearsal:
        active = (
            one_business_local_rehearsal_enabled(user_id, loopback=local_loopback)
            and getattr(current_record, "email", None) == admitted_email
            and getattr(current_record, "email_verified", False) == admitted_verified
        )
    else:
        active = (
            one_business_directory_enabled()
            and magic_intelligence_owner_admitted(user_id, current_record)
            and getattr(current_record, "email", None) == admitted_email
        )
    if active:
        result.update(offered)
    return result
