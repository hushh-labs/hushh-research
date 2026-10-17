"""Seam between request search and the owner's local metadata index (Gear 1).

Gear 1 answers from the owner's file names held by this process. It runs in
the first worker slice after a search's create-time Drive page (a cold index
must not spend that one short page listing Drive), before any further Drive
page, and finds titles Drive's own search cannot. It is only an accelerator:
Gear 2 (the Drive pass-through) still runs to completion and stays the
completeness authority, and every Gear 1 row passes the same kind, period,
title-evidence and shareability checks as a Drive page.

Gear 1 runs only in the Drive worker deployment (``DRIVE_WORKER_MODE=true``),
whose drains the operator's kill switches govern. The API process keeps the
no-op index, so an owner-started search lists Drive exactly as before and no
index listing ever runs there. ``DRIVE_OWNER_INDEX_ENABLED=false`` turns Gear 1
off in the worker too.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable, Collection, Sequence
from typing import Any, Protocol

# One Gear 1 lookup per search; its rows are committed in 100-row pages.
MAX_LOCAL_CANDIDATES = 500
OWNER_INDEX_FLAG = "DRIVE_OWNER_INDEX_ENABLED"
# Index listing one search's first Gear 1 page may spend, so the slice keeps
# most of its deadline for Drive. The index keeps its progress between
# searches in this process only; on a large Drive it stays partial for many
# searches (see drive_owner_metadata_index), so Gear 1 helps small Drives most.
INDEX_LISTING_PAGES = 2
INDEX_LISTING_SECONDS = 3.0
# The metadata index's per-call bounds.
_MAX_CONCEPTS = 12
_MAX_VARIANTS = 64
_REST_FIELDS = ("driveId", "resourceKey", "shortcutDetails", "capabilities")


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
        limit: int = MAX_LOCAL_CANDIDATES,
        connection_generation: int | None = None,
        precedence: bool = False,
        require_current: Callable[[], Awaitable[object]] | None = None,
        allow_listing: bool = False,
    ) -> list[dict]:
        """Rows shaped like Drive REST ``files.list`` items, newest first.

        ``concepts`` is an AND of OR-variant lists; the search makes one call
        per AND group (each document part, and each standalone phrase with the
        topics). ``period`` is None when file dates do not decide (owner
        review); ``precedence`` is the autoshare date rule. Names are keyed by
        the job's ``connection_generation`` and ``require_current`` is the
        job's fence. Only ``allow_listing`` calls may ask Drive for index
        pages. Returned rows carry ``id``, ``name``, ``mimeType``,
        ``createdTime``, ``modifiedTime`` and, when known, ``capabilities``,
        ``driveId``, ``resourceKey``, ``shortcutDetails`` and ``webViewLink``.
        Order must be deterministic.
        """
        ...

    async def owner_vocabulary(
        self, *, owner_id: str, connection_generation: int | None = None
    ) -> Collection[str] | None:
        """Casefolded title words the owner's Drive really contains, if indexed."""
        ...


class NoOwnerIndex:
    """No local index: Gear 2 alone, exactly the previous behaviour."""

    enabled = False

    async def match_owner_files(self, **_: object) -> list[dict]:
        return []

    async def owner_vocabulary(self, **_: object) -> Collection[str] | None:
        return None


def _rest_row(file: dict) -> dict:
    """The REST item a projected owner-search row was built from.

    The search re-projects it through the transport's own page projection,
    so a Gear 1 row passes exactly the checks a Drive page does.
    """
    return {
        "id": file.get("id"),
        "name": file.get("title"),
        "mimeType": file.get("mimeType"),
        "modifiedTime": file.get("modifiedTime"),
        "createdTime": file.get("createdTime"),
        "webViewLink": file.get("viewUrl"),
        **{key: file[key] for key in _REST_FIELDS if file.get(key) is not None},
        **(
            {"clientEncryptionDetails": file["clientEncryptionDetails"]}
            if file.get("clientEncryptionDetails") is not None
            else {}
        ),
    }


