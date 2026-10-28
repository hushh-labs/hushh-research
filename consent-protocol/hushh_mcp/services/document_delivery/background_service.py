"""Additive background producer and authenticated original-byte reader."""

import asyncio
import json
import time
from collections import Counter

from sqlalchemy import text

from hushh_mcp.services.document_delivery import background_objects
from hushh_mcp.services.document_delivery.background_diagnostics import (
    CopySourceChanged,
    copy_step,
    safe_detail,
)
from hushh_mcp.services.document_delivery.background_source import (
    BackgroundOriginalReader,
    require_original,
)
from hushh_mcp.services.document_delivery.background_store import BackgroundCopyStore
from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.document_delivery.storage import configured_objects
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.owner_placement_guard import admit_hub_content


class BackgroundCopyService:
    def __init__(self, *, store=None, objects=None, reader=None, oauth=None):
        self.store = store or BackgroundCopyStore()
        self._objects = objects
        self.reader = reader or BackgroundOriginalReader()
        self.oauth = oauth

    @property
    def objects(self):
        if self._objects is None:
            self._objects = configured_objects()
        return self._objects

    async def produce(self, row, deadline):
        with copy_step(row, "authority"):
            await self.store.current(row)
        source = self.store.open(row, "source_envelope", "background-copy-source-v2")
        oauth = self.oauth or get_external_connector_oauth_service().drive()
        with copy_step(row, "credential"):
            connection, credential = await oauth.current_credential(
                user_id=self.store.owner(row), required_profile="live"
            )
        if connection["connection_generation"] != row["connection_generation"]:
            raise DeliveryError("source_connection_changed")
        from . import background_exports, background_producer

        with copy_step(row, "read"):
            facts = await self.reader.facts(source, credential)
        native = None
        metadata = {"rendition": "original", "name": source["name"], "mimeType": source["mimeType"]}
        time_changed = facts.get("modifiedTime") != (source.get("sourceContentIdentity") or {}).get(
            "modifiedTime"
        )
        try:
            if source["mimeType"] in background_exports.FORMATS:
                with copy_step(row, "export_before"):
                    identity, native = await background_exports.snapshot(
                        self, row, source, credential, facts
                    )
                metadata = {
                    key: identity[key]
                    for key in (
                        "rendition",
                        "exportFormat",
                        "mimeType",
                        "sourceName",
                        "name",
                        "exportedAt",
                        "sourceRevision",
                    )
                }
            else:
                with copy_step(row, "source_before", metadata_time_changed=time_changed):
                    identity = require_original(source, facts)
                metadata["sourceMetadataTimeChanged"] = time_changed
            await self.store.current(row)
            with copy_step(row, "copy") as step:
                chunks = await background_producer.copy_chunks(
                    self, row, source, credential, identity, deadline, native
                )
                if chunks is None:
                    step["outcome"] = "deferred"
            if chunks is None:
                return "deferred"
            with copy_step(row, "read"):
                after = await self.reader.facts(source, credential)
            with copy_step(row, "source_after"):
                if native is not None:
                    background_exports.require_revision(
                        source,
                        after,
                        identity["sourceRevision"],
                        identity["sourceModifiedTime"],
                        stage="source_after",
                    )
                else:
                    require_original(source, after, stage="source_after")
            with copy_step(row, "verify") as step:
                result = await background_producer.verify(self, row, chunks, identity, deadline)
                if result is None:
                    step["outcome"] = "deferred"
            if result is None:
                return "deferred"
            with copy_step(row, "publish"):
                await self.store.finish(row, result={**result, **metadata})
            return "released"
        finally:
            if native is not None:
                native[:] = b"\0" * len(native)

    async def defer(self, row):
        if row.get("_verification_attempt", 0) >= 3:
            await self.stop(row, "verification_budget_exhausted")
            return
        await self.store._transaction(
            lambda c: c.execute(
                text("""UPDATE document_delivery_background_files
          SET lease_id=NULL,lease_expires_at=NULL,next_at=clock_timestamp()
          WHERE file_ref=:ref AND lease_id=:lease AND state='preparing'"""),
                {"ref": row["file_ref"], "lease": row["lease_id"]},
            )
        )

    async def stop(self, row, reason, *, detail=None):
        def operation(connection):
            diagnostic = None
            try:
                if reason == "source_changed" and (projected := safe_detail(detail)):
                    diagnostic = json.dumps(
                        self.store.sharing_cipher.seal(
                            {"copyDiagnostics": projected},
                            user_id=self.store.owner(row),
                            resource_id=str(row["file_ref"]),
                            purpose="background-copy-result-v2",
                        )
                    )
            except Exception:
                pass
            retired = connection.execute(
                text("""UPDATE document_delivery_background_files SET state='unavailable',reason=:reason,
              result_envelope=CAST(:diagnostic AS jsonb),
              lease_id=NULL,lease_expires_at=NULL WHERE file_ref=:ref AND lease_id=:lease
              AND state='preparing' RETURNING file_ref"""),
                {
                    "ref": row["file_ref"],
                    "lease": row["lease_id"],
                    "reason": reason,
                    "diagnostic": diagnostic,
                },
            ).scalar_one_or_none()
            if retired is not None:
                self.store.retire(connection, retired)

        await self.store._transaction(operation)

    async def run(self, *, max_jobs=8, deadline_seconds=30):
        counts = Counter()
        deadline = time.monotonic() + deadline_seconds
        if not await self.store._transaction(self.store.ready):
            return {"outcomes": {}}
        from .background_access import retire_ended

        await retire_ended(self.store, max_jobs * 4)
        await self.store.enroll(max_jobs)
        for _ in range(max_jobs):
            if time.monotonic() >= deadline:
                break
            row = await self.store.claim()
            if row is None:
                break
            try:
                async with asyncio.timeout(max(0.1, deadline - time.monotonic())):
                    counts[await self.produce(row, deadline)] += 1
            except (TimeoutError, asyncio.CancelledError):
                await asyncio.shield(self.defer(row))
                if asyncio.current_task().cancelling():
                    raise
                counts["deferred"] += 1
                break
            except (DeliveryError, DriveReadError) as error:
                code = str(error)
                if code in {"provider_unavailable", "refresh_in_progress"}:
                    try:
                        await self.store.finish(row, reason="provider_unavailable", retry=True)
                    except DriveReadError:
                        await self.stop(row, "authority_ended")
                else:
                    await self.stop(
                        row,
                        code
                        if code
                        in {
                            "source_changed",
                            "download_restricted",
                            "native_export_unavailable",
                            "export_limit_or_download_restricted",
                            "export_size_limit",
                            "export_representation_changed",
                            "source_identity_unavailable",
                            "original_range_unavailable",
                            "upload_outcome_unknown",
                            "copy_integrity_mismatch",
                        }
                        else "authority_ended",
                        detail=error.copy_detail if isinstance(error, CopySourceChanged) else None,
                    )
                counts["unavailable"] += 1
            except Exception:
                # Fixed reason only; never serialize an exception containing a URL/credential.
                await self.stop(row, "copy_unavailable")
                counts["unavailable"] += 1
        return {"outcomes": dict(counts)}

    async def stream(self, *, row, actor):
        chunks = await self.store.chunks(row)
        for chunk in chunks:
            await admit_hub_content(self.store.owner(row), "drive_one_copy")
            await self.store._transaction(lambda c: self.store.file_authority(c, row, actor))
            plaintext = await background_objects.read(self, row, chunk)
            await self.store._transaction(lambda c: self.store.file_authority(c, row, actor))
            await admit_hub_content(self.store.owner(row), "drive_one_copy")
            yield plaintext

        def completed(connection):
            request, _ = self.store.file_authority(connection, row, actor)
            self.store.audit(connection, request, actor, "stream_completed", row["file_ref"])

        await self.store._transaction(completed)


async def run_remaining(legacy, counts, max_jobs, remaining):
    """Existing issued v1 delivery and cleanup always consume their budget first."""
    if remaining < 2:
        return
    service = BackgroundCopyService(
        store=BackgroundCopyStore(db=legacy.store.db, sharing_cipher=legacy.store.sharing_cipher),
        objects=legacy._objects,
    )
    try:
        async with asyncio.timeout(remaining - 0.5):
            result = await service.run(max_jobs=max_jobs, deadline_seconds=remaining - 1)
            counts.update(result["outcomes"])
    except TimeoutError:
        counts["deferred"] += 1
    except Exception:
        counts["unavailable"] += 1
