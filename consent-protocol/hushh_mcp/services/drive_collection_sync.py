"""Incremental, resumable Drive discovery; no source bytes or buyer authority."""

from __future__ import annotations

import asyncio
import re
import time
from collections import Counter
from uuid import uuid4

from hushh_mcp.services.drive_collection_store import DriveCollectionStore
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import (
    FILE_ID,
    DriveMetadata,
    DriveReadError,
    GoogleDriveAdapter,
    valid_metadata_name,
)
from hushh_mcp.services.owner_placement_guard import admit_hub_content


def _token(value, previous=None):
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 2048
        or value == previous
        or any(ord(c) < 32 for c in value)
    ):
        raise DriveReadError("provider_response_invalid")
    return value


def _metadata(value):
    if not isinstance(value, dict):
        raise DriveReadError("provider_response_invalid")
    identity, name, mime, version, modified = (
        value.get(k) for k in ("id", "name", "mimeType", "version", "modifiedTime")
    )
    if (
        not isinstance(identity, str)
        or not FILE_ID.fullmatch(identity)
        or not valid_metadata_name(name)
        or not isinstance(mime, str)
        or not 1 <= len(mime) <= 255
        or not isinstance(version, str)
        or not re.fullmatch(r"[0-9]{1,30}", version)
        or not isinstance(modified, str)
        or not 1 <= len(modified) <= 64
    ):
        raise DriveReadError("provider_response_invalid")
    size = value.get("size")
    if size is not None and (not isinstance(size, str) or not re.fullmatch(r"[0-9]{1,20}", size)):
        raise DriveReadError("provider_response_invalid")
    checksum = value.get("md5Checksum")
    if checksum is not None and (
        not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", checksum)
    ):
        raise DriveReadError("provider_response_invalid")
    # Source metadata remains identical to get_metadata(), avoiding a needless
    # re-index solely because a list response includes creation time.
    return DriveMetadata(
        identity, name, mime, version, modified, int(size) if size is not None else None, checksum
    )


