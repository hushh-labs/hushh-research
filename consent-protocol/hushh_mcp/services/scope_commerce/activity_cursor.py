"""Bounded subject/view-bound keyset cursor; never access authority."""

import base64
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from .domain import CommerceError, fingerprint

KINDS = {"purchase", "funding", "refund", "withdrawal"}


def decode_cursor(cursor: str | None, viewer: str, view: str) -> tuple[datetime, str, str] | None:
    if cursor is None:
        return None
    try:
        if not isinstance(cursor, str) or len(cursor) > 1024:
            raise ValueError
        row = json.loads(
            base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        )
        if (
            set(row) != {"v", "subject", "view", "at", "kind", "id"}
            or type(row["v"]) is not int
            or row["v"] != 1
            or row["subject"] != fingerprint(viewer)
            or row["view"] != view
            or row["kind"] not in KINDS
        ):
            raise ValueError
        at = datetime.fromisoformat(row["at"])
        if at.tzinfo is None:
            raise ValueError
        return at, row["kind"], str(UUID(row["id"]))
    except (ValueError, TypeError, KeyError):
        raise CommerceError("invalid_activity_cursor") from None


def encode_cursor(row: Any, viewer: str, view: str) -> str:
    payload = {
        "v": 1,
        "subject": fingerprint(viewer),
        "view": view,
        "at": row["created_at"].isoformat(),
        "kind": row["kind"],
        "id": str(row["id"]),
    }
    return (
        base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )
