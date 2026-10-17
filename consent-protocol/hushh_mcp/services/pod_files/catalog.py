"""Paginated catalog projections; encrypted manifests remain authoritative."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .contracts import CHUNK_BYTES, FilesRefused, identifier

if TYPE_CHECKING:
    from .library import FilesLibrary


async def list_folder(
    library: FilesLibrary, parent: str = "root", cursor: str = "", *, trash: bool = False
) -> dict[str, Any]:
    await library._parent(parent)
    await library.check()
    keys, next_cursor = await library.store.list_page(f"folders/{parent}", cursor, 100)
    entries = []
    for path in keys:
        file_id = path.rsplit("/", 1)[-1].removesuffix(".bin")
        try:
            entry, _ = await library._read(library._path(file_id))
        except FilesRefused as exc:
            if exc.status == 404:
                continue  # interrupted create/index is not authoritative
            raise
        if entry["parent"] == parent and (entry["state"] == "trashed") == trash:
            entries.append(library.public(entry))
    return {"entries": entries, "cursor": next_cursor, "chunkBytes": CHUNK_BYTES}


async def rebuild_index_page(library: FilesLibrary, cursor: str = "") -> dict[str, Any]:
    """Repair one bounded page from encrypted manifests; never scan at startup.

    Stale index hints are harmless because listings revalidate the manifest.
    A concurrent move also writes its destination hint before committing.
    """
    await library.check()
    paths, next_cursor = await library.store.list_page("entries", cursor, 100)
    repaired = 0
    for path in paths:
        file_id = identifier(path.rsplit("/", 1)[-1].removesuffix(".bin"))
        entry, _ = await library._read(library._path(file_id))
        if entry.get("id") != file_id:
            raise FilesRefused("FILES_INTEGRITY_FAILURE")
        parent = entry["parent"]
        if parent != "root":
            identifier(parent)
        await library._index(parent, file_id)
        repaired += 1
    return {"repaired": repaired, "cursor": next_cursor}


async def usage_page(library: FilesLibrary, cursor: str = "") -> dict[str, Any]:
    """Owner-requested metadata scan; a page is not a billing total."""
    await library.check()
    keys, next_cursor = await library.store.list_page("entries", cursor, 100)
    stored_bytes = files = 0
    for path in keys:
        entry, _ = await library._read(path)
        if entry["kind"] == "file":
            stored_bytes += entry["received"]
            files += 1
    return {
        "bytes": stored_bytes,
        "files": files,
        "cursor": next_cursor,
        "excludesProviderRetention": True,
    }
