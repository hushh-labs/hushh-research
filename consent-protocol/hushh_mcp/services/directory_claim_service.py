"""White Pages listing claims: a One user says "this public listing is me".

A claim starts 'pending'. A verified phone proves who holds the phone, not who
the listed person is, so only an operator moves a claim to 'verified' after
checking it against the listing's public record. Only a verified claim makes the
owner's for-sale packets visible on the listing. Migration 265.

A person holds one active claim (pending or verified); a listing has at most one
verified owner. The public lookup never returns a user id.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime
from typing import Any

from db.db_client import get_db

logger = logging.getLogger(__name__)

TABLE = "directory_listing_claims"
ACTIVE = ("pending", "verified")
LISTING_ID_RE = re.compile(r"^[a-z0-9][a-z0-9:-]{0,127}$")
MAX_PUBLIC_LOOKUP = 60


class ClaimError(ValueError):
    """A claim the caller cannot make; code is stable, message is safe to show."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def normalize_listing_id(value: Any) -> str:
    listing_id = str(value or "").strip().lower()
    if not LISTING_ID_RE.match(listing_id):
        raise ClaimError("INVALID_LISTING_ID", "That listing id is not valid.")
    return listing_id


def _str_or_none(value: Any) -> str | None:
    return None if value is None else str(value)


def _row_to_claim(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _str_or_none(row.get("id")),
        "listingId": row.get("listing_id"),
        "listingName": row.get("listing_name"),
        "status": row.get("status"),
        "createdAt": _str_or_none(row.get("created_at")),
        "resolvedAt": _str_or_none(row.get("resolved_at")),
    }


class DirectoryClaimService:
    def __init__(self) -> None:
        self._db = None

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _execute(self, query):
        return await asyncio.to_thread(query.execute)

    async def _rows(self, query) -> list[dict[str, Any]]:
        return getattr(await self._execute(query), "data", None) or []

    async def active_claim(self, *, user_id: str) -> dict[str, Any] | None:
        rows = await self._rows(
            self.db.table(TABLE)
            .select("*")
            .eq("user_id", user_id)
            .in_("status", list(ACTIVE))
            .limit(1)
        )
        return _row_to_claim(rows[0]) if rows else None

    async def create_claim(
        self, *, user_id: str, listing_id: Any, listing_name: Any
    ) -> dict[str, Any]:
        listing_id = normalize_listing_id(listing_id)
        name = str(listing_name or "").strip()
        if not 1 <= len(name) <= 200:
            raise ClaimError("INVALID_LISTING_NAME", "The listing name is missing.")

        existing = await self.active_claim(user_id=user_id)
        if existing:
            if existing["listingId"] == listing_id:
                return existing  # idempotent: claiming the same listing twice is a no-op
            raise ClaimError(
                "ALREADY_CLAIMED_ANOTHER", "You have already claimed a different listing."
            )

        taken = await self._rows(
            self.db.table(TABLE)
            .select("id")
            .eq("listing_id", listing_id)
            .eq("status", "verified")
            .limit(1)
        )
        if taken:
            raise ClaimError(
                "LISTING_ALREADY_VERIFIED", "This listing already has a verified owner."
            )

        rows = await self._rows(
            self.db.table(TABLE).insert(
                {
                    "user_id": user_id,
                    "listing_id": listing_id,
                    "listing_name": name,
                    "status": "pending",
                }
            )
        )
        logger.info("directory_claim.created listing=%s", listing_id)
        return (
            _row_to_claim(rows[0])
            if rows
            else {"listingId": listing_id, "listingName": name, "status": "pending"}
        )

    async def withdraw_claim(self, *, user_id: str) -> bool:
        rows = await self._rows(
            self.db.table(TABLE)
            .update({"status": "withdrawn", "resolved_at": datetime.now(UTC).isoformat()})
            .eq("user_id", user_id)
            .in_("status", list(ACTIVE))
        )
        return bool(rows)

    async def resolve_claim(
        self, *, claim_id: str, verified: bool, note: str | None = None
    ) -> dict[str, Any] | None:
        """Operator action. Verify or reject a pending claim."""
        rows = await self._rows(
            self.db.table(TABLE)
            .update(
                {
                    "status": "verified" if verified else "rejected",
                    "resolved_at": datetime.now(UTC).isoformat(),
                    "resolution_note": (note or None) and str(note)[:500],
                }
            )
            .eq("id", claim_id)
            .eq("status", "pending")
        )
        return _row_to_claim(rows[0]) if rows else None

    async def verified_owners(self, listing_ids: list[str]) -> dict[str, str]:
        """listing_id -> owner user id, for verified claims only. Server-side use only."""
        ids = [i for i in dict.fromkeys(listing_ids) if LISTING_ID_RE.match(i)][:MAX_PUBLIC_LOOKUP]
        if not ids:
            return {}
        rows = await self._rows(
            self.db.table(TABLE)
            .select("listing_id,user_id")
            .in_("listing_id", ids)
            .eq("status", "verified")
        )
        return {str(r["listing_id"]): str(r["user_id"]) for r in rows}
