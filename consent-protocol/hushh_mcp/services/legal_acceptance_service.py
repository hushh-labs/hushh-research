"""Record which Terms of Use and Privacy Policy versions a person accepted.

The store is append-only history (migration 254): one row per person, document,
version and effective date. Accepting a version already on file is a no-op that
keeps the original ``accepted_at``, so a retried request never rewrites evidence.
Reads return the most recent acceptance of each document.

Version strings are chosen by the app's legal document source. The server checks
their shape, not their meaning, and never infers acceptance on a person's behalf.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from db.connection import get_pool

LegalDocumentId = Literal["terms", "privacy"]
LegalAcceptanceSurface = Literal["web", "native"]

_INSERT_SQL = """
INSERT INTO account_legal_acceptances
  (user_id, document_id, document_version, effective_date, surface)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, document_id, document_version, effective_date) DO NOTHING
"""

_LATEST_SQL = """
SELECT DISTINCT ON (document_id)
  document_id, document_version, effective_date, surface, accepted_at
FROM account_legal_acceptances
WHERE user_id = $1
ORDER BY document_id, accepted_at DESC
"""


@dataclass(frozen=True)
class AcceptedDocument:
    document_id: LegalDocumentId
    document_version: str
    effective_date: str


def _serialize(row: Any) -> dict[str, Any]:
    accepted_at = row["accepted_at"]
    return {
        "document_id": row["document_id"],
        "document_version": row["document_version"],
        "effective_date": row["effective_date"],
        "surface": row["surface"],
        "accepted_at": (
            accepted_at.isoformat() if isinstance(accepted_at, datetime) else str(accepted_at)
        ),
    }


async def list_latest_acceptances(*, user_id: str) -> list[dict[str, Any]]:
    """The most recent acceptance of each document, ordered by document id."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(_LATEST_SQL, user_id)
    return [_serialize(row) for row in rows]


async def record_acceptances(
    *,
    user_id: str,
    documents: list[AcceptedDocument],
    surface: LegalAcceptanceSurface,
) -> list[dict[str, Any]]:
    """Record every document in one transaction, then return the latest state."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for document in documents:
                await conn.execute(
                    _INSERT_SQL,
                    user_id,
                    document.document_id,
                    document.document_version,
                    document.effective_date,
                    surface,
                )
    return await list_latest_acceptances(user_id=user_id)