def _bounded(concepts: Sequence[Sequence[str]]) -> list[list[str]] | None:
    """Fit the index's bounds by dropping the lowest-priority spellings.

    Each concept keeps its own word (variants are in priority order). Too
    many concepts cannot be narrowed safely, so that lookup is skipped.
    """
    groups = [[str(variant) for variant in concept] for concept in concepts if concept]
    if not groups or len(groups) > _MAX_CONCEPTS:
        return None
    while sum(len(group) for group in groups) > _MAX_VARIANTS:
        max(groups, key=len).pop()
    return groups


async def _current_generation(owner_id: str) -> int | None:
    from hushh_mcp.services.external_connector_oauth_service import (
        get_external_connector_oauth_service,
    )

    row = (
        await get_external_connector_oauth_service()
        .drive()
        .lifecycle.read(user_id=owner_id, connector_id="google_drive")
    )
    generation = row.get("connection_generation") if row else None
    if not row or row.get("status") != "connected" or type(generation) is not int:
        return None
    return generation


class MetadataOwnerIndex:
    """Gear 1 backed by the in-process owner metadata index.

    No model, no content read: names, types and dates listed through the
    fenced owner-search operation (see ``drive_owner_metadata_index``).
    """

    enabled = True

    def __init__(
        self,
        *,
        indexer: Any = None,
        generation: Callable[[str], Awaitable[int | None]] | None = None,
    ) -> None:
        self._indexer = indexer
        self._generation = generation or _current_generation

    def _owner_indexer(self) -> Any:
        if self._indexer is None:
            from hushh_mcp.services import drive_owner_metadata_index as gear1

            self._indexer = gear1._DEFAULT_INDEXER
        return self._indexer

    async def match_owner_files(
        self,
        *,
        owner_id: str,
        concepts: Sequence[Sequence[str]],
        period: dict | None,
        file_kind: str,
        limit: int = MAX_LOCAL_CANDIDATES,
        connection_generation: int | None = None,
        precedence: bool = False,
        require_current: Callable[[], Awaitable[object]] | None = None,
        allow_listing: bool = False,
        **_: object,
    ) -> list[dict]:
        # Names are keyed by the grant they were listed under: no generation,
        # no names. Folders and shortcuts go to the search's own handling.
        groups = _bounded(concepts)
        if type(connection_generation) is not int or groups is None:
            return []
        from hushh_mcp.services.drive_owner_search_service import (
            FOLDER_MIME,
            SHORTCUT_MIME,
            _matches_requested_kind,
        )

        result = await self._owner_indexer().match(
            owner_id,
            groups,
            period,
            connection_generation=connection_generation,
            precedence=precedence,
            mime_filter=lambda mime: (
                mime in {FOLDER_MIME, SHORTCUT_MIME} or _matches_requested_kind(file_kind, mime)
            ),
            limit=limit,
            max_pages=INDEX_LISTING_PAGES if allow_listing else 0,
            deadline_seconds=INDEX_LISTING_SECONDS,
            require_current=require_current,
        )
        rows = [_rest_row(candidate.file) for candidate in result.candidates]
        # Newest first, file ID breaking ties, like the Drive title pass.
        rows.sort(key=lambda row: row["id"])
        rows.sort(key=lambda row: row.get("modifiedTime") or "", reverse=True)
        return rows

    async def owner_vocabulary(
        self, *, owner_id: str, connection_generation: int | None = None, **_: object
    ) -> Collection[str] | None:
        generation = connection_generation
        if type(generation) is not int:
            generation = await self._generation(owner_id)
        if type(generation) is not int:
            return None
        indexer = self._owner_indexer()
        # Peek only: planning never asks Drive for index pages.
        status = await indexer.refresh(owner_id, connection_generation=generation, max_pages=0)
        if not status.ready:
            # A partial vocabulary would call real words typos.
            return None
        words = await indexer.vocabulary(owner_id, connection_generation=generation, max_pages=0)
        return words or None


def owner_index_enabled() -> bool:
    """Gear 1 runs in the Drive worker deployment unless the operator turns it off."""
    return (
        os.getenv("DRIVE_WORKER_MODE", "").strip().lower() == "true"
        and os.getenv(OWNER_INDEX_FLAG, "true").strip().lower() != "false"
    )


def default_owner_index() -> OwnerIndex:
    """The single wiring point for Gear 1."""
    return MetadataOwnerIndex() if owner_index_enabled() else NoOwnerIndex()
