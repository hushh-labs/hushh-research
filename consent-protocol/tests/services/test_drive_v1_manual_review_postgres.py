"""Non-Trusted V1 offers only assessed files through the existing owner flow."""

# ruff: noqa: F401, F811 -- pytest imports shared disposable database fixtures

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_agent_package_flow_postgres import (
    agent_flow,
    prepared_package,
    recipient,
    request_bulk,
    sharing,
)
from tests.services.test_drive_request_package_store_postgres import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    packages,
)


@pytest.mark.parametrize("delivery_state", ["succeeded", "preexisting"])
async def test_nontrusted_v1_filters_results_and_approves_only_verified_subset(
    agent_flow, request_bulk, sharing, delivery_state
):
    created, search_id, _ = await prepared_package(
        agent_flow, request_bulk, sharing, count=3, selected=2, v1_ready=True
    )
    service = DriveRequestBulkService(
        sharing=sharing,
        search=DriveOwnerSearchService(store=DriveOwnerSearchStore(db=sharing.db)),
        bulk=request_bulk,
        recipient_identity=AsyncMock(return_value=recipient()),
        require_owner=AsyncMock(),
    )
    page = await service.search_files(user_id="owner", request_id=created["requestId"])
    assert page["jobId"] == search_id
    assert [item["position"] for item in page["files"]] == [1, 2]
    assert all(item["confidenceScore"] >= 80 for item in page["files"])
    assert all(1 <= item["weightageOutOf10"] <= 10 for item in page["files"])
    assert page["nextCursor"] is None

    with pytest.raises(DriveReadError):
        await service.prepare(user_id="owner", request_id=created["requestId"], positions=[3])
    frozen = await service.prepare(user_id="owner", request_id=created["requestId"], positions=[2])
    assert frozen["positions"] == [2]
    approved = await request_bulk.approve(
        user_id="owner",
        share_id=frozen["shareId"],
        revision=frozen["revision"],
        review_digest=frozen["reviewDigest"],
        approval_source="owner",
    )
    assert approved["status"] == "queued"
    sources = await request_bulk.legacy_manual_checkout_sources(
        user_id="owner", request_id=created["requestId"]
    )
    assert len(sources) == 1
    assert sources[0]["name"] == page["files"][1]["name"]
    assert all(
        sources[0][key]
        for key in ("packageDigest", "sourceVersion", "contentFingerprint", "evidenceDigest")
    )
    buyer_context = await sharing.requester_context(
        user_id="recipient", request_id=created["requestId"]
    )
    buyer_disclosure = buyer_context["packageDisclosure"]
    assert buyer_disclosure["selectedCount"] == 1
    assert buyer_disclosure["coverageStatus"] == "unknown"
    assert buyer_disclosure["periods"] == [] and buyer_disclosure["limitations"]
    assert "Unrelated old record" not in str(buyer_disclosure)
    from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore

    payment = await DriveRequestPaymentStore(db=sharing.db).payment_state(
        requester_user_id="recipient", request_id=created["requestId"]
    )
    assert payment["paymentView"]["packageDisclosureRequired"] is True
    assert payment["paymentView"]["packageDisclosure"] == buyer_disclosure
    repeated = await request_bulk.approve(
        user_id="owner",
        share_id=frozen["shareId"],
        revision=frozen["revision"],
        review_digest=frozen["reviewDigest"],
        approval_source="owner",
    )
    assert repeated["shareId"] == approved["shareId"]
    assert repeated["revision"] == approved["revision"]
    with sharing.db.engine.begin() as connection:
        request = sharing._request(connection, "owner", created["requestId"])
        marker = sharing._open_request(request)["v1_manual_review"]
        assert marker["selected_positions"] == [1, 2]  # evaluated suggestions remain evidence
        assert marker["approved_positions"] == [2]  # the owner chose this exact purchase
        assert marker["approved_share_id"] == frozen["shareId"]
    with pytest.raises(DriveReadError):
        await service.prepare(user_id="owner", request_id=created["requestId"], positions=[1])

    # Simulate confirmed payment/delivery in disposable PostgreSQL. No Stripe
    # request or Google permission operation is issued by this regression.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='paid',
                stripe_payment_intent_id='pi_test_manual_subset',paid_at=clock_timestamp()
                WHERE request_id=:request"""),
            {"request": created["requestId"]},
        )
        connection.execute(
            text("UPDATE drive_bulk_share_effects SET state=:state WHERE share_id=:share"),
            {"share": frozen["shareId"], "state": delivery_state},
        )
        request_bulk._finalize(connection, frozen["shareId"])
        request = sharing._request(connection, "owner", created["requestId"])
        assert request["status"] == "completed"
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_share_effects WHERE share_id=:share"),
                {"share": frozen["shareId"]},
            ).scalar_one()
            == 1
        )
        payout = DriveRequestOwnerPayoutService(db=sharing.db)
        assert payout._advance_delivery(connection, created["requestId"], v1_only=True) == (
            "awaiting_fee" if delivery_state == "succeeded" else "awaiting_refund"
        )
        settled = (
            connection.execute(
                text("""SELECT expected_files,confirmed_files,retained_amount_cents,refund_amount_cents
                FROM drive_request_owner_payouts WHERE request_id=:request"""),
                {"request": created["requestId"]},
            )
            .mappings()
            .one()
        )
        assert dict(settled) == {
            "expected_files": 1,
            "confirmed_files": int(delivery_state == "succeeded"),
            "retained_amount_cents": request["quoted_amount_cents"]
            if delivery_state == "succeeded"
            else 0,
            "refund_amount_cents": 0
            if delivery_state == "succeeded"
            else request["quoted_amount_cents"],
        }
    with pytest.raises(DriveReadError):
        await service.prepare(user_id="owner", request_id=created["requestId"], positions=[1])
    if delivery_state == "preexisting":
        from hushh_mcp.services.drive_request_payment_refunds import _claim_refunds
        from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService

        with sharing.db.engine.begin() as connection:
            claims = _claim_refunds(
                DriveRequestPaymentService(db=sharing.db), connection, limit=1, v1_only=True
            )
            assert len(claims) == 1
            assert claims[0]["amount_cents"] == request["quoted_amount_cents"]


@pytest.mark.parametrize("interrupted", [False, True])
async def test_v1_access_period_is_owner_bounded_paid_frozen_and_automatically_removed(
    agent_flow, request_bulk, sharing, interrupted
):
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.services.drive_request_bulk_removal_store import DriveRequestBulkRemovalStore

    created, _, _ = await prepared_package(
        agent_flow, request_bulk, sharing, count=2, selected=2, v1_ready=True, access_days=30
    )
    assert created["requestedAccessDays"] == 30
    assert created["accessExpiresAt"] is None
    service = DriveRequestBulkService(
        sharing=sharing,
        search=DriveOwnerSearchService(store=DriveOwnerSearchStore(db=sharing.db)),
        bulk=request_bulk,
        recipient_identity=AsyncMock(return_value=recipient()),
        require_owner=AsyncMock(),
    )
    frozen = await service.prepare(
        user_id="owner", request_id=created["requestId"], positions=[1, 2] if interrupted else [1]
    )
    assert frozen["requestedAccessDays"] == 30
    approval = dict(
        user_id="owner",
        share_id=frozen["shareId"],
        revision=frozen["revision"],
        review_digest=frozen["reviewDigest"],
        approval_source="owner",
    )
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await request_bulk.approve(**approval, access_days=31)
    approved = await request_bulk.approve(**approval, access_days=7)
    assert approved["approvedAccessDays"] == 7
    assert approved["accessExpiresAt"] is None
    with pytest.raises(DriveReadError, match="bulk_changed"):
        await request_bulk.approve(**approval, access_days=30)
    claim = dict(
        user_id="owner",
        share_id=frozen["shareId"],
        position=1,
        recipient_user_id="recipient",
        v1_only=True,
    )
    # Unpaid, the V1 queue leaves the approved grant out and a direct claim
    # defers it without changing anything, so payment can still unlock it.
    assert frozen["shareId"] not in {
        str(row["share_id"]) for row in await request_bulk.due(v1_only=True)
    }
    assert await request_bulk.claim(**claim) is None
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='paid',
            stripe_payment_intent_id='pi_test_period',paid_at=clock_timestamp()
            WHERE request_id=:request"""),
            {"request": created["requestId"]},
        )
    job = await request_bulk.claim(**claim)
    assert job is not None
    expiration = await request_bulk.mark_dispatching(job)
    assert (
        timedelta(days=6, hours=23)
        < datetime.fromisoformat(expiration) - datetime.now(UTC)
        <= timedelta(days=7)
    )
    assert await request_bulk.mark_dispatching(job) == expiration
    requester_view = await sharing.requester_context(
        user_id="recipient", request_id=created["requestId"]
    )
    assert requester_view["requestedAccessDays"] == 30
    assert requester_view["approvedAccessDays"] == 7
    assert requester_view["accessExpiresAt"] == expiration
    await request_bulk.settle(
        job,
        state="succeeded",
        receipt={
            "managed": True,
            "permission_id": "permission-test-period",
            "email": "b@example.invalid",
            "issuer": {"subject": "owner-google", "oauthClientId": "synthetic-client"},
            "provenance": "successful_create_after_absence_check",
            "expiration_time": expiration,
        },
    )
    removals = DriveRequestBulkRemovalStore(db=sharing.db, cipher=sharing.sharing_cipher)
    assert await removals.materialize(v1_only=True) == 0
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", created["requestId"])
        assert row["status"] == ("pending" if interrupted else "completed")
        assert row["access_stop_requested_at"] is None
        connection.execute(
            text("""UPDATE drive_share_requests
            SET access_expires_at=clock_timestamp()-INTERVAL '1 second'
            WHERE request_id=:request"""),
            {"request": created["requestId"]},
        )
    assert await removals.materialize(v1_only=True) == 1
    if interrupted:
        assert await request_bulk.claim(**{**claim, "position": 2}) is None
        with sharing.db.engine.begin() as connection:
            row = sharing._request(connection, "owner", created["requestId"])
            assert row["status"] == "partial"
            assert (
                DriveRequestOwnerPayoutService(db=sharing.db)._advance_delivery(
                    connection, created["requestId"], v1_only=True
                )
                == "awaiting_refund"
            )
            payout = (
                connection.execute(
                    text("""SELECT expected_files,confirmed_files,refund_amount_cents
                FROM drive_request_owner_payouts WHERE request_id=:request"""),
                    {"request": created["requestId"]},
                )
                .mappings()
                .one()
            )
            assert payout["expected_files"] == 2 and payout["confirmed_files"] == 1
            assert payout["refund_amount_cents"] == row["quoted_amount_cents"] // 2
    assert await removals.materialize(v1_only=True) == 0
    due = await removals.due(v1_only=True)
    assert len(due) == 1
    removal = await removals.claim(
        user_id="owner", removal_id=str(due[0]["removal_id"]), v1_only=True
    )
    assert removal["plan"]["expiration_time"] == expiration
    assert removal["plan"]["permission_id"] == "permission-test-period"
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", created["requestId"])
        assert row["access_stop_requested_at"] is not None


async def test_default_access_period_retry_preserves_legacy_request_terms(agent_flow, sharing):
    from uuid import uuid4

    from tests.services.test_drive_agent_package_flow_postgres import new_request

    client_id = str(uuid4())
    legacy = await new_request(sharing, client_id=client_id)
    repeated = await new_request(sharing, client_id=client_id, access_days=30)
    assert repeated["requestId"] == legacy["requestId"]
    assert repeated["requestedAccessDays"] is None
    with pytest.raises(DriveReadError, match="request_changed"):
        await new_request(sharing, client_id=client_id, access_days=7)
    timed_id = str(uuid4())
    await new_request(sharing, client_id=timed_id, access_days=30)
    with pytest.raises(DriveReadError, match="request_changed"):
        await new_request(sharing, client_id=timed_id, access_days=7)
