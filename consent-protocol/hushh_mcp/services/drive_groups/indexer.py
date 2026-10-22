"""Operon: Drive rows in, placements out.

Reads each file's text start through a ``HeadSource``, embeds the heads in
batches through a ``HeadEmbedder`` (the child's model load is the cost, so a
batch is one call), then places every file. Both are ports, so this module
holds no transport, credential or model. The flag is checked first: with it off
the aid refuses to run. A file the aid will not place is kept, and keeps its
text start and embedding for future indexing; a placed file keeps neither.
Logs carry counts and closed labels only, never a name, a head or an ID.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from hushh_mcp.services.drive_groups.contract import (
    FileEvidence,
    GroupIndexDisabled,
    Placement,
    four_group_index_enabled,
)
from hushh_mcp.services.drive_groups.fusion import fuse
from hushh_mcp.services.drive_groups.models import ModelBundle, load_bundle
from hushh_mcp.services.drive_groups.placement import place
from hushh_mcp.services.drive_telemetry import drive_logger

logger = drive_logger(__name__)

# The embedding child takes at most 100 pages per call.
EMBED_BATCH = 100
# Default for callers that do not opt into a wider, bounded network pipeline.
READ_CONCURRENCY = 2
MAX_READ_CONCURRENCY = 32
_NOT_FILES = frozenset(
    {"application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"}
)


class HeadSource(Protocol):
    async def head(self, row: Mapping[str, Any]) -> str | None:
        """The text start of one listed file, or None when it has no usable text."""
        ...


class HeadEmbedder(Protocol):
    async def embed(self, heads: Sequence[str]) -> Sequence[tuple[float, ...] | None]:
        """One unit vector per head, in order; None where a head could not be embedded."""
        ...


@dataclass(frozen=True, slots=True)
class IndexedFile:
    file_id: str
    placement: Placement
    head: str | None = field(default=None, repr=False)
    vector: tuple[float, ...] | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class IndexRun:
    files: tuple[IndexedFile, ...]
    skipped: int


def evidence_from_row(
    row: Mapping[str, Any], owner_email: str | None = None
) -> FileEvidence | None:
    """Evidence from a listed Drive row; None for a folder, shortcut or malformed row."""
    name, mime = row.get("title", row.get("name")), row.get("mimeType")
    if not isinstance(name, str) or not isinstance(mime, str) or mime in _NOT_FILES:
        return None
    owners = row.get("owners")
    owned = None
    if owner_email and isinstance(owners, list) and owners:
        owned = any(
            isinstance(owner, dict)
            and str(owner.get("emailAddress", "")).lower() == owner_email.lower()
            for owner in owners
        )
    return FileEvidence(
        name=name, mime_type=mime, owned_by_me=owned, shared_with_me=bool(row.get("sharingUser"))
    )


async def _read_heads(
    rows: Sequence[Mapping[str, Any]], source: HeadSource, concurrency: int
) -> list[str | None]:
    gate = asyncio.Semaphore(concurrency)
    heads: list[str | None] = [None] * len(rows)

    async def read(index: int) -> None:
        async with gate:
            heads[index] = await source.head(rows[index])

    try:
        async with asyncio.TaskGroup() as group:
            for index in range(len(rows)):
                group.create_task(read(index))
    except* Exception as failure:
        # An authority or transport failure ends the run and cancels the rest.
        raise failure.exceptions[0] from None
    return heads


async def _embed(heads: list[str | None], embedder: HeadEmbedder) -> dict[int, tuple[float, ...]]:
    wanted = [index for index, head in enumerate(heads) if head]
    vectors: dict[int, tuple[float, ...]] = {}
    for start in range(0, len(wanted), EMBED_BATCH):
        batch = wanted[start : start + EMBED_BATCH]
        embedded = await embedder.embed([heads[index] or "" for index in batch])
        if len(embedded) != len(batch):
            raise ValueError("embedder returned a different count")
        vectors.update(
            (index, vector) for index, vector in zip(batch, embedded, strict=True) if vector
        )
    return vectors


async def index_files(
    rows: Sequence[Mapping[str, Any]],
    *,
    heads: HeadSource,
    embedder: HeadEmbedder,
    owner_email: str | None = None,
    bundle: ModelBundle | None = None,
    read_concurrency: int = READ_CONCURRENCY,
    require_head: bool = False,
) -> IndexRun:
    if not four_group_index_enabled():
        raise GroupIndexDisabled("the Drive four-group index is off")
    if type(read_concurrency) is not int or not 1 <= read_concurrency <= MAX_READ_CONCURRENCY:
        raise ValueError("invalid read concurrency")
    if type(require_head) is not bool:
        raise ValueError("invalid head requirement")
    started = time.perf_counter()
    bundle = bundle or load_bundle()
    listed = [
        (row, evidence)
        for row in rows
        if (evidence := evidence_from_row(row, owner_email)) is not None
    ]
    texts = await _read_heads([row for row, _ in listed], heads, read_concurrency)
    vectors = await _embed(texts, embedder)
    files = []
    for index, (row, evidence) in enumerate(listed):
        head, vector = texts[index], vectors.get(index)
        # A prefix-only run explicitly requires decoded content. On extraction
        # failure, abstain before invoking any classifier, including metadata.
        placement = (
            fuse((), bundle.fusion, bundle.version)
            if require_head and not head
            else place(
                FileEvidence(
                    evidence.name,
                    evidence.mime_type,
                    evidence.owned_by_me,
                    evidence.shared_with_me,
                    head,
                    vector,
                ),
                bundle,
            )
        )
        kept = placement.group is None
        files.append(
            IndexedFile(
                str(row.get("id", "")),
                placement,
                head if kept else None,
                vector if kept else None,
            )
        )
    reasons = Counter(file.placement.reason for file in files)
    groups = Counter(file.placement.shelf for file in files)
    logger.info(
        "drive_groups.index files=%d skipped=%d heads=%d embedded=%d reasons=%s shelves=%s "
        "version=%s duration_ms=%.1f",
        len(files),
        len(rows) - len(listed),
        sum(1 for text in texts if text),
        len(vectors),
        ",".join(f"{name}:{count}" for name, count in sorted(reasons.items())),
        ",".join(f"{name}:{count}" for name, count in sorted(groups.items())),
        bundle.version,
        (time.perf_counter() - started) * 1000,
    )
    return IndexRun(tuple(files), len(rows) - len(listed))
