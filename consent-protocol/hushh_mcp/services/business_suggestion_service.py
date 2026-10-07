"""Owner-bound B2B discovery. No directory, profile or PKM writes."""

from __future__ import annotations

import asyncio
from typing import Any

from starlette.concurrency import run_in_threadpool

from api.utils.firebase_admin import get_firebase_auth_app
from db.db_client import get_db
from hushh_mcp.runtime_settings import (
    one_business_directory_enabled,
    one_business_local_rehearsal_enabled,
    one_business_uat_fixture_enabled,
)
from hushh_mcp.services.business_directory_suggestions import (
    DirectoryUnavailable,
    lookup_directory,
    verified_contacts,
)


class BusinessSuggestionUnavailable(RuntimeError):
    """Current verified identity could not be established; never use cached identity."""


def _setup_resolved(user_id: str) -> bool:
    # Read canonical setup state without creating a placeholder or changing login metadata.
    rows = (
        get_db().table("vault_keys").select("setup_completed,vault_status")
        .eq("user_id", user_id).limit(1).execute().data
    )
    return bool(rows and rows[0].get("setup_completed") is True
                and rows[0].get("vault_status") == "active")


def build_uat_business_candidate() -> dict[str, Any]:
    """A stable test identity, never a claimant UID or production directory row."""
    return {
        "business_uid": "urn:hushh:business:uat:hushh.ai:v1",
        "synthetic": True,
        "source_identity": {"source": "uat_fixture", "source_key": "hushh.ai:v1"},
        "match_evidence": [{"kind": "verified_email_domain", "domain": "hushh.ai"}],
        # Rich but unmistakably synthetic data lets the whole review card and
        # PKM preview be exercised without presenting invented production facts
        # as a real company record.
        "draft": {
            "name": "Hushh — UAT Test Business",
            "category": "Software company · Private intelligence",
            "formatted_address": "100 UAT Test Avenue, Austin, TX 78701",
            "phone": "+1 202-555-0147",
            "website": "https://hushh.ai",
            "hours": "Mon–Fri · 9:00 AM–5:00 PM (UAT fixture)",
            "about": "Synthetic UAT business used to verify business-profile matching, review, and explicit save flows.",
        },
        "ownership_verified": False,
        "claim_created": False,
        "verification_required": ["business_authority"],
    }


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
    if not (real_enabled or one_business_uat_fixture_enabled() or
            one_business_local_rehearsal_enabled(user_id, loopback=local_loopback)):
        return result
    try:
        record = await asyncio.wait_for(
            run_in_threadpool(_lookup_identity, user_id), timeout=5
        )
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    # A fresh primary Firebase email, not token claims, aliases or request input.
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise BusinessSuggestionUnavailable()
    email = getattr(record, "email", None)
    if real_enabled:
        result["contract_version"] = "b2b-profile-suggestion.v2"
        try:
            resolved = await asyncio.wait_for(run_in_threadpool(_setup_resolved, user_id), 5)
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
            # Real mode never falls back to a synthetic match, including on outage.
            result.update(await lookup_directory(*contacts, local=(local_loopback and
                one_business_local_rehearsal_enabled(user_id, loopback=local_loopback))))
        except DirectoryUnavailable:
            raise BusinessSuggestionUnavailable() from None
        return result
    eligible = (
        getattr(record, "email_verified", False) is True
        and isinstance(email, str)
        and email.count("@") == 1
        and bool(email.split("@")[0])
        and not any(char.isspace() for char in email)
        and email.split("@")[1].lower() == "hushh.ai"
    )
    result["status"] = "suggestion_available" if eligible else "no_match"
    if eligible:
        try:
            resolved = await asyncio.wait_for(run_in_threadpool(_setup_resolved, user_id), 5)
        except Exception:
            raise BusinessSuggestionUnavailable() from None
        if resolved:
            result["candidates"] = [build_uat_business_candidate()]
        else:
            result["status"] = "no_match"
    return result
