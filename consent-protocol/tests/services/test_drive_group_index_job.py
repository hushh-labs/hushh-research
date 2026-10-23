"""Bounded worker reads and content-first batch scheduling; no provider calls."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from hushh_mcp.services.drive_groups.contract import FLAG
from tests.services.test_drive_groups import basis, tiny_bundle

VERSION = "0123456789ab"
MOMENT = datetime(2026, 5, 2, 9, 30, tzinfo=UTC)


async def test_production_job_uses_raw_prefix_and_never_files_metadata_without_a_head(monkeypatch):
    from hushh_mcp.services import drive_group_index_job as module

    monkeypatch.setenv(FLAG, "true")
    store = SimpleNamespace(
        known=AsyncMock(return_value={}),
        require_current=AsyncMock(),
        sealer=SimpleNamespace(ref=lambda user, file: file),
    )
    transport = SimpleNamespace()
    factory = Mock(return_value=transport)
    monkeypatch.setattr(module, "GoogleDriveRestTransport", factory)
    row = {
        "id": "synthetic-file",
        "title": "Statement.pdf",
        "mimeType": "application/pdf",
        "version": "1",
        "modifiedTime": MOMENT.isoformat(),
        "createdTime": MOMENT.isoformat(),
    }
    job = module.DriveGroupIndexJob(
        store=store,
        bundle=replace(tiny_bundle(), version=VERSION),
        embedder=SimpleNamespace(embed=AsyncMock()),
    )
    job._listing = AsyncMock(return_value=([row], True, False))
    head = AsyncMock(return_value=None)
    monkeypatch.setattr(module.TransportHeadSource, "head", head)
    entries, progress = await job._prepare(
        {"user_id": "owner", "time_zone": "UTC"}, asyncio.get_running_loop().time() + 180
    )
    factory.assert_called_once_with(raw_prefix=True)
    assert entries[0].placement.shelf == "kept" and entries[0].head is None
    assert entries[0].placement.version != VERSION
    job.embedder.embed.assert_not_awaited()
    assert progress["more"] is False and progress["keep"] == {"synthetic-file"}


async def test_worker_reads_a_full_content_batch_before_media_can_starve_it(monkeypatch):
    from hushh_mcp.services import drive_group_index_job as module

    monkeypatch.setenv(FLAG, "true")
    store = SimpleNamespace(
        known=AsyncMock(return_value={}),
        require_current=AsyncMock(),
        sealer=SimpleNamespace(ref=lambda user, file: file),
    )
    base = {
        "title": "Statement.pdf",
        "mimeType": "application/pdf",
        "version": "1",
        "modifiedTime": MOMENT.isoformat(),
    }
    content = [{**base, "id": f"content-{i}"} for i in range(100)]
    media = [{**base, "id": f"media-{i}", "mimeType": "image/jpeg"} for i in range(5100)]
    embedder = SimpleNamespace(embed=AsyncMock(side_effect=lambda heads: [basis(0)] * len(heads)))
    job = module.DriveGroupIndexJob(
        store=store, transport=SimpleNamespace(), bundle=tiny_bundle(), embedder=embedder
    )
    job._listing = AsyncMock(return_value=(media + content, True, False))
    active = peak = 0

    async def capture(self, row):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0)
            return "statement account"
        finally:
            active -= 1

    monkeypatch.setattr(module.TransportHeadSource, "head", capture)
    entries, progress = await job._prepare(
        {"user_id": "owner", "time_zone": "UTC"}, asyncio.get_running_loop().time() + 180
    )
    assert len(entries) == 5000 and progress["more"]
    assert sum(item.file_id.startswith("content-") for item in entries) == 100
    assert peak == 6 and active == 0
    assert [len(call.args[0]) for call in embedder.embed.await_args_list] == [100]


async def test_deadline_defers_slow_content_but_commits_completed_metadata(monkeypatch):
    from hushh_mcp.services import drive_group_index_job as module

    monkeypatch.setenv(FLAG, "true")
    monkeypatch.setattr(module, "EMBED_COMMIT_RESERVE", 0)
    store = SimpleNamespace(
        known=AsyncMock(return_value={}),
        require_current=AsyncMock(),
        sealer=SimpleNamespace(ref=lambda user, file: file),
    )
    row = {
        "id": "slow-file",
        "title": "Statement.pdf",
        "mimeType": "application/pdf",
        "version": "1",
        "modifiedTime": MOMENT.isoformat(),
        "createdTime": MOMENT.isoformat(),
    }
    job = module.DriveGroupIndexJob(
        store=store,
        transport=SimpleNamespace(),
        bundle=tiny_bundle(),
        embedder=SimpleNamespace(embed=AsyncMock()),
    )
    job._listing = AsyncMock(
        return_value=([row, {**row, "id": "metadata-file", "mimeType": "image/png"}], True, False)
    )
    stopped = asyncio.Event()

    async def slow(self, row):
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(module.TransportHeadSource, "head", slow)
    entries, progress = await job._prepare(
        {"user_id": "owner", "time_zone": "UTC"}, asyncio.get_running_loop().time() + 0.05
    )
    assert [entry.file_id for entry in entries] == ["metadata-file"]
    assert progress["more"] is True and stopped.is_set()
    job.embedder.embed.assert_not_awaited()
