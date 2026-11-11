"""Drive route authority, placement freshness and authored private error responses."""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Response

from api.middleware import require_vault_owner_token
from hushh_mcp.services.drive_sharing_contract import CALENDAR_REFUSAL_REASONS
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import admit_hub_content, hub_content_owner

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


@dataclass(frozen=True)
class Owner:
    user_id: str
    token: str = field(repr=False)

    async def require_current(self):
        # No Request argument: bypass the request-local scope cache after I/O.
        current = await require_vault_owner_token(
            authorization=f"Bearer {self.token}", hushh_consent=None
        )
        if current.get("user_id") != self.user_id:
            raise HTTPException(403, "Owner identity mismatch", headers=NO_STORE)


async def _owner(response: Response, token: dict = Depends(require_vault_owner_token)):
    response.headers.update(NO_STORE)
    user_id = token.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(401, "Owner authorization required", headers=NO_STORE)
    return Owner(user_id, token["token"])


@dataclass(frozen=True)
class ContentOwner(Owner):
    async def require_current(self):
        await super().require_current()
        await admit_hub_content(self.user_id, "drive_content")


async def _content_owner(response: Response, token: dict = Depends(hub_content_owner)):
    owner = await _owner(response, token)
    return ContentOwner(owner.user_id, owner.token)


# Authored responses only: raw provider, SQL and credential text never crosses this boundary.
_SHARING_ERRORS = {
    "calendar_organizer_unavailable": (
        409,
        "This organizer cannot receive a One request. Copy your request to share it directly.",
    ),
    "calendar_attendee_required": (
        409,
        "This Google account can't request files for this meeting.",
    ),
    "request_unavailable": (404, "This request is unavailable."),
    "verify_google_identity_required": (
        409,
        "Sign in again with your Google account to request files.",
    ),
    "review_changed": (409, "Refresh and review the exact files again."),
    "source_changed": (409, "The files changed. Prepare a new review."),
    "recipient_changed": (409, "The recipient's Google identity changed."),
    "reconnect_required": (409, "Reconnect the original Drive account."),
    "connection_changed": (409, "The Drive connection changed. Refresh this review."),
    "connection_required": (409, "An active connection with this person is required."),
    "explicit_approval_required": (409, "Review and explicitly approve these files."),
    "confirmation_required": (409, "Review and explicitly confirm this removal."),
    "request_already_decided": (409, "This request already has a decision."),
    "request_paid": (409, "This request was paid or files were shared. Refresh it."),
    "request_changed": (409, "This request changed. Refresh its status."),
    "package_changed": (409, "The document package changed. Review it again."),
    "package_not_ready": (409, "AgentOne is still preparing the document package."),
    "package_not_allowed": (409, "Allow the prepared document package before sharing."),
    "package_review_required": (409, "Review the prepared document package."),
    "package_incomplete": (409, "The document package is incomplete. Refresh its status."),
    "price_changed": (409, "The price changed. Review it again."),
    "payout_unavailable": (503, "Document payments are temporarily unavailable."),
    "revocation_pending": (409, "Removal is pending. Refresh its status."),
    "no_revocable_permissions": (409, "There are no recorded permissions available to remove."),
    "sharing_unavailable": (503, "Document sharing is not available yet."),
    "rule_not_covered": (
        409,
        "Review the complete exact files before trusting future requests.",
    ),
    "rule_changed": (409, "This document trust rule changed. Refresh it."),
    "connector_unavailable": (503, "Document sharing is not available yet."),
    "request_expired": (409, "This question expired."),
    "owner_share_expired": (409, "This search expired. Search your Drive again."),
    "drive_query_unavailable": (503, "Drive didn't answer. Try again."),
    "recipient_google_identity_required": (
        409,
        "Their Google sign-in needs attention in One before files can be shared.",
    ),
    "recipient_verified_email_required": (
        409,
        "They need a verified email in One before files can be shared with them.",
    ),
    "recipient_verification_unavailable": (
        503,
        "Couldn't check their Google account. Try again.",
    ),
    "drive_share_unavailable": (503, "Couldn't prepare these files. Try again."),
    "drive_share_in_progress": (409, "Sharing is already in progress."),
    "bulk_not_found": (404, "This share review is unavailable."),
    "bulk_expired": (410, "This share review expired. Start a new one."),
    "bulk_conflict": (409, "This share review changed. Refresh it."),
    "source_not_shareable": (
        409,
        "Google Drive cannot share one of these files. Refresh the results.",
    ),
    "bulk_changed": (409, "This share review changed. Refresh it."),
    "search_in_progress": (409, "Wait for the complete Drive search before sharing all files."),
    "search_incomplete": (409, "This Drive search is incomplete. Narrow or restart it."),
    "search_not_found": (404, "This Drive search is unavailable."),
    "no_recipients": (409, "No one in your Trusted circle can receive these files yet."),
    "date_range_required": (422, "Choose exact start and end dates before requesting files."),
    "invalid_payment_amount": (422, "Choose a price from $0.50 to $500."),
    "owner_price_required": (409, "Set your request price to continue."),
    "owner_payout_required": (409, "Set up payouts to continue."),
    "invalid_argument": (422, "Check the document-sharing request."),
    "packet_unavailable": (404, "This packet is unavailable."),
    "packet_changed": (409, "This packet changed. Refresh it before continuing."),
    "listing_changed": (409, "The visibility setting changed. Refresh it before continuing."),
    "packet_not_ready": (409, "This packet is still being verified."),
}


# The only diagnostic reasons a client may see, per code.
_CLOSED_REASONS = {
    "invalid_argument": frozenset({"owner_copy_consent_missing", "owner_copy_consent_unexpected"}),
    **CALENDAR_REFUSAL_REASONS,
}


def sharing_error(error: Exception) -> HTTPException:
    code = str(error) if isinstance(error, DriveReadError) else "sharing_unavailable"
    if code not in _SHARING_ERRORS:
        code = "sharing_unavailable"
    status, message = _SHARING_ERRORS[code]
    detail = {"code": code, "message": message}
    # A closed diagnostic explains this refusal without echoing private input.
    reason = getattr(error, "diagnostic_reason", None)
    if isinstance(reason, str) and reason in _CLOSED_REASONS.get(code, ()):
        detail["reason"] = reason
    return HTTPException(status, detail, headers=NO_STORE)
