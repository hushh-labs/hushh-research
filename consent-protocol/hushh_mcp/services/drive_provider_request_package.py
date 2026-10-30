"""Provider-search selection below existing request, Allow and payment owners.

Seals metadata provenance only, without content reads or fabricated assessments.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from collections import Counter

from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_telemetry import drive_logger
from hushh_mcp.services.google_drive_adapter import DriveReadError

logger = drive_logger(__name__)
PROVIDER_PACKAGE_VERSION = 2
PROVIDER_PACKAGE_POLICY = "request-provider-packet-v1"


def _json_digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def _provider_package(package):
    return (
        package.get("schema_version") == PROVIDER_PACKAGE_VERSION
        and package.get("basis") == "provider_discovery"
        and package.get("policy_version") == PROVIDER_PACKAGE_POLICY
    )


def _provider_disclosure(package):
    from hushh_mcp.services.drive_request_package_disclosure import PackageDisclosure

    return PackageDisclosure.model_validate(
        {
            "schemaVersion": 1,
            "packageDigest": package["digest"],
            "packageRevision": package["revision"],
            "selectedCount": len(package["selected_positions"]),
            "coverageStatus": "unknown",
            "periods": [],
            "confidenceBasis": "provider_search",
            "limitations": [
                "Google Drive matched the query and selected file metadata dates. "
                "File contents and financial coverage were not assessed."
            ],
        }
    ).model_dump(mode="json", exclude_none=True)


def provider_manifest(store, connection, row, checkpoint, *, approved_terms=False):
    from hushh_mcp.services.drive_owner_search_store import validate_reusable_packet
    from hushh_mcp.services.drive_packet_store import DrivePacketStore
    from hushh_mcp.services.drive_period_packet_contract import PacketPeriod

    binding = checkpoint.get("reusable_packet")
    if checkpoint.get("provider_packet") is not True or not isinstance(binding, dict):
        raise DriveSharingError("package_changed")
    manifest = DrivePacketStore(db=store.db, cipher=store.cipher)._current_packet_manifest(
        connection,
        owner_user_id=row["user_id"],
        packet_id=binding["packetId"],
        version=binding["version"],
    )
    validate_reusable_packet(manifest, binding, row["user_id"], approved_terms=approved_terms)
    if manifest.get("kind") != "provider_discovery" or manifest.get("schema_version") != 2:
        raise DriveSharingError("package_changed")
    if manifest.get("connection_generation") != row["connection_generation"]:
        raise DriveSharingError("connection_changed")
    period = PacketPeriod.model_validate(
        {
            "start": manifest["periodStart"],
            "end": manifest["periodEnd"],
            "timezone": manifest["timezone"],
        }
    )
    if not period.closed(connection.execute(text("SELECT clock_timestamp()")).scalar_one()):
        raise DriveSharingError("package_not_ready")
    return manifest


def provider_result(store, row, checkpoint, manifest, item, *, materialize):
    from hushh_mcp.services.drive_request_discovery import discovery_evidence_matches
    from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest

    position = item["position"]
    metadata = store.search_cipher.open(
        item["metadata_envelope"],
        user_id=row["user_id"],
        resource_id=f"{row['job_id']}:{position}",
        purpose="owner-search-result",
    )
    document_id = metadata.get("providerPacketDocumentId")
    versions = {source["document_id"]: source["source_version"] for source in manifest["sources"]}
    original = manifest["source_metadata"].get(document_id, {})
    expected = {
        "queries": manifest["search"]["queries"],
        "semantic_plan": manifest["search"]["plan"],
        "semantic_plan_digest": semantic_plan_digest(manifest["search"]["plan"]),
        "request_origin_id": checkpoint["request_origin_id"],
        "request_revision": checkpoint["request_revision"],
        "requested_period": {
            "start": manifest["periodStart"],
            "end": manifest["periodEnd"],
            "timezone": manifest["timezone"],
        },
    }
    if (
        document_id not in versions
        or metadata.get("providerPacketId") != manifest["packet_id"]
        or metadata.get("providerPacketVersion") != manifest["version"]
        or metadata.get("sourceVersion") != versions[document_id]
        or original.get("sourceVersion") != versions[document_id]
        or any(metadata.get(key) != original.get(key) for key in ("id", "name", "mimeType"))
        or metadata.get("shareable") is not True
        or metadata.get("indexedEvidence") is not None
        or not discovery_evidence_matches(
            metadata,
            user_id=row["user_id"],
            generation=row["connection_generation"],
            checkpoint=expected,
        )
    ):
        raise DriveSharingError("package_changed")
    fingerprint = _json_digest(
        {
            "basis": "provider_metadata",
            **{key: metadata[key] for key in ("id", "name", "mimeType", "sourceVersion")},
        }
    )
    expected_fields = {
        "contentFingerprint": fingerprint,
        "fingerprintBasis": "provider_metadata",
        "metadataOnly": True,
    }
    if any(
        metadata.get(key) != value and (not materialize or key in metadata)
        for key, value in expected_fields.items()
    ):
        raise DriveSharingError("package_changed")
    metadata.update(
        contentFingerprint=fingerprint, fingerprintBasis="provider_metadata", metadataOnly=True
    )
    source = {
        "position": position,
        "file_digest": item["file_digest"],
        "source_version": versions[document_id],
        "content_fingerprint": fingerprint,
        "fingerprint_basis": "provider_metadata",
        "provider_document_id": document_id,
        "evidence_digest": _json_digest(
            {"manifest_digest": manifest["digest"], "metadata": metadata}
        ),
    }
    return source, metadata


def provider_sources(store, connection, row, checkpoint, manifest, *, materialize=False):
    from hushh_mcp.services.drive_request_package_store import _HASH

    rows = list(
        connection.execute(
            text("""SELECT position,file_digest,metadata_envelope,evaluated_at
            FROM drive_owner_search_results WHERE user_id=:user AND job_id=:job
            ORDER BY position LIMIT 121"""),
            {"user": row["user_id"], "job": row["job_id"]},
        ).mappings()
    )
    ids = [source["document_id"] for source in manifest["sources"]]
    if (
        not 1 <= len(rows) <= 120
        or len(rows) != row["matched"]
        or len(rows) != len(ids)
        or len(set(ids)) != len(ids)
        or set(ids) != set(manifest["selected_document_ids"])
        or any(item["evaluated_at"] is not None for item in rows)
    ):
        raise DriveSharingError("package_changed")
    sources, preview, seen, file_ids = [], [], set(), set()
    for item in rows:
        source, metadata = provider_result(
            store, row, checkpoint, manifest, item, materialize=materialize
        )
        if (
            source["provider_document_id"] in seen
            or metadata["id"] in file_ids
            or not isinstance(item["file_digest"], str)
            or not _HASH.fullmatch(item["file_digest"])
        ):
            raise DriveSharingError("package_changed")
        seen.add(source["provider_document_id"])
        file_ids.add(metadata["id"])
        sources.append(source)
        if len(preview) < 25:
            preview.append(
                {
                    "position": item["position"],
                    "name": metadata["name"][:500],
                    "weightageOutOf10": None,
                    "confidenceScore": None,
                }
            )
        if materialize:
            connection.execute(
                text("""UPDATE drive_owner_search_results SET metadata_envelope=CAST(:envelope AS jsonb)
                    WHERE user_id=:user AND job_id=:job AND position=:position"""),
                {
                    "user": row["user_id"],
                    "job": row["job_id"],
                    "position": item["position"],
                    "envelope": store._seal(
                        metadata,
                        row["user_id"],
                        f"{row['job_id']}:{item['position']}",
                        "owner-search-result",
                    ),
                },
            )
    return sources, preview


async def finalize_provider_packet(store, job):
    """Freeze provider-query membership; no content assessment or owner approval."""

    from hushh_mcp.services.drive_request_package_store import (
        MAX_PACKAGE_BYTES,
        PACKAGE_KEY,
        _public_package,
    )

    def operation(connection):
        row, request, checkpoint = store._evaluation_current(connection, job)
        manifest = store._provider_manifest(connection, row, checkpoint)
        sources, preview = provider_sources(
            store, connection, row, checkpoint, manifest, materialize=True
        )
        package = {
            "schema_version": PROVIDER_PACKAGE_VERSION,
            "basis": "provider_discovery",
            "content_assessment": "not_applicable_by_delivery_policy",
            "policy_version": PROVIDER_PACKAGE_POLICY,
            "revision": checkpoint.get(PACKAGE_KEY, {}).get("revision", 0) + 1,
            "request_revision": request["revision"],
            "connection_generation": row["connection_generation"],
            "reusable_packet": checkpoint["reusable_packet"],
            "provider_manifest_digest": manifest["digest"],
            "selected_positions": [source["position"] for source in sources],
            "counts": {"candidates": len(sources), "evaluated": 0, "unreadable": 0},
            "summary": "Google Drive query matches for this closed two-month metadata window.",
            "price_cents": manifest["price_cents"],
            "preview": preview,
        }
        package["digest"] = store._digest(row, request, package, sources)
        if len(json.dumps(package, ensure_ascii=False).encode()) > MAX_PACKAGE_BYTES:
            raise DriveSharingError("package_budget_exceeded")
        checkpoint[PACKAGE_KEY] = package
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb),
                evaluation_status='ready',evaluation_error_code=NULL,lease_id=NULL,
                lease_expires_at=NULL,revision=revision+1,updated_at=clock_timestamp()
                WHERE user_id=:user AND job_id=:job"""),
            {
                "user": row["user_id"],
                "job": row["job_id"],
                "envelope": store._seal(
                    checkpoint, row["user_id"], str(row["job_id"]), "owner-search-checkpoint"
                ),
            },
        )
        return _public_package(package, status="ready")

    return await store._transaction(operation)


