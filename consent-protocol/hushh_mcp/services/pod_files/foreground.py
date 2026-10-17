"""Transient selected-file projection for the existing authored Files specialist.

Tools propose reversible effects in memory. Only the unlocked browser commits to
its encrypted library after checking current revisions and processing consent.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Awaitable, Callable, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from .contracts import FilesRefused, display_name, identifier


class ForegroundFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=255)
    parent: str = Field(min_length=1, max_length=32)
    kind: Literal["file", "folder"]
    revision: int = Field(ge=1)


class ForegroundRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file: ForegroundFile
    content: str = Field(max_length=256 * 1024)
    folders: list[ForegroundFile] = Field(default_factory=list, max_length=0)
    processing_consent: Literal[True]
    provider: Literal["gemini"]
    consent_revision: int = Field(ge=0)


class ForegroundProjection:
    def __init__(self, request: ForegroundRequest, check: Callable[[], Awaitable[None]]):
        if (
            request.file.kind != "file"
            or len(request.content.encode()) > 256 * 1024
            or "\x00" in request.content
        ):
            raise FilesRefused("FILES_FORMAT_UNSUPPORTED", 400)
        self.file = request.file.model_dump()
        self.content, self.parent, self.check = request.content, request.file.parent, check
        self.folders = {
            folder.id: folder.model_dump()
            for folder in request.folders
            if folder.kind == "folder" and folder.parent == self.parent
        }
        self.changes: list[dict[str, Any]] = []
        self.read = False

    async def list_files(self, parent: str, cursor: str) -> dict[str, Any]:
        await self.check()
        if parent != self.parent or cursor:
            return {"status": "blocked", "code": "FILES_PROJECTION_UNAVAILABLE"}
        return {"status": "ok", "entries": list(self.folders.values()), "cursor": ""}

    async def read_file(self, file_id: str) -> dict[str, Any]:
        await self.check()
        if file_id != self.file["id"] or self.read:
            return {"status": "blocked", "code": "FILES_PROJECTION_UNAVAILABLE"}
        self.read = True
        return {"status": "ok", "file": deepcopy(self.file), "untrusted_content": self.content}

    async def create_folder(self, name: str, parent: str, request_id: str) -> dict[str, Any]:
        await self.check()
        if parent != self.parent or len(self.changes) >= 8 or not 8 <= len(request_id) <= 128:
            return {"status": "blocked", "code": "FILES_PROJECTION_UNAVAILABLE"}
        display_name(name)
        existing = next(
            (item for item in self.changes if item.get("request_id") == request_id), None
        )
        if existing:
            if existing["name"] != name or existing["parent"] != parent:
                return {"status": "blocked", "code": "FILES_IDEMPOTENCY_CONFLICT"}
            return {"status": "ok", "folder": self.folders[existing["id"]]}
        folder = {
            "id": uuid4().hex,
            "name": name,
            "parent": parent,
            "kind": "folder",
            "revision": 1,
        }
        self.folders[folder["id"]] = folder
        self.changes.append({"operation": "create_folder", **folder, "request_id": request_id})
        return {"status": "ok", "folder": folder}

    async def organize_file(
        self, file_id: str, revision: int, operation_name: str, name: str, parent: str
    ) -> dict[str, Any]:
        await self.check()
        if (
            file_id != self.file["id"]
            or revision != self.file["revision"]
            or not self.read
            or len(self.changes) >= 8
        ):
            return {"status": "blocked", "code": "FILES_SOURCE_CHANGED"}
        if operation_name == "rename":
            self.file["name"] = display_name(name)
        elif operation_name == "move" and (parent == self.parent or parent in self.folders):
            if parent != "root":
                identifier(parent)
            self.file["parent"] = parent
        else:
            return {"status": "blocked", "code": "FILES_OPERATION_UNSUPPORTED"}
        self.file["revision"] += 1
        self.changes.append(
            {
                "operation": operation_name,
                "file_id": file_id,
                "revision": revision,
                **({"name": name} if operation_name == "rename" else {"parent": parent}),
            }
        )
        return {"status": "ok", "file": deepcopy(self.file)}
