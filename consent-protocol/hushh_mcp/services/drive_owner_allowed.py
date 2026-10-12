"""Owner Allow: explicit per-request authority for automatic document sharing.

A Trusted-circle request receives the sealed ``trusted_auto`` marker when it is
created. A request from any other connection enters the same automatic search,
payment and sharing pipeline only after the owner taps Allow on that one
request. Allow re-seals the request envelope with ``trusted_auto`` plus an
``owner_allowed`` record holding the owner's price.

Every automatic recheck that used to require current Trusted membership accepts
either that membership or a valid owner Allow with an active connection. The
sealed marker is the authority. The plaintext
``drive_share_requests.owner_allowed_at`` column is the Consent Center's
projection hint, and it can only withdraw authority, never grant it: a
disconnect clears it, which ends the Allow for good. Reconnecting never restores
an Allow, as it never restores revoked scope grants or named Circles.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

OWNER_ALLOWED_KEY = "owner_allowed"
OWNER_ALLOWED_VERSION = 1
DEFAULT_PRICE_CENTS = 1000
MIN_OWNER_PRICE_CENTS = 100
MAX_OWNER_PRICE_CENTS = 50_000


def valid_owner_price_cents(value: object) -> bool:
    """Whole US dollars from $1 to $500, as integer cents. Booleans are not prices."""
    return (
        type(value) is int
        and MIN_OWNER_PRICE_CENTS <= value <= MAX_OWNER_PRICE_CENTS
        and value % 100 == 0
    )


def owner_allowed_record(*, amount_cents: int | None, allowed_at: str) -> dict[str, Any]:
    """The sealed record Allow adds next to ``trusted_auto: True``."""
    if amount_cents is not None and not valid_owner_price_cents(amount_cents):
        raise ValueError("invalid owner price")
    return {
        "v": OWNER_ALLOWED_VERSION,
        "amount_cents": amount_cents,
        "allowed_at": allowed_at,
    }


def owner_allowed_marker(private: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the owner's sealed Allow record, or None when absent or malformed.

    A record without the ``trusted_auto`` marker beside it is not authority.
    """
    marker = private.get(OWNER_ALLOWED_KEY)
    if (
        not isinstance(marker, Mapping)
        or marker.get("v") != OWNER_ALLOWED_VERSION
        or private.get("trusted_auto") is not True
    ):
        return None
    amount = marker.get("amount_cents")
    if amount is not None and not valid_owner_price_cents(amount):
        return None
    return dict(marker)


def owner_allowed_price_cents(private: Mapping[str, Any]) -> int | None:
    """The owner's chosen price, or None for a free or non-allowed request."""
    marker = owner_allowed_marker(private)
    return None if marker is None else marker.get("amount_cents")


def request_connection_current(
    connection: Any, owner: str, recipient: str, request_id: str
) -> bool:
    """The pair is connected, the requester is admitted, and no disconnect ended this Allow."""
    if owner == recipient or not connector_feature_enabled("drive_document_sharing", recipient):
        return False
    return bool(
        connection.execute(
            text("""
            SELECT EXISTS(SELECT 1 FROM connections
              WHERE status='active' AND ((user_a_id=:owner AND user_b_id=:recipient)
                OR (user_b_id=:owner AND user_a_id=:recipient)))
              AND EXISTS(SELECT 1 FROM drive_share_requests
                WHERE request_id=:request AND user_id=:owner
                  AND recipient_user_id=:recipient AND owner_allowed_at IS NOT NULL)
        """),
            {"owner": owner, "recipient": recipient, "request": str(request_id)},
        ).scalar_one()
    )


def automatic_recipient_current(
    connection: Any, owner: str, recipient: str, private: Mapping[str, Any], *, request_id: str
) -> bool:
    """Recheck for automatic work: current Trusted membership, or this request's owner Allow."""
    from hushh_mcp.services.drive_sharing_store import DriveSharingStore

    if DriveSharingStore._trusted_recipient_current(connection, owner, recipient):
        return True
    return owner_allowed_marker(private) is not None and request_connection_current(
        connection, owner, recipient, request_id
    )


def end_owner_allows_for_disconnected_pair(
    connection: Any, *, user_a_id: str, user_b_id: str
) -> int:
    """End every owner Allow between two people, inside their disconnect transaction.

    Clearing ``owner_allowed_at`` withdraws the Allow from every automatic
    recheck, and nothing sets it again. A pending automatic request returns to
    the owner's manual review, as a Trusted request does when its Trusted
    relationship changes. Nothing is shared, revoked or announced here.
    """
    if not user_a_id or not user_b_id or user_a_id == user_b_id:
        return 0
    # Databases before migration 291 have no Allow to end.
    if not connection.execute(
        text("""SELECT EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid=to_regclass('drive_share_requests')
            AND attname='owner_allowed_at' AND NOT attisdropped)""")
    ).scalar_one():
        return 0
    ended = connection.execute(
        text("""
        UPDATE drive_share_requests SET owner_allowed_at=NULL,
          preparation_error_code=CASE
            WHEN status='pending' AND preparation_error_code IN
              ('trusted_auto_queued','trusted_auto_active','background_preparation_required')
            THEN 'trusted_relationship_changed' ELSE preparation_error_code END,
          updated_at=clock_timestamp()
        WHERE owner_allowed_at IS NOT NULL
          AND ((user_id=:a AND recipient_user_id=:b) OR (user_id=:b AND recipient_user_id=:a))
        RETURNING request_id
    """),
        {"a": user_a_id, "b": user_b_id},
    )
    return len(ended.all())
