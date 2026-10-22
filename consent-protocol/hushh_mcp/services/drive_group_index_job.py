"""Bounded four-group preparation; no Drive writes, PKM writes or drain registration.

Each run lists through the existing live transport and processes at most 100
changed files. A current lease is renewed during slow parse/embedding work.
Later runs skip committed source versions; only an exhaustive listing can prune.
"""

from __future__ import annotations

import asyncio
import re
from collections import Counter
from contextlib import asynccontextmanager, nullcontext
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from hushh_mcp.services.drive_group_index_store import (
    LEASE_SECONDS,
    MAX_INDEXED_FILES,
    DriveGroupIndexStore,
    GroupEntry,
)
from hushh_mcp.services.drive_groups.adapters import IsolatedHeadEmbedder, TransportHeadSource
from hushh_mcp.services.drive_groups.contract import four_group_index_enabled
from hushh_mcp.services.drive_groups.indexer import EMBED_BATCH, evidence_from_row, index_files
from hushh_mcp.services.drive_groups.models import load_bundle
from hushh_mcp.services.drive_groups.period import deciding_day, title_day
from hushh_mcp.services.drive_search_paging_config import OWNER_SEARCH_PAGE_SIZE_MAX
from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError, valid_metadata_name
from hushh_mcp.services.google_drive_rest_transport import GoogleDriveRestTransport

logger = drive_logger(__name__)
PAGE_SIZE = OWNER_SEARCH_PAGE_SIZE_MAX
_QUERY = (
    "mimeType != 'application/vnd.google-apps.folder' and "
    "mimeType != 'application/vnd.google-apps.shortcut'"
)


def _moment(value, *, required=False):
    if value is None and not required:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("missing zone")
        return parsed.astimezone(UTC)
    except (AttributeError, TypeError, ValueError, OverflowError):
        raise DriveReadError("provider_response_invalid") from None


def _validate_row(row):
    if (
        not isinstance(row, dict)
        or not isinstance(row.get("id"), str)
        or not FILE_ID.fullmatch(row["id"])
        or not valid_metadata_name(row.get("title"))
        or evidence_from_row(row) is None
        or not isinstance(row.get("version"), str)
        or not re.fullmatch(r"[0-9]{1,32}", row["version"])
    ):
        raise DriveReadError("provider_response_invalid")
    _moment(row.get("modifiedTime"), required=True)
    _moment(row.get("createdTime"))


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


class DriveGroupIndexJob:
    def __init__(self, *, store=None, transport=None, embedder=None, bundle=None):
        self.store = store if store is not None else DriveGroupIndexStore()
        self.transport = transport
        self.embedder = embedder
        self.bundle = bundle

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
        rows, tokens = {}, set()
        token = None
        page_size = PAGE_SIZE
        complete, limited = True, False
        # Bound even a provider returning endless empty pages with fresh tokens.
        for _ in range((MAX_INDEXED_FILES + 24) // 25):
            while True:
                try:
                    result = await reads.read_tool(
                        user_id=user,
                        tool_name="search_files",
                        arguments={
                            "query": _QUERY,
                            "pageSize": page_size,
                            # Edits reorder modifiedTime walks and can hide a file
                            # between pages. Reuse the metadata index's stable walk.
                            "orderBy": "createdTime desc",
                            **({"pageToken": token} if token is not None else {}),
                        },
                    )
                    break
                except DriveReadError as error:
                    if str(error) != "file_too_large" or page_size <= 25:
                        raise
                    # Same response budget and fallback as the owner scanner:
                    # retry this cursor at 100, then 25; never lose a page.
                    page_size = 100 if page_size > 100 else 25
            page = result.payload
            if result.is_error or not isinstance(page, dict):
                raise DriveReadError("provider_response_invalid")
            files = page.get("files")
            if not isinstance(files, list) or len(files) > page_size:
                raise DriveReadError("provider_response_invalid")
            for row in files:
                _validate_row(row)
                if row["id"] in rows and rows[row["id"]] != row:
                    raise DriveReadError("provider_response_invalid")
                if row["id"] not in rows and len(rows) >= MAX_INDEXED_FILES:
                    limited, complete = True, False
                    break
                rows[row["id"]] = row
            complete &= not (
                result.truncated or page.get("incompleteSearch") or page.get("overLimit")
            )
            token = page.get("nextPageToken")
            if token is None:
                break
            if (
                not isinstance(token, str)
                or not 1 <= len(token) <= 1024
                or token in tokens
                or any(ord(c) < 32 for c in token)
            ):
                raise DriveReadError("provider_response_invalid")
            tokens.add(token)
            if len(rows) >= MAX_INDEXED_FILES:
                limited = True
                break
        else:
            limited = True
        return list(rows.values()), complete and not limited, limited

    async def _listing(self, reads, user):
        return await self.list_files(reads, user)

    async def _prepare(self, job):
        transport = self.transport or GoogleDriveRestTransport()
        async with getattr(transport, "owner_search_session", nullcontext)():
            return await self._prepare_in_session(job, transport)

    async def _prepare_in_session(self, job, transport):
        reads = _JobReads(self.store, transport, job)
        rows, complete, limited = await self._listing(reads, job["user_id"])
        known = await self.store.known(job)
        bundle = self.bundle or load_bundle()
        refs = {self.store.sealer.ref(job["user_id"], row["id"]) for row in rows}
        capacity = max(0, MAX_INDEXED_FILES - len(set(known) & refs if complete else known))
        pending = []
        for row in rows:
            ref = self.store.sealer.ref(job["user_id"], row["id"])
            previous = known.get(ref)
            if (
                previous
                and previous[0] == _moment(row["modifiedTime"])
                and previous[2] == bundle.version
                and previous[3] == row["version"]
            ):
                continue
            if previous is None:
                if capacity == 0:
                    limited, complete = True, False
                    continue
                capacity -= 1
            pending.append(row)
        batch = pending[:EMBED_BATCH]
        await self.store.require_current(job)
        run = await index_files(
            batch,
            heads=TransportHeadSource(reads, job["user_id"]),
            embedder=_JobEmbedding(self.store, self.embedder or IsolatedHeadEmbedder(), job),
            bundle=bundle,
        )
        await self.store.require_current(job)
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

    async def run_one(self, *, user_id: str, deadline_seconds: int = 900) -> dict:
        if not four_group_index_enabled():
            return {"status": "disabled"}
        job, committed = None, False
        code = "group_index_unavailable"
        try:
            async with asyncio.timeout(deadline_seconds):
                job = await self.store.claim(user_id=user_id)
                if not job:
                    return {"status": "idle"}
                async with self._lease(job):
                    entries, progress = await self._prepare(job)
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

    async def run(self, *, max_jobs: int = 1, deadline_seconds: int = 900) -> dict:
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 4
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 1800
        ):
            raise ValueError("invalid group index bounds")
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                for user in await self.store.due_owners(max_jobs):
                    result = await self.run_one(user_id=user, deadline_seconds=deadline_seconds)
                    counts[result["status"]] += 1
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.group_index.v1", "outcomes": dict(counts)}
