"""Owner-controlled save of captured bytes, using current Files admission."""

import asyncio
import hashlib
import hmac

from .contracts import BrowserRefused


async def save_download(runtime, access, task_id, download_id, *, name, parent, check):
    task = await runtime._metadata_task(access, task_id)
    await check()
    async with task.operation:
        saved = task.saved_downloads.get(download_id)
        if saved is not None and (saved.get("verified") or task.closed or task.closing is not None):
            if (name, parent) != (saved["name"], saved["parent"]):
                raise BrowserRefused("BROWSER_DOWNLOAD_DESTINATION_CHANGED")
            from hushh_mcp.services.pod_files.runtime import files_access, operation

            with files_access(check, manage=check):
                async with operation() as library:
                    entry = await library.stat(saved["file_id"])
                    if entry["state"] != "ready" or entry["size"] != saved["bytes"]:
                        raise BrowserRefused("BROWSER_DOWNLOAD_UNAVAILABLE")
                    actual = await library.read_chunk(entry["id"], 0) if saved["bytes"] else b""
                    if not hmac.compare_digest(hashlib.sha256(actual).hexdigest(), saved["sha256"]):
                        raise BrowserRefused("BROWSER_DOWNLOAD_INTEGRITY_FAILED")
            await check()
            return {
                **{
                    key: saved[key]
                    for key in ("file_id", "bytes", "sha256", "organization")
                    if key in saved
                },
                "verified": True,
            }
        await runtime._task(access, task_id)
        control = task.control
        if control is None or control.downloads is None:
            raise BrowserRefused("BROWSER_DOWNLOAD_UNAVAILABLE")

        async def current():
            await runtime._access(access)
            await check()

        if task.closed or task.closing is not None:
            raise BrowserRefused("BROWSER_STOPPED")

        def created(value):
            task.saved_downloads[download_id] = {**value, "name": name, "parent": parent}

        task.save_worker = asyncio.current_task()
        try:
            receipt = await control.downloads.save(
                download_id, name=name, parent=parent, check=current, record_created=created
            )
            created(receipt)
            task.revision += 1
        finally:
            task.save_worker = None
    if task.closing is None and not task.closed:
        if task.model_completed:
            await runtime._lifecycle.close(task, phase="completed", code="BROWSER_DOWNLOAD_SAVED")
        else:
            await runtime._checkpoint(task)
    return receipt
