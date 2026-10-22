"""Owner-only request labels for payout activity and receipts.

A label is the request's purpose, sealed inside its request envelope. It is
opened only for request IDs already on the caller's page, and only when the
authenticated owner owns the request: the SQL filters by owner and the
envelope's authenticated data binds the owner and request again. A label that
cannot be opened reads as no label. Never log envelope contents.

The opening logic is copied from DriveRequestOwnerPayoutService.owner_history,
which keeps its own copy for the earnings list.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import text

MAX_LABEL_CHARS = 120
MAX_LABELS_PER_READ = 200


def open_request_label(cipher: Any, envelope: Any, *, user_id: str, request_id: str) -> str | None:
    """The request purpose in one line, at most 120 characters, else None."""
    from hushh_mcp.services.drive_sharing_contract import DriveSharingError

    try:
        private = cipher.open(envelope, user_id=user_id, resource_id=request_id, purpose="request")
        terms = private.get("purpose")
        purpose = terms.get("purpose") if isinstance(terms, dict) else None
        if isinstance(purpose, str) and purpose.strip():
            return " ".join(purpose.split())[:MAX_LABEL_CHARS]
    except (DriveSharingError, ValueError, TypeError, KeyError, AttributeError):
        # Money history stays readable when an old envelope cannot be opened.
        pass
    return None


def owner_request_labels(
    connection: Any, *, user_id: str, request_ids: Iterable[Any]
) -> dict[str, str | None]:
    """{request_id: label or None} for the owner's own requests among request_ids.

    A request that no longer exists, or that belongs to someone else, is
    absent from the result, so callers can tell "erased" from "unlabelled".
    """
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("invalid owner")
    ids = sorted({str(UUID(str(value))) for value in request_ids if value is not None})
    if not ids:
        return {}
    if len(ids) > MAX_LABELS_PER_READ:
        raise ValueError("too many request labels")
    rows = (
        connection.execute(
            text("""SELECT request_id,request_envelope FROM drive_share_requests
              WHERE request_id=ANY(CAST(:ids AS uuid[])) AND user_id=:owner"""),
            {"ids": ids, "owner": user_id},
        )
        .mappings()
        .all()
    )
    if not rows:
        return {}
    from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher

    cipher = DriveSharingCipher()
    return {
        str(row["request_id"]): open_request_label(
            cipher,
            row["request_envelope"],
            user_id=user_id,
            request_id=str(row["request_id"]),
        )
        for row in rows
    }
