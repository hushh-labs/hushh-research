"""One owner library and bounded admission in the pod's single worker."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import Any

from hushh_mcp.services.pod_files.library import FilesLibrary, FilesRefused
from hushh_mcp.services.pod_files.storage import FilesGcsStore

_library: FilesLibrary | None = None
_condition = asyncio.Condition()
_mutation = asyncio.Lock()
_active = 0
_draining = False


def active_library() -> FilesLibrary:
    global _library
    if os.getenv("POD_FILES_ENABLED", "").lower() not in {"1", "true"}:
        raise FilesRefused("FILES_NOT_ENABLED", 503)
    if _library is None:
        from hushh_mcp.services.byoc_key_custody import resolve_pod_log_key
        from hushh_mcp.services.pod_memory_service import _resolve_log
        from hushh_mcp.services.pod_session_authority import active_session_authority

        log = _resolve_log()
        if log is None:
            raise FilesRefused("FILES_RECOVERY_UNAVAILABLE", 503)

        async def check() -> None:
            await require_files_access()
            await log.require_open()
            authority = active_session_authority()
            if authority is None:
                raise FilesRefused("FILES_AUTHORITY_UNAVAILABLE", 503)
            await authority.require_held()

        prefix = os.environ["POD_STORAGE_GCS_PREFIX"].strip("/") + "/files/v1"
        _library = FilesLibrary(
            owner=os.environ["HUSSH_ID"],
            key=resolve_pod_log_key(),
            store=FilesGcsStore(os.environ["POD_STORAGE_GCS_BUCKET"], prefix),
            check=check,
        )
    return _library


@asynccontextmanager
async def operation(*, mutation: bool = False):
    global _active
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    async with _condition:
        if _draining:
            raise FilesRefused("FILES_DRAINING", 503)
        _active += 1
    permit: Any = None
    try:
        permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
        library = active_library()
        await library.check()
        await library.store.verify_bucket(os.getenv("HUSSH_POD_KMS_KEY", ""))
        if mutation:
            async with _mutation:
                yield library
        else:
            yield library
    finally:
        try:
            if permit is not None:
                await permit.release()
        finally:
            async with _condition:
                _active -= 1
                _condition.notify_all()


async def fence_files() -> None:
    """Refuse new work, then await current writers before the erasure receipt."""
    global _draining
    async with _condition:
        _draining = True
        await asyncio.wait_for(_condition.wait_for(lambda: _active == 0), timeout=30)


# Admission is bound by the HTTP/session owner, never supplied by model arguments.

_files_access: ContextVar[Callable[[], Awaitable[None]] | None] = ContextVar(
    "files_access", default=None
)


@contextmanager
def files_access(check: Callable[[], Awaitable[None]]):
    token = _files_access.set(check)
    try:
        yield
    finally:
        _files_access.reset(token)


async def require_files_access() -> None:
    check = _files_access.get()
    if check is None:
        raise FilesRefused("FILES_AUTHORITY_REQUIRED", 403)
    await check()