def validate_provider_package(
    store, connection, search, request, checkpoint, package, package_revision, package_digest
):
    from hushh_mcp.services.drive_request_package_store import _public_package

    manifest = store._provider_manifest(connection, search, checkpoint)
    sources, _ = provider_sources(store, connection, search, checkpoint, manifest)
    if (
        search["evaluation_status"] != "ready"
        or package.get("revision") != package_revision
        or package.get("request_revision") != request["revision"]
        or package.get("connection_generation") != search["connection_generation"]
        or package.get("reusable_packet") != checkpoint["reusable_packet"]
        or package.get("provider_manifest_digest") != manifest["digest"]
        or package.get("price_cents") != manifest["price_cents"]
        or package.get("content_assessment") != "not_applicable_by_delivery_policy"
        or "assessment" in package
        or package.get("selected_positions") != [source["position"] for source in sources]
        or not hmac.compare_digest(str(package.get("digest", "")), package_digest)
        or not hmac.compare_digest(store._digest(search, request, package, sources), package_digest)
    ):
        raise DriveSharingError("package_changed")
    return {
        "basis": "provider_discovery",
        "price_cents": package["price_cents"],
        "buyer_disclosure": _provider_disclosure(package),
        "summary": _public_package(package, status="ready"),
        "selected_positions": package["selected_positions"],
        "selected_sources": sources,
        "search_job_id": str(search["job_id"]),
    }


