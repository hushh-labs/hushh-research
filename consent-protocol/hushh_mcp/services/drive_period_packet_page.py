"""Exact frozen metadata paging; never a new query or content read."""

from __future__ import annotations

import asyncio

from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_owner_search_service import PAGE_SIZE, _shareability
from hushh_mcp.services.drive_request_discovery import discovery_evidence
from hushh_mcp.services.google_drive_adapter import DriveReadError


async def frozen_provider_page(service, job, manifest, checkpoint):
    offset = checkpoint["packet_offset"]
    sources = manifest["sources"][offset : offset + PAGE_SIZE]
    semaphore = asyncio.Semaphore(6)

    async def candidate(source):
        identity = source["document_id"]
        metadata = manifest["source_metadata"][identity]
        async with semaphore:
            result = await service.transport.read_tool(
                user_id=job["user_id"],
                tool_name="get_file_metadata",
                arguments={"fileId": metadata["id"]},
            )
        if result.is_error or result.truncated or not isinstance(result.payload, dict):
            raise DriveReadError("provider_response_invalid")
        raw = result.payload.get("file")
        match = DriveLiveReader._match(raw)
        if (
            match is None
            or match["file_id"] != metadata["id"]
            or raw.get("trashed") is True
            or raw.get("version") != source["source_version"]
            or match["name"] != metadata["name"]
            or match["mime_type"] != metadata["mimeType"]
        ):
            raise DriveReadError("source_changed")
        file = {
            "id": metadata["id"],
            "name": metadata["name"],
            "mimeType": metadata["mimeType"],
            "sourceVersion": source["source_version"],
            "modifiedTime": match["modified_time"],
            "createdTime": match.get("created_time"),
            "openUrl": match["open_url"],
            "providerPacketDocumentId": identity,
            "providerPacketId": manifest["packet_id"],
            "providerPacketVersion": manifest["version"],
            **_shareability(raw),
            **({"resourceKey": metadata["resourceKey"]} if metadata.get("resourceKey") else {}),
        }
        file["discoveryEvidence"] = discovery_evidence(
            checkpoint,
            user_id=job["user_id"],
            generation=job["generation"],
            metadata=file,
        )
        return file

    tasks = [asyncio.create_task(candidate(source)) for source in sources]
    try:
        files = await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    checkpoint["packet_offset"] += len(files)
    return checkpoint, files, False, checkpoint["packet_offset"] == len(manifest["sources"])


def validate_buyer_checkpoint(manifest, private, claimed, frozen):
    """A catalog purchase reuses its owner's plan, not a second request interpretation."""
    from hushh_mcp.services.drive_request_discovery import discovery_delivery
    from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest

    if not isinstance(manifest, dict) or claimed.get("evidence_route") != "packet":
        raise DriveReadError("search_superseded")
    if (
        manifest["search"].get("query_source") is not None
        and manifest.get("category") != "financial"
    ):
        raise DriveReadError("search_superseded")
    expected = {
        "query_source": manifest["search"].get("query_source"),
        "semantic_plan": manifest["search"]["plan"],
        "semantic_plan_digest": semantic_plan_digest(manifest["search"]["plan"]),
        "semantic_model_binding": manifest["search"]["model_binding"],
        "queries": manifest["search"]["queries"],
        "requested_period": {
            "start": manifest["periodStart"],
            "end": manifest["periodEnd"],
            "timezone": manifest["timezone"],
        },
        "semantic_purpose": private.get("purpose"),
        "reusable_packet": private.get("reusable_packet"),
        "provider_packet": True,
    }
    if (
        manifest.get("kind") != "provider_discovery"
        or private.get("agent_package_required") is not True
        or claimed.get("authority_mode") != "agent_package"
        or not discovery_delivery(claimed)
        or any(
            claimed.get(key) != value or frozen.get(key) != value for key, value in expected.items()
        )
    ):
        raise DriveReadError("search_superseded")
