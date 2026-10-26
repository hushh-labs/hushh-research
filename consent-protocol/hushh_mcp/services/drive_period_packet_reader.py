"""Pure public/owner projections for the existing provider packet tables."""

from __future__ import annotations

import os
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_live_reader import _open_url
from hushh_mcp.services.drive_packet_contract import evidence_digest
from hushh_mcp.services.drive_packet_display import packet_file_label
from hushh_mcp.services.drive_period_packet_contract import (
    PERIOD_PACKET_POLICY,
    PERIOD_PACKET_PRICE_CENTS,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError


def period_purchases_enabled():
    return os.getenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "").strip().lower() == "true"


def require_period_purchase():
    if not period_purchases_enabled():
        raise DriveReadError("packet_unavailable")


def packet_count_projection(row):
    """Project saved search counts independently of immutable sale membership."""
    frozen = row["current_version"] > 0
    sale_count = row.get("document_count") if frozen else None
    # A refreshed owner search can advance while its older sale stays unchanged.
    discovery = (
        row.get("preview_document_count") is not None
        or row.get("preview_updated_at") is not None
        or row.get("preview_complete", False)
    )
    count = row.get("preview_document_count") if discovery else sale_count
    complete = (
        row.get("preview_complete", False) if discovery else frozen and sale_count is not None
    )
    if discovery and count == 0 and not complete:
        count = None  # An unfinished search has not established an empty result.
    updated = row.get("preview_updated_at") if discovery else row.get("version_updated_at")
    return {
        "documentCount": count,
        "countBasis": "discovery_matches" if discovery or not frozen else "sale_files",
        "saleDocumentCount": sale_count,
        "complete": bool(complete),
        "updatedAt": updated.isoformat() if updated else None,
    }


def current_manifest(store, connection, *, owner_user_id, packet_id, version, viewer_user_id=None):
    active = store._period_access(connection, owner=owner_user_id, viewer=viewer_user_id)
    row = store._row(
        connection,
        """SELECT h.*,v.* FROM drive_packet_heads h JOIN drive_packet_versions v
      ON v.packet_id=h.packet_id AND v.version=:version WHERE h.user_id=:user
      AND h.packet_id=:id AND h.packet_kind='provider_discovery' FOR SHARE OF h""",
        {"user": owner_user_id, "id": str(UUID(str(packet_id))), "version": version},
    )
    if (
        not row
        or row["current_version"] != version
        or row["policy_version"] != PERIOD_PACKET_POLICY
        or not row["available"]
        or row["connection_generation"] != active["connection_generation"]
    ):
        raise DriveReadError("packet_unavailable")
    listing = store._row(
        connection,
        "SELECT * FROM drive_packet_listings WHERE packet_id=:id AND version=:version FOR SHARE",
        {"id": row["packet_id"], "version": version},
    )
    if (
        viewer_user_id
        and viewer_user_id != owner_user_id
        and (not listing or not listing["enabled"])
    ):
        raise DriveReadError("packet_unavailable")
    manifest = store._manifest(row)
    if (
        evidence_digest(manifest) != row["digest"]
        or manifest["state"] != "ready"
        or not 0 < len(manifest["sources"]) <= 120
    ):
        raise DriveReadError("packet_integrity_invalid")
    return {
        **manifest,
        "digest": row["digest"],
        "listing_revision": listing["revision"] if listing else 0,
        "price_cents": PERIOD_PACKET_PRICE_CENTS,
    }


