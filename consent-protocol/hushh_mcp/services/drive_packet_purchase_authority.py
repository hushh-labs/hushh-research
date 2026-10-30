"""Atomic catalog purchase binding and reviewed exact-package price authority."""

import os
from collections.abc import Mapping
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_owner_allowed import automatic_recipient_current, package_allow_marker
from hushh_mcp.services.drive_request_review_policy import request_requires_owner_review
from hushh_mcp.services.drive_sharing_contract import DriveSharingError


def require_current_packet_purchase(connection, *, request: Mapping, private: Mapping) -> None:
    """Fence new purchase effects against withdrawal of the exact private listing.

    This narrow policy check adds no graph locks or provider calls. Its callers
    retain ownership of participant, Allow, source and payment authority. A
    listing price edit does not change the sealed quote; withdrawal or a newer
    packet version stops new checkout and undispatched delivery. Reconciliation
    of an already dispatched permission remains a separate, unchanged path.
    """
    binding = private.get("reusable_packet")
    packet_id, version = request.get("reusable_packet_id"), request.get("reusable_packet_version")
    if binding is None and packet_id is None and version is None:
        return
    try:
        valid_binding = (
            isinstance(binding, dict)
            and str(UUID(str(packet_id))) == str(UUID(str(binding.get("packetId"))))
            and type(version) is int
            and type(binding.get("version")) is int
            and version == binding["version"]
            and binding.get("ownerUserId") == request.get("user_id")
            and isinstance(binding.get("manifestDigest"), str)
            and bool(binding["manifestDigest"])
        )
    except (ValueError, TypeError, AttributeError):
        valid_binding = False
    if not valid_binding:
        raise DriveSharingError("packet_unavailable")
    parameters = {"packet": str(packet_id), "version": version, "owner": request["user_id"]}
    current = (
        connection.execute(
            text("""SELECT h.current_version,h.connection_generation,
          v.connection_generation AS version_generation,v.digest,v.state,v.available,
          v.document_count FROM drive_packet_heads h
          JOIN drive_packet_versions v ON v.packet_id=h.packet_id AND v.version=:version
            AND v.user_id=h.user_id
          WHERE h.packet_id=:packet AND h.user_id=:owner FOR SHARE OF h,v"""),
            parameters,
        )
        .mappings()
        .first()
    )
    if (
        current is None
        or current["current_version"] != version
        or current["connection_generation"] != current["version_generation"]
        or current["digest"] != binding["manifestDigest"]
        or current["state"] != "ready"
        or current["available"] is not True
        or not 0 < current["document_count"] <= 120
    ):
        raise DriveSharingError("packet_unavailable")
    listing = (
        connection.execute(
            text("""SELECT enabled FROM drive_packet_listings
          WHERE packet_id=:packet AND version=:version AND user_id=:owner FOR SHARE"""),
            parameters,
        )
        .mappings()
        .first()
    )
    if listing is None or listing["enabled"] is not True:
        raise DriveSharingError("packet_unavailable")


def current_package_allow(store, connection, request, *, search_job_id, generation):
    """Preserve the existing sealed Allow checks, then apply listing withdrawal."""
    private = store._open(
        request["request_envelope"],
        user_id=request["user_id"],
        resource_id=str(request["request_id"]),
        purpose="request",
    )
    if private.get("agent_package_required") is not True:
        return None
    marker = package_allow_marker(private)
    if (
        marker is None
        or marker["request_revision"] != request["revision"]
        or marker["search_job_id"] != str(search_job_id)
        or marker["connection_generation"] != generation
        or request_requires_owner_review(
            connection,
            user_id=request["user_id"],
            request_id=request["request_id"],
            revision=request["revision"],
            cipher=store.cipher,
            search_job_id=search_job_id,
        )
        or not automatic_recipient_current(
            connection,
            request["user_id"],
            request["recipient_user_id"],
            private,
            request_id=request["request_id"],
        )
    ):
        raise DriveSharingError("package_not_allowed")
    require_current_packet_purchase(connection, request=request, private=private)
    return marker