def provider_public_package(package, result):
    if _provider_package(package):
        result.update(
            confidenceScore=None,
            confidenceBasis="provider_search",
            importanceScore=None,
            evaluatedCount=0,
            suggestedPriceCents=package["price_cents"],
            priceReason="One-time price for this exact packet.",
            summary=package["summary"],
            coverageStatus="unknown",
            gaps=["File contents and financial coverage were not assessed."],
            selectedFiles=package.get("preview", []),
            selectedFileCount=len(package["selected_positions"]),
        )
    return result


def provider_package_digest(store, row, request, package, sources):
    return store.search_cipher.digest(
        "request-provider-packet-v1",
        [
            row["user_id"],
            request["recipient_user_id"],
            str(request["request_id"]),
            request["revision"],
            row["connection_generation"],
            {key: value for key, value in package.items() if key != "digest"},
            sources,
        ],
    )


async def run_provider_package(service, job):
    manifest = await service._reusable_manifest(job)
    if not isinstance(manifest, dict) or (
        manifest.get("kind") != "provider_discovery" or manifest.get("schema_version") != 2
    ):
        raise DriveReadError("source_changed")
    await service.store.require_evaluation_current(job)
    result = await service.store.finalize_provider_packet(job)
    logger.info(
        "drive_request_provider_packet status=%s content_assessment=not_applicable",
        result["status"],
    )
    return result["status"]


async def run_packages(
    service, *, max_jobs=1, deadline_seconds=120, v1_only=False, provider_only=False
):
    counts = Counter()
    try:
        async with asyncio.timeout(deadline_seconds):
            for job in await service.store.due_evaluations(
                limit=max_jobs,
                **({"v1_only": True} if v1_only else {}),
                **({"provider_only": True} if provider_only else {}),
            ):
                result = await service.run_one(
                    user_id=job["user_id"],
                    job_id=str(job["job_id"]),
                    v1_only=v1_only,
                    **({"provider_only": True} if provider_only else {}),
                )
                counts[result] += 1
    except TimeoutError:
        counts["deadline"] += 1
    return dict(counts)