class DriveCollectionSync:
    def __init__(self, *, store=None, oauth=None, adapter=None):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveCollectionStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDriveAdapter()

    async def _require_current(self, job):
        await self.store.require_current(job)
        await admit_hub_content(job["user_id"], "drive_collection_sync")

    async def enqueue_candidates(self, *, user_id, file_ids):
        """Resolve a bounded search result through normal collection authority.

        Request retrieval and operator evaluation may accelerate specific sources;
        the scheduled FIFO and the background discovery cursor remain unchanged.
        Source bytes still pass through the ordinary version-fenced ingestion.
        """
        if (
            not isinstance(file_ids, (list, tuple))
            or not 1 <= len(file_ids) <= 50
            or any(
                not isinstance(identity, str) or not FILE_ID.fullmatch(identity)
                for identity in file_ids
            )
            or len(set(file_ids)) != len(file_ids)
        ):
            raise DriveReadError("invalid_argument")
        await admit_hub_content(user_id, "drive_collection_candidates")
        authority = await self.store.candidate_authority(user_id=user_id)
        async with asyncio.timeout(100):
            row, credential = await self.oauth.current_credential(
                user_id=user_id, required_profile="live"
            )
            if row["connection_generation"] != authority["connection_generation"]:
                raise DriveReadError("connection_changed")
            files = []
            for identity in file_ids:
                await self.store.require_candidates_current(authority)
                await admit_hub_content(user_id, "drive_collection_candidates")
                files.append(
                    await self.adapter.get_metadata(
                        file_id=identity,
                        access_token=credential["accessToken"],
                        require_app_authorized=False,
                    )
                )
                await self.store.require_candidates_current(authority)
                await admit_hub_content(user_id, "drive_collection_candidates")
            await admit_hub_content(user_id, "drive_collection_candidates")
            return await self.store.enqueue_candidates(authority, files=files)

    async def run_one(self, *, user_id):
        await admit_hub_content(user_id, "drive_collection_claim")
        job = None
        started = time.monotonic()
        try:
            job = await self.store.claim(user_id=user_id)
            if not job:
                return {"status": "idle"}
            async with asyncio.timeout(100):
                await self._require_current(job)
                row, credential = await self.oauth.current_credential(
                    user_id=user_id, required_profile="live"
                )
                if row["connection_generation"] != job["connection_generation"]:
                    raise DriveReadError("connection_changed")
                await self._require_current(job)
                checkpoint = self.store.checkpoint(job)
                token = credential["accessToken"]
                files = []
                removed = []
                phase = job["phase"]
                incomplete = False
                caught = False
                retry_after = 0
                if phase == "start":
                    # Capture BEFORE listing so changes during bootstrap replay.
                    checkpoint = {
                        "changes_token": await self.adapter.collection_start_token(
                            access_token=token
                        ),
                        "stage": "user",
                        "bootstrap_epoch": str(uuid4()),
                    }
                    phase = "bootstrap"
                elif phase == "bootstrap":
                    stage = checkpoint.get("stage", "user")
                    if stage == "drives":
                        result = await self.adapter.list_drives(
                            access_token=token, page_token=checkpoint.get("drives_token")
                        )
                        drives = result.get("drives", [])
                        if (
                            not isinstance(drives, list)
                            or len(drives) > 25
                            or any(
                                not isinstance(d, dict)
                                or not isinstance(d.get("id"), str)
                                or not FILE_ID.fullmatch(d["id"])
                                for d in drives
                            )
                        ):
                            raise DriveReadError("provider_response_invalid")
                        checkpoint["drives_token"] = _token(
                            result.get("nextPageToken"), checkpoint.get("drives_token")
                        )
                        checkpoint["drive_queue"] = [d["id"] for d in drives]
                        checkpoint["stage"] = "drive" if drives else "drives"
                    else:
                        queue = checkpoint.get("drive_queue", [])
                        result = await self.adapter.collection_files(
                            access_token=token,
                            page_token=checkpoint.get("page_token"),
                            drive_id=queue[0] if stage == "drive" else None,
                        )
                        values = result.get("files", [])
                        if not isinstance(values, list) or len(values) > 100:
                            raise DriveReadError("provider_response_invalid")
                        files = [_metadata(value) for value in values]
                        incomplete = result.get("incompleteSearch") is True
                        checkpoint["page_token"] = _token(
                            result.get("nextPageToken"), checkpoint.get("page_token")
                        )
                        if not checkpoint["page_token"]:
                            if stage == "user":
                                checkpoint["stage"] = "drives"
                            else:
                                checkpoint["drive_queue"] = queue[1:]
                                if not checkpoint["drive_queue"]:
                                    checkpoint["stage"] = "drives"
                    # A completed shared-drive inventory ends bootstrap. The
                    # first transition from user listing still must list drives.
                    if (
                        stage != "user"
                        and checkpoint.get("stage") == "drives"
                        and not checkpoint.get("drives_token")
                    ):
                        phase = "changes"
                        checkpoint["reconcile_epoch"] = checkpoint["bootstrap_epoch"]
                else:
                    result = await self.adapter.collection_changes(
                        access_token=token, page_token=checkpoint["changes_token"]
                    )
                    changes = result.get("changes", [])
                    if not isinstance(changes, list) or len(changes) > 100:
                        raise DriveReadError("provider_response_invalid")
                    scope_changed = False
                    for change in changes:
                        if not isinstance(change, dict):
                            raise DriveReadError("provider_response_invalid")
                        if change.get("changeType") == "drive":
                            scope_changed = True
                            continue
                        identity = change.get("fileId")
                        if not isinstance(identity, str) or not FILE_ID.fullmatch(identity):
                            raise DriveReadError("provider_response_invalid")
                        value = change.get("file")
                        if (
                            change.get("removed") is True
                            or isinstance(value, dict)
                            and value.get("trashed") is True
                        ):
                            removed.append(identity)
                        elif (
                            isinstance(value, dict)
                            and value.get("mimeType") == "application/vnd.google-apps.folder"
                        ):
                            continue
                        else:
                            metadata = _metadata(value)
                            if metadata.file_id != identity:
                                raise DriveReadError("provider_response_invalid")
                            files.append(metadata)
                    next_token = _token(result.get("nextPageToken"), checkpoint["changes_token"])
                    final = _token(result.get("newStartPageToken")) if not next_token else None
                    if not next_token and not final:
                        raise DriveReadError("provider_response_invalid")
                    checkpoint["changes_token"] = next_token or final
                    caught = not next_token
                    if caught and job["incomplete_search"]:
                        phase = "start"
                        caught = False
                        retry_after = 3600
                    if scope_changed:
                        # Membership changes justify reconciliation; ordinary
                        # file changes never restart the complete collection.
                        phase = "start"
                        caught = False
                await self._require_current(job)
                await self.store.commit_page(
                    job,
                    checkpoint=checkpoint,
                    files=files,
                    removed=removed,
                    phase=phase,
                    caught_up=caught,
                    incomplete=incomplete,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    retry_after_seconds=retry_after,
                )
                return {"status": "synced" if caught else "queued"}
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if job:
                try:
                    await self.store.release(
                        job,
                        code="processing_timeout"
                        if isinstance(error, TimeoutError)
                        else str(error),
                    )
                except DriveReadError:
                    pass
            return {"status": "unavailable"}

    async def run(self, *, max_jobs=4, deadline_seconds=100):
        if (
            type(max_jobs) is not int
            or not 1 <= max_jobs <= 20
            or type(deadline_seconds) is not int
            or not 1 <= deadline_seconds <= 110
        ):
            raise ValueError("invalid collection bounds")
        counts = Counter()
        try:
            async with asyncio.timeout(deadline_seconds):
                owners = await self.store.due_owners(max_jobs)
                semaphore = asyncio.Semaphore(4)

                async def one(owner):
                    async with semaphore:
                        result = await self.run_one(user_id=owner)
                        counts[result["status"]] += 1

                await asyncio.gather(*(one(owner) for owner in owners))
        except TimeoutError:
            counts["deadline"] += 1
        return {"schema_version": "drive.collection_sync.v1", "outcomes": dict(counts)}
