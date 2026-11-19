"""A Google-verified Calendar email becomes a verified alias of the One account that connected it.

Only the owner's own live Google check calls this, after Google reported the
profile's email as verified for the connected subject. The alias is registered
for that exact One account through the existing alias service; it never moves
an alias between accounts, never revives one the person removed, and never makes
Calendar fail. Calendar organizer resolution already recognises verified aliases,
so an invitation from this email then reaches the connected person's One account.

The service's own ceremony runs in-process rather than being skipped: it issues
its one-time code for this exact account and address, and that same code is
consumed at once to confirm. Google's verification is what authorises doing so;
no email is sent and the service's checks (code hash, expiry, another account's
verified alias, the one-verified-owner index) all still apply. The service's
`accept_without_code` escape hatch is deliberately not used: it is for callers
that cannot produce a code, and the confirmation still hashes the code first, so
an empty one is rejected with EMAIL_ALIAS_CODE_REQUIRED.
"""

from __future__ import annotations

import logging

from hushh_mcp.services.actor_identity_service import ActorIdentityAliasError, ActorIdentityService

logger = logging.getLogger(__name__)

# The alias table accepts a closed set of sources and has no Google value; the
# proof is the person's own authenticated Google consent, so it is recorded as
# their verification and the provenance travels in `source_ref`.
_SOURCE = "user_verified"
_SOURCE_REF = "google_calendar_oauth"


async def record_google_verified_alias(
    *, user_id: str, email: str, identity: ActorIdentityService | None = None
) -> bool:
    """True when this account holds a verified alias for the email after the call."""
    address = str(email or "").strip().lower()
    if not user_id or not address:
        return False
    service = identity or ActorIdentityService()
    try:
        for alias in await service.list_verified_email_aliases(user_id):
            if alias.get("email_normalized") != address:
                continue
            if alias.get("verification_status") == "verified" and alias.get("revoked_at") is None:
                return True
            if alias.get("verification_status") == "revoked" or alias.get("revoked_at") is not None:
                return False  # the person removed it; a later Google check does not revive it
        requested = await service.request_email_alias_verification(
            user_id=user_id,
            email=address,
            verification_source=_SOURCE,
            source_ref=_SOURCE_REF,
            include_plaintext_code=True,  # route-internal; consumed below, never stored or logged
        )
        if requested.get("already_verified"):
            return True
        code = requested.get("verification_code_plaintext")
        if not code:
            return False
        await service.confirm_email_alias_verification(
            user_id=user_id, email=address, verification_code=code
        )
        return True
    except ActorIdentityAliasError as error:
        # Only an address another account already holds, or one that is not usable, is
        # expected; any other refusal means the integration itself is broken.
        quiet = error.code in {"EMAIL_ALIAS_ALREADY_VERIFIED", "EMAIL_ALIAS_INVALID"}
        (logger.info if quiet else logger.warning)(
            "calendar_verified_alias skipped code=%s", error.code.lower()
        )
    except Exception:
        logger.warning("calendar_verified_alias unavailable")
    return False
