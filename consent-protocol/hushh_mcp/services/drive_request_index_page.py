"""Current packet/index pages composed behind the existing search entrypoint."""

import asyncio
import copy
import json

from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_owner_search_service import PAGE_SIZE, _counter, _shareability
from hushh_mcp.services.drive_owner_search_store import validate_reusable_packet
from hushh_mcp.services.drive_request_discovery import discovery_delivery
from hushh_mcp.services.google_drive_adapter import DriveReadError


async def indexed_candidate(service, job, document, semaphore):
    metadata = document["metadata"]
    async with semaphore:
        # The whole page is fenced before provider I/O and atomically
        # at commit; avoid rescanning the collection per file.
        result = await service.transport.read_tool(
            user_id=job["user_id"],
            tool_name="get_file_metadata",
            arguments={"fileId": metadata["file_id"]},
        )
        if result.is_error or result.truncated or not isinstance(result.payload, dict):
            raise DriveReadError("provider_response_invalid")
        source = result.payload.get("file")
        match = DriveLiveReader._match(source)
        if (
            match is None
            or match["file_id"] != metadata["file_id"]
            or source.get("version") != document["source_version"]
            or match["name"] != metadata["name"]
            or source.get("trashed") is True
        ):
            raise DriveReadError("source_changed")
        capabilities = source.get("capabilities", {})
        if (
            capabilities.get("canDownload") is not True
            or capabilities.get("canAccessViaGenAi") is False
        ):
            raise DriveReadError("source_unavailable")
        return {
            "id": match["file_id"],
            "name": match["name"],
            "mimeType": match["mime_type"],
            "modifiedTime": match["modified_time"],
            "createdTime": match.get("created_time"),
            "openUrl": match["open_url"],
            **_shareability(source),
            "indexedEvidence": {
                key: document[key] for key in ("document_id", "source_version", "facts_version")
            },
            "indexedEvidenceBytes": len(
                json.dumps(document.get("facts", {}), ensure_ascii=False).encode()
            )
            * 2,
            "requestEvidence": {
                "version": 1,
                "assessment": "unverified",
                "basis": "document_index",
            },
        }


async def indexed_page(service, job):
    checkpoint = copy.deepcopy(job["checkpoint"])
    if checkpoint["evidence_route"] == "packet":
        binding = checkpoint.get("reusable_packet") or checkpoint["matched_packet"]
        manifest = await service._packet_store().current_packet_manifest(
            owner_user_id=job["user_id"],
            packet_id=binding["packetId"],
            version=binding["version"],
        )
        validate_reusable_packet(manifest, binding, job["user_id"])
        if manifest.get("kind") == "provider_discovery":
            if checkpoint.get("provider_packet") is not True or not discovery_delivery(checkpoint):
                raise DriveReadError("packet_integrity_invalid")
            from hushh_mcp.services.drive_period_packet_page import frozen_provider_page

            return await frozen_provider_page(service, job, manifest, checkpoint)
        offset = checkpoint["packet_offset"]
        sources = manifest["sources"][offset : offset + PAGE_SIZE]
        documents = [
            {**source, "metadata": manifest["source_metadata"][source["document_id"]]}
            for source in sources
        ]
        checkpoint["packet_offset"] += len(documents)
        done = checkpoint["packet_offset"] == len(manifest["sources"])
    else:
        current = await service._facts_store().current_index_status(owner_user_id=job["user_id"])
        if (
            checkpoint["evidence_route"] == "index"
            and not current["complete"]
            or current["signature"] != checkpoint["index_snapshot"]["signature"]
        ):
            raise DriveReadError("source_changed")
        page = await service._facts_store().current_documents_page(
            owner_user_id=job["user_id"], cursor=checkpoint["index_cursor"], limit=PAGE_SIZE
        )
        documents = page["documents"]
        checkpoint["index_cursor"] = page["next_cursor"]
        done = page["next_cursor"] is None
    semaphore = asyncio.Semaphore(6)

    tasks = [
        asyncio.create_task(indexed_candidate(service, job, document, semaphore))
        for document in documents
    ]
    try:
        files = await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    _counter(checkpoint, "indexedDocumentsReused", len(files))
    if done and checkpoint["evidence_route"] == "hybrid":
        checkpoint["phase"] = "user"
        done = False
    return checkpoint, files, False, done
