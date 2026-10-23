"""Atomic catalog purchase binding and reviewed exact-package price authority."""

import os

from hushh_mcp.services.drive_sharing_contract import DriveSharingError


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
    from hushh_mcp.services.drive_packet_store import DrivePacketStore
    from hushh_mcp.services.drive_period_packet_reader import period_purchases_enabled

    manifest = DrivePacketStore(db=store.db, cipher=store.cipher)._current_packet_manifest(
        connection,
        owner_user_id=owner_user_id,
        packet_id=reusable_packet["packetId"],
        version=reusable_packet["version"],
        viewer_user_id=recipient.user_id,
    )
    provider_packet = (
        manifest.get("kind") == "provider_discovery"
        and os.getenv("DRIVE_PERIOD_PACKETS_ENABLED", "").strip().lower() == "true"
    )
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
