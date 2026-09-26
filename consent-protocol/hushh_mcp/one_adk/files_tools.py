"""Files tools for One's ADK task specialist; no destructive or shell capability."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from hushh_mcp.services.pod_files.library import FilesRefused
from hushh_mcp.services.pod_files.runtime import operation, require_files_access

_job_target: ContextVar[str | None] = ContextVar("files_job_target", default=None)


@contextmanager
def job_target(file_id: str):
    token = _job_target.set(file_id)
    try:
        yield
    finally:
        _job_target.reset(token)


async def list_files(parent: str = "root", cursor: str = "") -> dict[str, Any]:
    """List one bounded page of the private library's folder metadata."""
    try:
        await require_files_access()
        async with operation() as library:
            settings = await library.settings()
            if not settings["analysis"]:
                raise FilesRefused("FILES_ANALYSIS_CONSENT_REQUIRED", 403)
            if parent != "root":
                await library.analysis_allowed(parent)
            result = await library.list_folder(parent, cursor)
            result["entries"] = [entry for entry in result["entries"] if entry["id"] not in settings["excluded"]]
            if (await library.settings())["revision"] != settings["revision"]:
                raise FilesRefused("FILES_CONSENT_CHANGED", 403)
            if parent != "root":
                await library.analysis_allowed(parent)
            await require_files_access()
            return {"status": "ok", **result}
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}


async def create_folder(name: str, parent: str, request_id: str) -> dict[str, Any]:
    """Create an empty organization folder; retain request_id when retrying."""
    try:
        await require_files_access()
        async with operation(mutation=True) as library:
            settings = await library.settings()
            if not settings["analysis"]:
                raise FilesRefused("FILES_ANALYSIS_CONSENT_REQUIRED", 403)
            if parent != "root":
                await library.analysis_allowed(parent)
            # Background folder creation is consented only for this job's upload.
            if _job_target.get() is not None:
                await library.analysis_allowed(_job_target.get())
            return {"status": "ok", "folder": await library.create(
                name=name, parent=parent, size=0, request_id=request_id, folder=True)}
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}


async def read_file(file_id: str) -> dict[str, Any]:
    """Read a small UTF-8 text file after explicit library analysis consent.

    Other formats remain downloadable by the owner; this tool never executes,
    extracts archives, or substitutes a filename-based content classification.
    """
    try:
        await require_files_access()
        async with operation() as library:
            consent = await library.analysis_allowed(file_id)
            entry = await library.stat(file_id)
            if entry["size"] > 256 * 1024:
                return {"status": "unsupported", "code": "FILES_ANALYSIS_SIZE_LIMIT"}
            content = await library.read_chunk(file_id, 0) if entry["size"] else b""
            try:
                text = content.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                return {"status": "unsupported", "code": "FILES_FORMAT_UNSUPPORTED"}
            if "\x00" in text:
                return {"status": "unsupported", "code": "FILES_FORMAT_UNSUPPORTED"}
            if (await library.analysis_allowed(file_id))["revision"] != consent["revision"]:
                raise FilesRefused("FILES_CONSENT_CHANGED", 403)
            await require_files_access()
            return {"status": "ok", "file": entry, "untrusted_content": text}
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}


async def organize_file(file_id: str, revision: int, operation_name: str, name: str = "", parent: str = "") -> dict[str, Any]:
    """Apply one reversible rename or move chosen by the Files agent."""
    try:
        await require_files_access()
        if _job_target.get() is not None and _job_target.get() != file_id:
            raise FilesRefused("FILES_JOB_TARGET_MISMATCH", 403)
        if operation_name not in {"rename", "move"}:
            raise FilesRefused("FILES_OPERATION_UNSUPPORTED", 400)
        async with operation(mutation=True) as library:
            await library.analysis_allowed(file_id)
            if operation_name == "move" and parent != "root":
                await library.analysis_allowed(parent)
            await require_files_access()
            return {"status": "ok", "file": await library.mutate(file_id, revision=revision,
                operation=operation_name, name=name, parent=parent)}
    except FilesRefused as exc:
        return {"status": "blocked", "code": exc.code}
