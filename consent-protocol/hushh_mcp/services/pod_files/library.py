"""Bounded, encrypted Files operations with per-entry generation CAS.

File metadata is authoritative. Folder index entries are opaque, rebuildable hints;
readers always revalidate their parent/revision against the encrypted manifest.
No chunk or catalog is appended to the pod's recovery log.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from . import analysis_policy, catalog, transfers
from .contracts import CHUNK_BYTES as CHUNK_BYTES
from .contracts import MAX_FILE_BYTES, decode_metadata, display_name
from .contracts import FilesRefused as FilesRefused
from .contracts import identifier as identifier


class FilesLibrary:
    def __init__(self, *, owner: str, key: bytes, store: Any, check: Callable[[], Awaitable[None]]):
        if not owner or len(key) != 32:
            raise ValueError("Files requires owner and encryption key")
        self.owner, self.store, self.check = owner, store, check
        self.key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"hussh/pod-files/v1/" + owner.encode(),
        ).derive(key)

    def _seal(self, path: str, value: bytes, key: bytes | None = None) -> bytes:
        nonce = secrets.token_bytes(12)
        return nonce + AESGCM(key or self.key).encrypt(
            nonce, value, (self.owner + ":" + path).encode()
        )

    def _open(self, path: str, value: bytes, key: bytes | None = None) -> bytes:
        try:
            return AESGCM(key or self.key).decrypt(
                value[:12], value[12:], (self.owner + ":" + path).encode()
            )
        except Exception as exc:
            raise FilesRefused("FILES_INTEGRITY_FAILURE", 409) from exc

    async def _read(self, path: str) -> tuple[dict[str, Any], int]:
        await self.check()
        data, generation = await self.store.get_with_generation(path)
        if data is None:
            raise FilesRefused("FILES_NOT_FOUND", 404)
        await self.check()
        return decode_metadata(self._open(path, data)), generation

    async def _write(self, path: str, value: dict[str, Any], generation: int) -> None:
        await self.check()
        blob = self._seal(
            path,
            json.dumps({"format": 1, **value}, separators=(",", ":"), ensure_ascii=False).encode(),
        )
        if await self.store.put_if_generation(path, blob, generation) is None:
            raise FilesRefused("FILES_REVISION_CONFLICT")

    @staticmethod
    def _path(file_id: str) -> str:
        return f"entries/{identifier(file_id)}.bin"

    @staticmethod
    def public(entry: dict[str, Any]) -> dict[str, Any]:
        return {
            k: entry[k]
            for k in (
                "id",
                "name",
                "originalName",
                "parent",
                "kind",
                "size",
                "received",
                "state",
                "revision",
                "updatedAt",
                "organization",
                "receivedHash",
            )
            if k in entry
        }

    async def _parent(self, parent: str, child: str = "") -> None:
        seen = {child}
        for _ in range(256):
            if parent == "root":
                return
            if parent in seen:
                raise FilesRefused("FILES_FOLDER_CYCLE", 400)
            seen.add(parent)
            entry, _ = await self._read(self._path(parent))
            if entry["kind"] != "folder" or entry["state"] != "ready":
                raise FilesRefused("FILES_FOLDER_UNAVAILABLE", 409)
            parent = entry["parent"]
        raise FilesRefused("FILES_FOLDER_DEPTH_LIMIT", 400)

    async def _index(self, parent: str, file_id: str) -> None:
        path = f"folders/{parent}/{file_id}.bin"
        await self.check()
        # Index is a hint. Writing it before the authoritative CAS prevents lost visibility.
        await self.store.put_if_generation(path, self._seal(path, file_id.encode()), 0)

    async def create(
        self, *, name: str, parent: str, size: int, request_id: str, folder: bool = False
    ) -> dict[str, Any]:
        display_name(name)
        if (
            not 8 <= len(request_id) <= 128
            or type(size) is not int
            or not 0 <= size <= MAX_FILE_BYTES
            or (folder and size != 0)
        ):
            raise FilesRefused("FILES_INVALID_UPLOAD", 400)
        file_id = hmac.new(self.key, ("create:" + request_id).encode(), hashlib.sha256).hexdigest()[
            :32
        ]
        path = self._path(file_id)
        await self._parent(parent, file_id)
        await self.check()
        existing = await self.store.get(path)
        kind = "folder" if folder else "file"
        if existing is not None:
            entry, _ = await self._read(path)
            if (entry["originalName"], entry["initialParent"], entry["size"], entry["kind"]) != (
                name,
                parent,
                size,
                kind,
            ):
                raise FilesRefused("FILES_IDEMPOTENCY_CONFLICT")
            return self.public(entry)
        settings = await self.settings()
        entry = {
            "id": file_id,
            "name": name,
            "originalName": name,
            "parent": parent,
            "initialParent": parent,
            "kind": kind,
            "size": size,
            "received": 0,
            "chunks": 0,
            "receivedHash": "00" * 32,
            "state": "ready" if folder else "uploading",
            "revision": 1,
            "updatedAt": int(time.time() * 1000),
            "format": 1,
            "contentKey": base64.b64encode(secrets.token_bytes(32)).decode(),
            "history": [],
            "automaticConsentRevision": settings["revision"] if settings["automatic"] else None,
        }
        await self._index(parent, file_id)
        await self._write(path, entry, 0)
        return self.public(entry)

    async def stat(self, file_id: str) -> dict[str, Any]:
        entry, _ = await self._read(self._path(file_id))
        return self.public(entry)

    async def put_chunk(self, file_id: str, index: int, data: bytes) -> dict[str, Any]:
        return await transfers.put_chunk(self, file_id, index, data)

    async def complete(self, file_id: str) -> dict[str, Any]:
        return await transfers.complete(self, file_id)

    async def read_chunk(self, file_id: str, index: int) -> bytes:
        return await transfers.read_chunk(self, file_id, index)

    async def list_folder(
        self, parent: str = "root", cursor: str = "", *, trash: bool = False
    ) -> dict[str, Any]:
        return await catalog.list_folder(self, parent, cursor, trash=trash)

    async def rebuild_index_page(self, cursor: str = "") -> dict[str, Any]:
        return await catalog.rebuild_index_page(self, cursor)

    async def mutate(
        self,
        file_id: str,
        *,
        revision: int,
        operation: str,
        name: str = "",
        parent: str = "",
        confirmed: bool = False,
    ) -> dict[str, Any]:
        path = self._path(file_id)
        entry, generation = await self._read(path)
        if entry["revision"] != revision:
            raise FilesRefused("FILES_REVISION_CONFLICT")
        undo_fields = {
            "rename": ("name",),
            "move": ("parent",),
            "trash": ("state",),
            "restore": ("state",),
        }
        before = {k: entry[k] for k in undo_fields.get(operation, ())}
        if operation == "rename":
            entry["name"] = display_name(name)
        elif operation == "move":
            await self._parent(parent, file_id)
            await self._index(parent, file_id)
            entry["parent"] = parent
        elif operation == "trash":
            if not confirmed:
                raise FilesRefused("FILES_CONFIRMATION_REQUIRED", 403)
            entry["state"] = "trashed"
        elif operation == "restore":
            if entry["state"] != "trashed":
                raise FilesRefused("FILES_NOT_TRASHED")
            await self._parent(entry["parent"], file_id)
            entry["state"] = (
                "ready"
                if entry["kind"] == "folder" or entry["received"] == entry["size"]
                else "uploading"
            )
        elif operation == "undo":
            if not entry["history"]:
                raise FilesRefused("FILES_NOTHING_TO_UNDO")
            previous = entry["history"].pop()
            await self._parent(previous.get("parent", entry["parent"]), file_id)
            if "parent" in previous:
                await self._index(previous["parent"], file_id)
            entry.update(previous)
        else:
            raise FilesRefused("FILES_OPERATION_UNSUPPORTED", 400)
        if operation != "undo":
            entry["history"] = (entry["history"] + [before])[-20:]
        entry.update(revision=revision + 1, updatedAt=int(time.time() * 1000))
        await self._write(path, entry, generation)
        return self.public(entry)

    async def settings(self) -> dict[str, Any]:
        return await analysis_policy.settings(self)

    async def configure(
        self, *, revision: int, analysis: bool, automatic: bool, excluded: list[str]
    ) -> dict[str, Any]:
        return await analysis_policy.configure(
            self, revision=revision, analysis=analysis, automatic=automatic, excluded=excluded
        )

    async def analysis_allowed(self, file_id: str) -> dict[str, Any]:
        return await analysis_policy.analysis_allowed(self, file_id)

    async def usage_page(self, cursor: str = "") -> dict[str, Any]:
        return await catalog.usage_page(self, cursor)
