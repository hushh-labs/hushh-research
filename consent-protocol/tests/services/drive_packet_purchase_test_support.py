"""Synthetic exact-packet purchase withdrawal scenarios shared by regression tests."""

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_contract import DriveSharingError


def _assert_packet_purchase_fenced(sharing, request_id):
    from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
    from hushh_mcp.services.drive_owner_allowed import package_allow_marker

    with sharing.db.engine.begin() as connection:
        with pytest.raises(DriveSharingError, match="packet_unavailable"):
            DriveRequestPaymentService(db=sharing.db)._current_checkout_authority(
                connection, request_id=request_id, requester_user_id="recipient"
            )
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request_id)
        marker = package_allow_marker(sharing._open_request(row))
        with pytest.raises(DriveSharingError, match="packet_unavailable"):
            DriveBulkShareStore(db=sharing.db)._package_allow(
                connection,
                row,
                search_job_id=marker["search_job_id"],
                generation=marker["connection_generation"],
            )


async def _claim_paid_packet(sharing, frozen, request_id):
    from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore

    bulk = DriveBulkShareStore(db=sharing.db)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='paid',paid_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": request_id},
        )
    await bulk.approve(
        user_id="owner",
        share_id=frozen["shareId"],
        revision=frozen["revision"],
        review_digest=frozen["reviewDigest"],
        approval_source="trusted_auto",
    )
    job = await bulk.claim(
        user_id="owner", share_id=frozen["shareId"], position=1, recipient_user_id="recipient"
    )
    assert job is not None
    return bulk, job


async def _withdraw_before_dispatch(sharing, reusable, packet, payment, frozen, request_id, change):
    job = None
    if change in {"disable_paid", "disable_unknown"}:
        bulk, job = await _claim_paid_packet(sharing, frozen, request_id)
        if change == "disable_unknown":
            await bulk.mark_dispatching(job)
    with sharing.db.engine.connect() as connection:
        before = dict(
            connection.execute(
                text("SELECT * FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
    if change == "supersede":
        with sharing.db.engine.begin() as connection:
            connection.execute(text("UPDATE drive_packet_heads SET current_version=2"))
    else:
        await reusable.packets.set_listing(
            user_id="owner",
            packet_id=packet["packetId"],
            version=1,
            decision="deny",
            price_cents=125,
            expected_revision=1,
            disclosure=None,
        )
    _assert_packet_purchase_fenced(sharing, request_id)
    if job is not None:
        with pytest.raises(DriveSharingError, match="bulk_changed"):
            await bulk.mark_dispatching(job)
        if change == "disable_unknown":
            # A POST which may already have reached Google is still reconciled.
            await bulk.require_reconciliation_current(job)
    else:
        with pytest.raises(DriveSharingError, match="payment_not_ready"):
            await payment.checkout(requester_user_id="recipient", request_id=request_id)
    with sharing.db.engine.connect() as connection:
        after = dict(
            connection.execute(
                text("SELECT * FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        assert after == before
        assert connection.execute(
            text("""SELECT count(*) FROM drive_bulk_share_effects
          WHERE state IN ('dispatching','succeeded','unknown','preexisting')""")
        ).scalar_one() == (1 if change == "disable_unknown" else 0)
    payment.stripe_api.checkout.Session.create.assert_called_once()