def require_checkout_disclosure(*, request, private):
    """Validate the existing buyer disclosure without changing its shape or basis."""
    from hushh_mcp.services.drive_request_checkout_refusals import checkout_refusal
    from hushh_mcp.services.drive_request_package_disclosure import (
        buyer_package_disclosure,
        manual_buyer_disclosure,
    )

    if private.get("agent_package_required") is True:
        disclosure = buyer_package_disclosure(
            private,
            request_revision=request["revision"],
            owner_allowed_at=request["owner_allowed_at"],
        )
    elif private.get("v1_live_request") is True:
        disclosure = manual_buyer_disclosure(private, request_revision=request["revision"])
    else:
        disclosure = True
    if disclosure is None:
        raise checkout_refusal("disclosure_missing")


def packet_purchase(
    store,
    connection,
    *,
    owner_user_id,
    recipient,
    binding,
    reusable_packet,
    owner_initiated,
    legacy_flow,
):
    if reusable_packet is None:
        return None, None
    period_enabled = os.getenv("DRIVE_PERIOD_PACKETS_ENABLED", "").strip().lower() == "true"
    if legacy_flow and not period_enabled:
        raise DriveSharingError("packet_unavailable")
    if not isinstance(reusable_packet, dict) or not {
        "packetId",
        "version",
        "manifestDigest",
        "listingRevision",
        "priceCents",
        "ownerUserId",
    }.issubset(reusable_packet):
        raise DriveSharingError("invalid_argument")
    from hushh_mcp.services.drive_packet_store import DrivePacketStore
    from hushh_mcp.services.drive_period_packet_reader import period_purchases_enabled

    manifest = DrivePacketStore(db=store.db, cipher=store.cipher)._current_packet_manifest(
        connection,
        owner_user_id=owner_user_id,
        packet_id=reusable_packet["packetId"],
        version=reusable_packet["version"],
        viewer_user_id=recipient.user_id,
    )
    provider_packet = manifest.get("kind") == "provider_discovery" and period_enabled
    if provider_packet and not period_purchases_enabled() or legacy_flow and not provider_packet:
        raise DriveSharingError("packet_unavailable")
    if (
        owner_initiated
        or manifest["state"] != "ready"
        or manifest["digest"] != reusable_packet["manifestDigest"]
        or manifest["listing_revision"] != reusable_packet["listingRevision"]
        or manifest["price_cents"] != reusable_packet["priceCents"]
        or reusable_packet["ownerUserId"] != owner_user_id
    ):
        raise DriveSharingError("packet_changed")
    # The caller holds the participant graph locks. Different client UUIDs
    # resume one exact-version purchase instead of creating another charge.
    previous = store._row(
        connection,
        """SELECT * FROM drive_share_requests
           WHERE user_id=:owner AND recipient_user_id=:recipient
             AND recipient_binding=:binding
             AND reusable_packet_id=:packet AND reusable_packet_version=:version
             AND access_stop_requested_at IS NULL
             AND status IN ('pending','preparing','review_ready','approved','completed','partial')
             AND (expires_at>clock_timestamp() OR status IN ('approved','completed','partial'))
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE""",
        {
            "owner": owner_user_id,
            "recipient": recipient.user_id,
            "binding": binding,
            "packet": reusable_packet["packetId"],
            "version": reusable_packet["version"],
        },
    )
    if previous:
        return manifest, {
            **store._summary(previous, recipient=True),
            **store._request_setup(connection, previous, store._open_request(previous)),
            "recipientEmail": recipient.email,
            "existingAccess": previous["status"] == "completed",
        }
    return manifest, None


def reviewed_package(
    store, connection, row, private, package_revision, package_digest, amount_cents
):
    if private.get("agent_package_required") is not True:
        return None
    from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore

    package = DriveRequestPackageStore(
        db=store.db, cipher=store.sharing_cipher, sharing=store
    ).validate_ready_package(connection, row, private, package_revision, package_digest)
    if (
        package.get("basis") == "provider_discovery"
        and row["payment_required"] is True
        and amount_cents != package["price_cents"]
    ):
        raise DriveSharingError("invalid_payment_amount")
    return package
