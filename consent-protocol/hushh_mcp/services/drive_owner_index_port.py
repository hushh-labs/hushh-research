"""Seam between request search and the owner's local metadata index (Gear 1).

Gear 1 answers from metadata already stored for the owner, so a request can
show its first matches before Drive is asked. It is only an accelerator:
Gear 2 (the Drive pass-through) still runs to completion and stays the
completeness authority, and every Gear 1 row passes the same kind, period,
title-evidence and shareability checks as a Drive page. The default is a
no-op, so search behaves exactly as before until an index is wired here.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from typing import Protocol

# One Gear 1 lookup per search; its rows are committed in 100-row pages.
MAX_LOCAL_CANDIDATES = 500


class OwnerIndex(Protocol):
    """What the request search needs from an owner's local metadata index."""

    enabled: bool

    async def match_owner_files(
        self,
        *,
        owner_id: str,
        concepts: Sequence[Sequence[str]],
        period: dict | None,
        file_kind: str,
        alternatives: Sequence[str] = (),
        limit: int = MAX_LOCAL_CANDIDATES,
    ) -> list[dict]:
        """Rows shaped like Drive REST ``files.list`` items, newest first.

        ``concepts`` is an AND of OR-variant lists; ``alternatives`` are
        phrases that satisfy the subject on their own. Returned rows carry
        ``id``, ``name``, ``mimeType``, ``createdTime``, ``modifiedTime`` and,
        when known, ``capabilities``, ``driveId``, ``resourceKey``,
        ``shortcutDetails`` and ``webViewLink``. Order must be deterministic.
        """
        ...

    async def owner_vocabulary(self, *, owner_id: str) -> Collection[str] | None:
        """Casefolded title words the owner's Drive really contains, if indexed."""
        ...


class NoOwnerIndex:
    """No local index: Gear 2 alone, exactly the previous behaviour."""

    enabled = False

    async def match_owner_files(self, **_: object) -> list[dict]:
        return []

    async def owner_vocabulary(self, **_: object) -> Collection[str] | None:
        return None


def default_owner_index() -> OwnerIndex:
    """The single wiring point for Gear 1. Replace the return value to enable it."""
    return NoOwnerIndex()
