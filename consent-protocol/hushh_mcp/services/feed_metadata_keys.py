"""Bounded, presentation-only Feed metadata keys shared by domain readers."""

from hushh_mcp.services.feed_counterpart_projection import (
    COUNTERPART_PHOTO_KEY as _COUNTERPART_PHOTO_KEY,
)
from hushh_mcp.services.feed_counterpart_projection import (
    COUNTERPART_PROFILE_KEY as _COUNTERPART_PROFILE_KEY,
)

FEED_METADATA_KEYS = frozenset(
    {
        "advisorReviewId",
        "viewerRole",
        "scope_description",
        "scope",
        "counterpart_label",
        _COUNTERPART_PHOTO_KEY,
        _COUNTERPART_PROFILE_KEY,
        "display_name",
        "first_name",
        "feed_audience",
        "reason",
        "duration_mode",
        "duration_hours",
        "requested_duration_mode",
        "requested_duration_hours",
        "is_extension",
        "request_id",
        "grant_id",
        "referral_id",
        "direction",
        "owner_label",
        "public_location_view",
        "submission_id",
        "circle_name",
        "circle_id",
        "invite_id",
        "added_by_label",
        "ticker",
        # The Kai run a completion item announces, so the Feed opens that run's
        # own saved result. An opaque id owned by the same person.
        "run_id",
        "draft_id",
        "pwm_outcome",
        "user_facing_status",
        # Read-time status of a historical payment instruction. The source
        # order and request remain authoritative; this bounded projection
        # prevents an old Pay row from surviving payment or expiry.
        "current_request_status",
        "current_payment_status",
        "current_checkout_expired",
        "current_request_expired",
        "current_access_stopped",
        "current_checkout_expires_at",
        "current_request_expires_at",
        "owner_payout_status",
        "owner_payout_account_ready",
        "current_owner_payout_account_ready",
        "owner_earning_cents",
        "current_refund_amount_cents",
        "current_payment_amount_cents",
        # The requester's shared payment view state (drive_request_payment_view):
        # one closed enum, so a Pay row and its history line cannot disagree.
        "current_payment_state",
        "new_status",
        "actor_is_self",
        # Which lane a location share belongs to ("sos" vs everything else).
        # Without it the Feed cannot tell an emergency apart from an ordinary
        # share and narrates both as "shared location, then stopped" -- the
        # one row where that distinction matters most. A short, bounded enum
        # written by our own service, carrying nothing about the person.
        "share_kind",
        "person_ref",
        "bundle_id",
        # One Feed item per person-to-person request (migration 259): which
        # request it is, and what was asked for in human words, so the item
        # reads "<Name> wants your <labels> · <reason>" and can act inline.
        "requested_labels",
        "requested_count",
        # The owner's one "One sent N files to B" card per Drive request
        # (drive_owner_shared_files): a count only, never a file name.
        "shared_count",
    }
)