def project_packet(store, row, *, is_owner, owner_contents):
    manifest = store._manifest(row) if row["version"] else None
    ready = bool(manifest and manifest["state"] == "ready" and row["available"])
    state = (
        manifest["state"] if manifest else "unable_to_verify" if row["error_code"] else "building"
    )
    key = store._key(row)
    counts = packet_count_projection(row)
    result = {
        "packetId": str(row["packet_id"]),
        "version": row["version"] or 0,
        "kind": "provider_discovery",
        "category": row["category"],
        "periodStart": row["period_start"].isoformat(),
        "periodEnd": row["period_end"].isoformat(),
        "timezone": row["period_timezone"],
        "state": state,
        "title": key["title"],
        "description": "Files found by Google Drive search.",
        "coverageSummary": "Files selected by provider search and metadata dates.",
        "documentCount": counts["documentCount"],
        "saleDocumentCount": counts["saleDocumentCount"],
        "priceCents": PERIOD_PACKET_PRICE_CENTS,
        "listingRevision": row["listing_revision"] or 0,
        "listingEnabled": bool(row["listing_enabled"]),
        "canRequest": ready
        and bool(row["listing_enabled"])
        and not is_owner
        and period_purchases_enabled(),
        "freshness": "current" if ready else "stale",
        "canList": ready and is_owner and period_purchases_enabled(),
        "requestId": str(row["buyer_request_id"]) if row.get("buyer_request_id") else None,
        "purchaseState": (
            "delivered"
            if row.get("buyer_status") in {"completed", "partial"}
            else "paid"
            if row.get("buyer_payment_status") == "paid"
            else "pending"
            if row.get("buyer_request_id")
            else "none"
        ),
    }
    if is_owner and owner_contents:
        from hushh_mcp.services.drive_packet_public_summary import owner_public_summary
        from hushh_mcp.services.drive_period_packet_preview import preview_summary

        result["publicSummary"] = owner_public_summary(row)
        result["preview"] = preview_summary(store, row)
        documents = []
        for source in list((manifest or {}).get("source_metadata", {}).values())[:120]:
            documents.append(
                {
                    "name": packet_file_label(source["name"]),
                    "type": None,
                    "pages": None,
                    "period": None,
                    "viewUrl": _open_url(source["id"], source.get("openUrl")),
                }
            )
        result["contents"] = {
            "period": {"start": result["periodStart"], "end": result["periodEnd"]},
            "documents": documents,
        }
    return result


async def list_packets(
    store, *, user_id, owner_user_id=None, cursor=None, limit=25, owner_contents=False
):
    from hushh_mcp.services.owner_placement_guard import admit_hub_content

    owner = owner_user_id or user_id
    await admit_hub_content(owner, "drive_period_packet_catalog")

    def operation(connection):
        active = store._period_access(connection, owner=owner, viewer=user_id)
        rows = connection.execute(
            text("""SELECT h.*,v.version,v.manifest_envelope,v.state,v.available,
          COALESCE(p.financial_summary_enabled,TRUE) AS financial_summary_enabled,
          COALESCE(p.financial_summary_revision,0) AS financial_summary_revision,
          v.document_count,l.revision AS listing_revision,l.enabled AS listing_enabled,
          buyer.request_id AS buyer_request_id,buyer.status AS buyer_status,
          buyer.payment_status AS buyer_payment_status
          FROM drive_packet_heads h LEFT JOIN drive_packet_versions v
          ON v.packet_id=h.packet_id AND v.version=h.current_version
          LEFT JOIN drive_live_preferences p ON p.user_id=h.user_id
          LEFT JOIN drive_packet_listings l ON l.packet_id=v.packet_id AND l.version=v.version
          LEFT JOIN LATERAL (SELECT r.request_id,r.status,o.status AS payment_status
            FROM drive_share_requests r LEFT JOIN drive_request_payment_orders o ON o.request_id=r.request_id
            WHERE NOT :is_owner AND r.user_id=h.user_id AND r.recipient_user_id=:viewer
              AND r.reusable_packet_id=h.packet_id AND r.reusable_packet_version=v.version
              AND r.access_stop_requested_at IS NULL
              AND r.status IN ('pending','preparing','review_ready','approved','completed','partial')
              AND (r.expires_at>clock_timestamp() OR r.status IN ('approved','completed','partial'))
            ORDER BY r.created_at DESC LIMIT 1) buyer ON TRUE
          WHERE h.user_id=:owner AND h.connection_generation=:generation
            AND h.packet_kind='provider_discovery' AND (:after IS NULL OR h.packet_id>CAST(:after AS uuid))
            AND (:is_owner OR l.enabled OR buyer.request_id IS NOT NULL)
          ORDER BY h.packet_id LIMIT :limit"""),
            {
                "owner": owner,
                "viewer": user_id,
                "generation": active["connection_generation"],
                "after": str(UUID(cursor)) if cursor else None,
                "is_owner": user_id == owner,
                "limit": max(1, min(100, limit)) + 1,
            },
        ).mappings()
        return [
            project_packet(store, row, is_owner=user_id == owner, owner_contents=owner_contents)
            for row in rows
        ]

    return await store._transaction(operation)


def resolve_period_manifest(store, connection, owner_user_id, packet_id, version, viewer_user_id):
    kind = store._row(
        connection,
        "SELECT packet_kind FROM drive_packet_heads WHERE packet_id=:id AND user_id=:user",
        {"id": str(UUID(packet_id)), "user": owner_user_id},
    )
    if kind and kind["packet_kind"] == "provider_discovery":
        from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

        return DrivePeriodPacketStore(db=store.db).period_manifest_locked(
            connection,
            owner_user_id=owner_user_id,
            packet_id=packet_id,
            version=version,
            viewer_user_id=viewer_user_id,
        )
    return None
