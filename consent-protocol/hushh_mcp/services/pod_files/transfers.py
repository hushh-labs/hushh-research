"""Resumable immutable chunks; the library owns encryption and authority."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import TYPE_CHECKING, Any

from .contracts import CHUNK_BYTES, FilesRefused

if TYPE_CHECKING:
    from .library import FilesLibrary


async def put_chunk(library: FilesLibrary, file_id: str, index: int, data: bytes) -> dict[str, Any]:
    path = library._path(file_id)
    entry, generation = await library._read(path)
    if type(index) is not int or index < 0 or not 0 < len(data) <= CHUNK_BYTES:
        raise FilesRefused("FILES_INVALID_CHUNK", 400)
    if entry["state"] != "uploading" or index > entry["chunks"]:
        raise FilesRefused("FILES_UPLOAD_NOT_WRITABLE")
    expected = min(CHUNK_BYTES, entry["size"] - index * CHUNK_BYTES)
    if len(data) != expected:
        raise FilesRefused("FILES_CHUNK_SIZE_MISMATCH", 400)
    chunk_path = f"chunks/{file_id}/{index:012d}.bin"
    key = base64.b64decode(entry["contentKey"])
    await library.check()
    stored = await library.store.get(chunk_path)
    if stored is None:
        sealed = library._seal(chunk_path, data, key)
        await library.store.put_if_generation(chunk_path, sealed, 0)
        stored = await library.store.get(chunk_path)
    if stored is None or not hmac.compare_digest(
        hashlib.sha256(library._open(chunk_path, stored, key)).digest(),
        hashlib.sha256(data).digest(),
    ):
        raise FilesRefused("FILES_CHUNK_RETRY_CONFLICT")
    if index < entry["chunks"]:
        return library.public(entry)
    entry["receivedHash"] = hashlib.sha256(
        bytes.fromhex(entry["receivedHash"]) + hashlib.sha256(data).digest()
    ).hexdigest()
    entry.update(
        received=entry["received"] + len(data),
        chunks=index + 1,
        revision=entry["revision"] + 1,
        updatedAt=int(time.time() * 1000),
    )
    await library._write(path, entry, generation)
    return library.public(entry)


async def complete(library: FilesLibrary, file_id: str) -> dict[str, Any]:
    path = library._path(file_id)
    entry, generation = await library._read(path)
    if entry["state"] == "ready":
        return library.public(entry)
    if entry["state"] != "uploading" or entry["received"] != entry["size"]:
        raise FilesRefused("FILES_UPLOAD_INCOMPLETE")
    entry.update(state="ready", revision=entry["revision"] + 1, updatedAt=int(time.time() * 1000))
    await library._write(path, entry, generation)
    return library.public(entry)


async def read_chunk(library: FilesLibrary, file_id: str, index: int) -> bytes:
    entry, _ = await library._read(library._path(file_id))
    if entry["state"] != "ready" or entry["kind"] != "file" or not 0 <= index < entry["chunks"]:
        raise FilesRefused("FILES_CHUNK_UNAVAILABLE", 404)
    await library._parent(entry["parent"])
    path = f"chunks/{file_id}/{index:012d}.bin"
    await library.check()
    blob = await library.store.get(path)
    if blob is None:
        raise FilesRefused("FILES_INTEGRITY_FAILURE")
    await library.check()
    return library._open(path, blob, base64.b64decode(entry["contentKey"]))
