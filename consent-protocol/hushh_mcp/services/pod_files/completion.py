"""One upload-completion owner for HTTP uploads and admitted Browser saves."""

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from .library import FilesLibrary, FilesRefused


async def complete_upload(
    library: FilesLibrary,
    file_id: str,
    *,
    mutation: AbstractAsyncContextManager,
    verify: Callable[[], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    from .jobs import deliver, prepare_delivery

    prepared = None
    async with mutation:
        result: dict[str, Any] = await library.complete(file_id)
        if verify is not None:
            await verify()
        settings = await library.settings()
        if settings["automatic"]:
            try:
                prepared = await prepare_delivery(library, file_id=file_id, automatic=True)
            except FilesRefused as exc:
                if exc.code not in {
                    "FILES_EXCLUDED",
                    "FILES_ANALYSIS_CONSENT_REQUIRED",
                    "FILES_BACKGROUND_NOT_CONFIGURED",
                    "FILES_WORKER_DESTINATION_UNAVAILABLE",
                }:
                    raise
                # Bytes are committed; organization has its own outcome.
                result["organization"] = {
                    "state": "not_requested"
                    if exc.code in {"FILES_EXCLUDED", "FILES_ANALYSIS_CONSENT_REQUIRED"}
                    else "unconfirmed",
                    "code": exc.code,
                }
    if prepared is not None:
        try:
            result["organization"] = await deliver(library, prepared)
        except FilesRefused as exc:
            if exc.code not in {
                "FILES_BACKGROUND_NOT_CONFIGURED",
                "FILES_WORKER_DESTINATION_UNAVAILABLE",
                "FILES_QUEUE_UNAVAILABLE",
                "FILES_JOB_DELIVERY_UNCONFIRMED",
                "FILES_JOB_DELIVERY_FAILED",
            }:
                raise
            result["organization"] = {
                "state": "pending_delivery",
                "code": "FILES_JOB_DELIVERY_UNCONFIRMED",
            }
    await library.check()
    return result
