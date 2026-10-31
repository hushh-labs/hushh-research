"""Real SQL/HTTP copy lifecycle. Provider and object transport alone are synthetic."""

# ruff: noqa: F811 -- shared isolated PostgreSQL fixtures

from uuid import uuid4

import httpx
import pytest
from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    Revoke,
)
from hushh_mcp.services.document_delivery.store import delivery_summary
from tests.helpers.document_delivery_client import (
    assert_local_watermarked_read,
    new_request,
    pay,
    prove_key,
    signed_payment_callback,
    stage,
)
from tests.helpers.document_delivery_drive import (
    assert_drive_removal_plan,
    assert_unreleased_copy_refund,
    grant_managed_copy_channel,
    remove_recorded_drive_permission,
)
from tests.services.test_document_delivery import (  # noqa: F401
    connector_postgres_url,
    delivery_app,
    delivery_system,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)


@pytest.mark.asyncio
async def test_signed_payment_exact_acceptance_and_local_decryption(
    delivery_system, delivery_app, monkeypatch
):
    system = delivery_system
    created = await new_request(system)
    request_id = created["requestId"]
    staged = await stage(system, request_id)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=delivery_app), base_url="https://one.invalid"
    ) as client:
        state = await client.get(
            f"/api/connectors/google_drive/sharing/requests/{request_id}/payment",
            headers={"Authorization": "Bearer recipient"},
        )
    assert state.status_code == 200
    assert state.json()["status"] == "awaiting_payment"
    assert state.json()["paymentsReady"] is True
    with system.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT COUNT(*) FROM drive_request_payment_orders")).scalar()
            == 0
        )
    with pytest.raises(DeliveryError, match="checkout_terms_acceptance_required"):
        await system.payment.checkout(requester_user_id="recipient", request_id=request_id)
    await prove_key(system, request_id)
    accepted = {
        "acceptedTermsRevision": 1,
        "acceptedTermsDigest": staged.package["termsDigest"],
        "acceptedPackageDigest": staged.package["packageDigest"],
    }
    checkout = await system.payment.checkout(
        requester_user_id="recipient", request_id=request_id, accepted_contract=accepted
    )
    assert checkout["checkoutUrl"].startswith("https://checkout.stripe.com/")
    await signed_payment_callback(system, request_id)
    monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "false")
    released = await system.store.release(request_id=request_id, actor="recipient")
    assert len(released["wraps"]) == 3
    await assert_local_watermarked_read(system, request_id, released, delivery_app)
    with system.db.engine.connect() as connection:
        assert delivery_summary(connection, request_id) == {
            "expected": 1,
            "confirmed": 1,
            "unsettled": 0,
        }
        assert (
            connection.execute(text("SELECT COUNT(*) FROM drive_request_payment_orders")).scalar()
            == 1
        )
        assert (
            connection.execute(text("SELECT status FROM drive_request_payment_orders")).scalar()
            == "paid"
        )
    from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService

    await DriveRequestOwnerPayoutService(db=system.db).reconcile_due(max_orders=1)
    with system.db.engine.connect() as connection:
        payout = (
            connection.execute(text("SELECT * FROM drive_request_owner_payouts")).mappings().one()
        )
        assert payout["finalized_at"] is not None
        assert payout["retained_amount_cents"] == staged.package["terms"]["amountCents"]


@pytest.mark.asyncio
async def test_undelivered_copy_refunds_through_existing_financial_authority(
    delivery_system, monkeypatch
):
    system = delivery_system
    request_id = (await new_request(system))["requestId"]
    staged = await stage(system, request_id)
    await pay(system, request_id, staged.package)
    monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "false")
    await system.store.revoke(
        request_id=request_id,
        actor="owner",
        body=Revoke.model_validate(
            {"expectedRevision": 1, "idempotencyKey": str(uuid4()), "scope": "one"}
        ),
    )
    outcome = await system.payment.reconcile_refunds(max_orders=1)
    assert outcome["succeeded"] == 1
    with system.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT status FROM drive_request_payment_orders")).scalar()
            == "refunded"
        )
        assert (
            connection.execute(
                text("SELECT amount_cents FROM drive_request_payment_refunds")
            ).scalar()
            == 2500
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("amount", [50, 101])
async def test_cents_contract_reaches_real_checkout_without_rounding(delivery_system, amount):
    system = delivery_system
    request_id = (await new_request(system))["requestId"]
    staged = await stage(system, request_id, amount=amount)
    await prove_key(system, request_id)
    await system.payment.checkout(
        requester_user_id="recipient",
        request_id=request_id,
        accepted_contract={
            "acceptedTermsRevision": 1,
            "acceptedTermsDigest": staged.package["termsDigest"],
            "acceptedPackageDigest": staged.package["packageDigest"],
        },
    )
    assert (
        system.provider.checkout.Session.create.call_args.kwargs["line_items"][0]["price_data"][
            "unit_amount"
        ]
        == amount
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "hosted_release", [True, False], ids=["released", "revoked_before_release"]
)
async def test_both_uses_managed_drive_receipt_and_keeps_one_file_denominator(
    delivery_system, monkeypatch, hosted_release
):
    system = delivery_system
    request_id = (await new_request(system, mode="both"))["requestId"]
    staged = await stage(system, request_id)
    # B can pay after the legacy grant dispatch window while this contract's
    # explicitly approved finite deadline remains current.
    with system.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET created_at=clock_timestamp()-INTERVAL '3 hours' WHERE request_id=:request"
            ),
            {"request": request_id},
        )
    await pay(system, request_id, staged.package)
    held = await system.store.release(request_id=request_id, actor="recipient")
    assert len(held["wraps"]) == 1  # manifest after paid; no per-file key yet
    adapter, oauth, operation_id, inspect = await grant_managed_copy_channel(
        system, request_id, staged, monkeypatch
    )
    if not hosted_release:
        await assert_unreleased_copy_refund(system, request_id, staged)
        return
    removal, child = await assert_drive_removal_plan(system, request_id, staged, operation_id)
    await remove_recorded_drive_permission(
        system, request_id, staged, adapter, oauth, inspect, removal, child
    )
