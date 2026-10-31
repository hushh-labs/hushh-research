"""Bounded Browser work ownership; synthetic fixtures are not cloud acceptance."""

import asyncio

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused
from tests.helpers.pod_browser import approved_task, task_runtime_fixture


@pytest.mark.parametrize("outcome", ["save", "stop", "stop_during_save"])
async def test_completed_download_parks_without_replay_and_save_is_joined(
    monkeypatch, tmp_path, outcome
):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_browser.contracts import BrowserResponse
    from hushh_mcp.services.pod_browser.downloads import BrowserDownloads
    from hushh_mcp.services.pod_browser.task_downloads import save_download
    from hushh_mcp.services.pod_files import runtime as files_runtime
    from hushh_mcp.services.pod_files.library import FilesLibrary
    from hushh_mcp.services.pod_files.storage import FilesLocalStore

    fixture = task_runtime_fixture(monkeypatch)
    downloads = BrowserDownloads()
    fixture.driver.downloads = downloads
    original_close = fixture.driver.close

    async def close():
        downloads.clear()
        await original_close()

    monkeypatch.setattr(fixture.driver, "close", close)
    run = AsyncMock(wraps=fixture.model.run)
    monkeypatch.setattr(fixture.model, "run", run)
    library = FilesLibrary(
        owner="owner",
        key=b"k" * 32,
        store=FilesLocalStore(str(tmp_path)),
        check=fixture.owner.check,
    )

    @asynccontextmanager
    async def operation(**_):
        await files_runtime.require_files_access()
        yield library

    monkeypatch.setattr(files_runtime, "operation", operation)
    if outcome == "save":
        from hushh_mcp.services.pod_files import jobs
        from hushh_mcp.services.pod_files.library import FilesRefused

        await library.configure(
            revision=(await library.settings())["revision"],
            analysis=True,
            automatic=True,
            excluded=[],
        )
        monkeypatch.setattr(jobs, "require_background_delivery", lambda: None)
        monkeypatch.setattr(
            jobs,
            "_deliver_google",
            AsyncMock(side_effect=FilesRefused("FILES_JOB_DELIVERY_UNCONFIRMED", 503)),
        )
    started = await approved_task(fixture)
    task = fixture.runtime._tasks[started.binding.task_id]
    data = b"synthetic byte-exact attachment\x00\xff"
    downloads.capture(
        BrowserResponse(
            status=200,
            headers=(("Content-Disposition", 'attachment; filename="synthetic.bin"'),),
            body=data,
        )
    )
    fixture.model.release.set()
    await task.worker
    parked = await fixture.runtime.read(fixture.owner, task.binding.task_id)
    assert parked.phase == "needs_owner" and parked.goal_completed and len(parked.downloads) == 1
    assert not task.closed and fixture.admission._states["epoch"].active == 1
    assert all(not event["payload"]["snapshot"].get("downloads") for event in fixture.log.records)
    await fixture.runtime.control(
        fixture.owner, task.binding.task_id, "takeover", parked.control_epoch
    )
    with pytest.raises(BrowserRefused, match="DOWNLOAD_PENDING"):
        await fixture.runtime.control(
            fixture.owner, task.binding.task_id, "resume", task.control.control_epoch
        )
    assert run.await_count == 1
    offer = parked.downloads[0]

    async def save():
        return await save_download(
            fixture.runtime,
            fixture.owner,
            task.binding.task_id,
            offer.download_id,
            name=offer.name,
            parent="root",
            check=fixture.owner.check,
        )

    if outcome == "stop":
        await fixture.runtime.control(
            fixture.owner, task.binding.task_id, "cancel", task.control.control_epoch
        )
        with pytest.raises(BrowserRefused, match="RECOVERY|UNAVAILABLE|CLOSED"):
            await save()
        assert not (await library.list_folder())["entries"]
    else:
        if outcome == "stop_during_save":
            committed, release = asyncio.Event(), asyncio.Event()
            original_complete = library.complete

            async def complete(file_id):
                result = await original_complete(file_id)
                committed.set()
                await release.wait()
                return result

            monkeypatch.setattr(library, "complete", complete)
            saving = asyncio.create_task(save())
            await committed.wait()
            stopping = asyncio.create_task(
                fixture.runtime.control(
                    fixture.owner, task.binding.task_id, "cancel", task.control.control_epoch
                )
            )
            await asyncio.sleep(0.01)
            assert not stopping.done()
            release.set()
            receipt = await saving
            await stopping
        else:
            receipt = await save()
        assert await library.read_chunk(receipt["file_id"], 0) == data and receipt["verified"]
        if outcome == "save":
            assert receipt["organization"] == {
                "state": "pending_delivery",
                "code": "FILES_JOB_DELIVERY_UNCONFIRMED",
            }
            job, _ = await library._read(f"jobs/{receipt['file_id']}.bin")
            assert job["state"] == "pending_delivery"
            assert job["consentRevision"] == (await library.settings())["revision"]
        assert await save() == receipt  # lost response reconciles, never refetches website
        assert len((await library.list_folder())["entries"]) == 1
    assert task.closed and fixture.admission._states["epoch"].active == 0
    assert not downloads.offers
