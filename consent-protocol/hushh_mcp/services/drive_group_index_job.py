"""Bounded four-group preparation; no Drive writes or PKM writes.

Each run lists through the existing live transport and processes a bounded batch.
A current lease is renewed during slow parse/embedding work.
Later runs skip committed source versions; only an exhaustive listing can prune.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections import Counter
from contextlib import asynccontextmanager, nullcontext
from dataclasses import replace
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_document_prefix import PREFIX_POLICY
from hushh_mcp.services.drive_group_index_store import (
    LEASE_SECONDS,
    MAX_BATCH,
    MAX_INDEXED_FILES,
    DriveGroupIndexStore,
    GroupEntry,
)
from hushh_mcp.services.drive_groups.adapters import IsolatedHeadEmbedder, TransportHeadSource
from hushh_mcp.services.drive_groups.contract import four_group_index_enabled
from hushh_mcp.services.drive_groups.indexer import index_files
from hushh_mcp.services.drive_groups.inventory import (
    WORKER_INVENTORY_CACHE,
    _moment,
    list_inventory_files,
)
from hushh_mcp.services.drive_groups.models import load_bundle
from hushh_mcp.services.drive_groups.period import deciding_day, title_day
from hushh_mcp.services.drive_search_paging_config import OWNER_SEARCH_PAGE_SIZE_MAX
from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.google_drive_adapter import (
    LIVE_EXTRACTABLE_ORIGINAL_TYPES,
    RAW_PREFIX_LIMIT,
    DriveReadError,
)
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport
from hushh_mcp.services.owner_placement_guard import admit_hub_content

logger = drive_logger(__name__)
PAGE_SIZE = OWNER_SEARCH_PAGE_SIZE_MAX
CONTENT_BATCH = 100
READ_CONCURRENCY = 6
# Leave the existing isolated embedding timeout (100s) and commit/cleanup room.
EMBED_COMMIT_RESERVE = 115


class _JobReads:
    """Adapt the head port without permitting a read under a replacement grant."""

    def __init__(self, store, transport, job):
        self.store, self.transport, self.job = store, transport, job

    async def read_tool(self, *, user_id, tool_name, arguments):
        await self.store.require_current(self.job)
        result = await self.transport.read_group_index_tool(
            user_id=user_id,
            tool_name=tool_name,
            arguments=arguments,
            expected_generation=self.job["connection_generation"],
        )
        await self.store.require_current(self.job)
        return result


class _JobEmbedding:
    def __init__(self, store, embedder, job):
        self.store, self.embedder, self.job = store, embedder, job

    async def embed(self, heads):
        await self.store.require_current(self.job)
        result = await self.embedder.embed(heads)
        await self.store.require_current(self.job)
        return result


def _pending_rows(rows, known, *, sealer, user, model_version, complete, limited):
    refs = {sealer.ref(user, row["id"]) for row in rows}
    capacity = max(0, MAX_INDEXED_FILES - len(set(known) & refs if complete else known))
    pending = []
    for row in rows:
        ref = sealer.ref(user, row["id"])
        previous = known.get(ref)
        if (
            previous
            and previous[0] == _moment(row["modifiedTime"])
            and previous[2] == model_version
            and previous[3] == row["version"]
        ):
            continue
        if previous is None:
            if capacity == 0:
                limited, complete = True, False
                continue
            capacity -= 1
        pending.append(row)

    return refs, pending, complete, limited


async def _capture_heads(reads, user, content, deadline):
    captured = {}
    attempted = 0
    source = TransportHeadSource(reads, user)
    gate = asyncio.Semaphore(READ_CONCURRENCY)

    async def capture(row):
        nonlocal attempted
        async with gate:
            attempted += 1
            captured[row["id"]] = await source.head(row)

    budget = max(0, min(40, deadline - asyncio.get_running_loop().time() - EMBED_COMMIT_RESERVE))
    if content and budget > 0:
        tasks = [asyncio.create_task(capture(row)) for row in content]
        try:
            done, waiting = await asyncio.wait(
                tasks, timeout=budget, return_when=asyncio.FIRST_EXCEPTION
            )
            for task in done:
                task.result()
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    return captured, attempted


class DriveGroupIndexJob:
    def __init__(
        self, *, store=None, transport=None, embedder=None, bundle=None, inventory_cache=None
    ):
        self.store = store if store is not None else DriveGroupIndexStore()
        self.transport = transport
        self.embedder = embedder
        self.bundle = bundle
        self.inventory_cache = (
            inventory_cache if inventory_cache is not None else WORKER_INVENTORY_CACHE
        )

    @asynccontextmanager
    async def _lease(self, job):
        async def renew():
            while True:
                await asyncio.sleep(LEASE_SECONDS / 3)
                await self.store.renew(job)

        async with asyncio.TaskGroup() as tasks:
            pulse = tasks.create_task(renew())
            try:
                yield
            finally:
                pulse.cancel()

    @staticmethod
    async def list_files(reads, user):
        return await list_inventory_files(
            reads, user, maximum=MAX_INDEXED_FILES, page_size=PAGE_SIZE
        )

    async def _listing(self, reads, user):
        job = reads.job
        inventory = await self.inventory_cache.load(
            reads,
            user,
            key=(user, job["connection_generation"], job["revision"], job["background_revision"]),
            listing=self.list_files,
            require_current=lambda: self.store.require_current(job),
        )
        return inventory.rows, inventory.complete, inventory.limited

    async def _prepare(self, job, deadline):
        transport = self.transport or GoogleDriveRestTransport(raw_prefix=True)
        async with getattr(transport, "owner_search_session", nullcontext)():
            return await self._prepare_in_session(job, transport, deadline)

    async def _prepare_in_session(self, job, transport, deadline):
        clock = asyncio.get_running_loop().time
        started = clock()
        reads = _JobReads(self.store, transport, job)
        rows, complete, limited = await self._listing(reads, job["user_id"])
        listed_at = clock()
        known = await self.store.known(job)
        original = self.bundle or load_bundle()
        # Source-version equality alone cannot reuse old full-download evidence.
        policy = f"{original.version}:{PREFIX_POLICY}:{RAW_PREFIX_LIMIT}:{original.head_chars}:require-head"
        bundle = replace(original, version=hashlib.sha256(policy.encode()).hexdigest()[:12])
        refs, pending, complete, limited = _pending_rows(
            rows,
            known,
            sealer=self.store.sealer,
            user=job["user_id"],
            model_version=bundle.version,
            complete=complete,
            limited=limited,
        )

        def uploaded_content(row):
            mime = row.get("mimeType", "")
            return mime in LIVE_EXTRACTABLE_ORIGINAL_TYPES and not mime.startswith(
                "application/vnd.google-apps."
            )

        # Reserve content slots first: media must not starve readable documents.
        content = [row for row in pending if uploaded_content(row)][:CONTENT_BATCH]
        batch = [row for row in pending if not uploaded_content(row)][: MAX_BATCH - len(content)]
        reads_started_at = clock()
        captured, attempted = await _capture_heads(reads, job["user_id"], content, deadline)
        batch.extend(row for row in content if row["id"] in captured)
        if content and not batch:
            # A healthy-looking empty commit must not hide budget starvation.
            raise DriveReadError("processing_timeout")
        captured_at = clock()

        class CapturedHeads:
            async def head(self, row):
                return captured.get(row["id"])

        await self.store.require_current(job)
        run = await index_files(
            batch,
            heads=CapturedHeads(),
            embedder=_JobEmbedding(self.store, self.embedder or IsolatedHeadEmbedder(), job),
            bundle=bundle,
            require_head=True,
        )
        await self.store.require_current(job)
        logger.info(
            "drive_group_index.prepare listed=%d pending=%d attempted=%d captured=%d deferred=%d "
            "listing_ms=%.1f selection_ms=%.1f read_ms=%.1f index_ms=%.1f",
            len(rows),
            len(pending),
            attempted,
            len(captured),
            len(content) - len(captured),
            (listed_at - started) * 1000,
            (reads_started_at - listed_at) * 1000,
            (captured_at - reads_started_at) * 1000,
            (clock() - captured_at) * 1000,
        )
        by_id = {row["id"]: row for row in batch}
        zone = ZoneInfo(job["time_zone"])
        entries = []
        for indexed in run.files:
            row = by_id[indexed.file_id]
            created, modified = _moment(row.get("createdTime")), _moment(row["modifiedTime"])
            reference, _ = deciding_day(title=None, created=created, modified=modified, zone=zone)
            entries.append(
                GroupEntry(
                    file_id=indexed.file_id,
                    title=row["title"],
                    mime_type=row["mimeType"],
                    view_url=f"https://drive.google.com/file/d/{indexed.file_id}/view",
                    created_time=created,
                    modified_time=modified,
                    title_day=title_day(row["title"], zone=zone, reference=reference),
                    placement=indexed.placement,
                    head=indexed.head,
                    vector=indexed.vector,
                    source_version=row["version"],
                )
            )
        return entries, {
            "listed": len(rows),
            "complete": complete,
            "limited": limited,
            "keep": refs if complete else None,
            "more": len(pending) > len(batch),
        }

    async def run_one(self, *, user_id: str, deadline_seconds: int = 180) -> dict:
        if not four_group_index_enabled():
            return {"status": "disabled"}
        job, committed = None, False
        code = "group_index_unavailable"
        try:
            deadline = asyncio.get_running_loop().time() + deadline_seconds
            async with asyncio.timeout(deadline_seconds):
                await admit_hub_content(user_id, "drive_group_index")
                job = await self.store.claim(user_id=user_id)
                if not job:
                    return {"status": "idle"}
                async with self._lease(job):
                    entries, progress = await self._prepare(job, deadline)
                # The heartbeat is stopped before commit releases the lease.
                result = await self.store.commit(job, entries, **progress)
                committed = True
                return {
                    "status": "queued" if progress["more"] else "indexed",
                    "written": result["written"],
                    "pruned": result["pruned"],
                    "complete": progress["complete"],
                    "limited": progress["limited"],
                }
        except asyncio.CancelledError:
            code = "processing_cancelled"
            raise
        except TimeoutError:
            code = "processing_timeout"
        except Exception:
            # Never log exception text: it may contain provider/SQL/private values.
            pass
        finally:
            if job is not None and not committed:
                try:
                    await self.store.release(job, code=code)
                except Exception:
                    logger.warning("drive_group_index.release status=unavailable")
        return {"status": "unavailable"}

    async def run(self, *, max_jobs: int = 1, deadline_seconds: int = 180) -> dict:
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 4
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 180
        ):
            raise ValueError("invalid group index bounds")
        if not four_group_index_enabled():
            return {"schema_version": "drive.group_index.v1", "outcomes": {"disabled": 1}}
        counts: Counter[str] = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                for user in await self.store.due_owners(max_jobs):
                    result = await self.run_one(user_id=user, deadline_seconds=deadline_seconds)
                    counts[result["status"]] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.group_index.v1", "outcomes": dict(counts)}
