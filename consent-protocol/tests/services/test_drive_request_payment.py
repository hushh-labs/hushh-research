"""Payment settlement survives request erasure without account information."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
import stripe
from sqlalchemy import text

import hushh_mcp.services.pkm_payout_service as payout_account_module
from db.db_client import DatabaseClient
from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_allowed import (
    end_owner_allows_for_disconnected_pair,
    owner_allowed_record,
)
from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService
from hushh_mcp.services.drive_request_payment_checkout_worker import (
    DriveRequestPaymentCheckoutWorker,
)
from hushh_mcp.services.drive_request_payment_refunds import (
    _REFUND_CANDIDATES_SQL,
    _claim_refunds,
    _finish_refund,
    _provider_refund,
)
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService, _config
from hushh_mcp.services.drive_request_payment_store import (
    DriveRequestPaymentStore,
    _order_amount_cents,
    _record_new_owner_payout,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.stripe_connect_bank_payouts import StripeConnectBankPayouts
from tests.services.test_drive_request_bulk_postgres import _search, request_bulk  # noqa: F401
from tests.services.test_drive_sharing_store import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    live_drive,
    request,
    sharing,
)

DATED_PURPOSE = {"purpose": "Statements", "periodStart": "2026-10-01", "periodEnd": "2026-10-09"}


class _CommerceStripe:
    """Synthetic provider boundary; all settlement decisions stay in real services."""

    Webhook = stripe.Webhook

    def __init__(self, request_id):
        self.charge = {
            "id": "ch_test_lifecycle",
            "payment_intent": "pi_test_bound",
            "amount": 2500,
            "amount_refunded": 0,
            "currency": "usd",
            "paid": True,
            "captured": True,
            "disputed": False,
            "livemode": False,
            "balance_transaction": "txn_test_lifecycle",
            "transfer_group": f"drive-request-{request_id}",
        }
        self.checkout = SimpleNamespace(
            Session=SimpleNamespace(
                create=Mock(side_effect=lambda **kw: _checkout_sdk_response(kw, "cs_test_bound"))
            )
        )
        self.Account = SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "acct_test_owner",
                    "country": "US",
                    "details_submitted": True,
                    "payouts_enabled": True,
                    "capabilities": {"transfers": "active"},
                    "requirements": {},
                    "external_accounts": {
                        "data": [
                            {
                                "object": "bank_account",
                                "country": "US",
                                "currency": "usd",
                                "default_for_currency": True,
                                "status": "verified",
                            }
                        ],
                        "has_more": False,
                    },
                }
            )
        )
        self.PaymentIntent = SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "pi_test_bound",
                    "status": "succeeded",
                    "latest_charge": self.charge["id"],
                    "livemode": False,
                }
            )
        )
        self.Charge = SimpleNamespace(retrieve=Mock(side_effect=lambda *a, **kw: dict(self.charge)))
        self.BalanceTransaction = SimpleNamespace(
            retrieve=Mock(return_value={"id": "txn_test_lifecycle", "currency": "usd", "fee": 103})
        )
        self.Refund = SimpleNamespace(
            list=Mock(return_value={"data": [], "has_more": False}),
            create=Mock(side_effect=self._refund),
        )
        self.Transfer = SimpleNamespace(
            list=Mock(return_value={"data": [], "has_more": False}),
            create=Mock(
                side_effect=lambda **kw: {
                    **kw,
                    "id": "tr_test_lifecycle",
                    "livemode": False,
                    "reversed": False,
                    "amount_reversed": 0,
                }
            ),
        )
        # A bank deposit can aggregate many earnings, so its amount deliberately
        # differs from this document's transfer and has no request attribution.
        self.Payout = SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "po_test_lifecycle",
                    "object": "payout",
                    "livemode": False,
                    "status": "paid",
                    "amount": 5000,
                    "currency": "usd",
                    "arrival_date": 1800000000,
                }
            )
        )

    def _refund(self, **kwargs):
        self.charge["amount_refunded"] = kwargs["amount"]
        return {
            "id": "re_test_lifecycle",
            "status": "succeeded",
            "currency": "usd",
            "payment_intent": kwargs["payment_intent"],
            "amount": kwargs["amount"],
        }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "trusted,confirmed,retained,refund,commission,earning,refund_first",
    [
        (False, 3, 2500, 0, 75, 2322, False),
        (True, 2, 1667, 833, 50, 1514, False),
        (False, 0, 0, 2500, 0, 0, False),
        (False, 0, 0, 2500, 0, 0, True),
    ],
    ids=["owner_full_delivery", "trusted_partial_delivery", "owner_zero_delivery", "refund_first"],
)
async def test_document_payment_delivery_transfer_and_bank_payout_lifecycle(
    sharing, monkeypatch, trusted, confirmed, retained, refund, commission, earning, refund_first
):
    """Exercise persisted commerce boundaries without Stripe or Google network calls."""
    for key, value in {
        "ENVIRONMENT": "test",
        "STRIPE_MODE": "test",
        "DRIVE_REQUEST_PAYMENTS_ENABLED": "true",
        "DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED": "true",
        "STRIPE_SECRET_KEY": "sk_test_local_only_synthetic",
        "STRIPE_WEBHOOK_SECRET": "whsec_payment_test_secret",
        "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect_lifecycle_test_secret",
        "APP_FRONTEND_ORIGIN": "https://test.example",
        "HUSSH_SITE_ORIGIN": "https://test.example",
    }.items():
        monkeypatch.setenv(key, value)
    clear_runtime_settings_caches()
    live_drive(sharing, monkeypatch)
    await sharing.update_owner_pricing(
        user_id="owner", enabled=True, amount_cents=2500, expected_version=0
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
          (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
          VALUES ('test','owner','acct_test_owner',TRUE,TRUE,TRUE)""")
        )
        if trusted:
            circle = str(uuid4())
            connection.execute(
                text("INSERT INTO one_location_circles VALUES (:id,'owner','trusted','active')"),
                {"id": circle},
            )
            connection.execute(
                text(
                    "INSERT INTO one_location_circle_memberships VALUES (:id,'recipient','active')"
                ),
                {"id": circle},
            )
    request_id = (await request(sharing))["requestId"]
    provider = _CommerceStripe(request_id)
    account_service = payout_account_module.PkmPayoutService(stripe_api=provider)
    account_service._db = DatabaseClient(engine=sharing.db.engine)
    assert (await account_service.refresh_account(user_id="owner"))["readiness"]["ready"]
    # Checkout constructs this collaborator internally. Replace its factory,
    # retaining the real account lookup, provider validation and PostgreSQL update.
    monkeypatch.setattr(payout_account_module, "PkmPayoutService", lambda: account_service)
    bulk = DriveBulkShareStore(db=sharing.db)
    payment = DriveRequestPaymentService(db=sharing.db, stripe_api=provider)
    payouts = DriveRequestOwnerPayoutService(db=sharing.db, stripe_api=provider)
    bank = StripeConnectBankPayouts(db=sharing.db, stripe_api=provider)
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        # Google identity verification is also an external provider boundary.
        verify_recipient=AsyncMock(),
    )
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(bulk, request_id=request_id, count=3),
        client_request_id=str(uuid4()),
        origin_request_id=request_id,
        recipients=[
            {
                "userId": "recipient",
                "email": "recipient@example.invalid",
                "subject": "1234567",
                "kind": "google_provider",
            }
        ],
        excluded=[],
        selected_positions=[1, 2, 3],
    )
    approval = {
        "user_id": "owner",
        "share_id": review["shareId"],
        "revision": review["revision"],
        "review_digest": review["reviewDigest"],
        "approval_source": "trusted_auto" if trusted else "owner",
    }
    if trusted:
        await payment.ensure_payment_for_frozen_batch("owner", request_id, review["shareId"])
        with pytest.raises(DriveSharingError, match="payment_required"):
            await bulk.approve(**approval)
    else:
        with pytest.raises(DriveSharingError, match="payment_not_ready"):
            await payment.checkout(requester_user_id="recipient", request_id=request_id)
        await bulk.approve(**approval)
        with pytest.raises(DriveSharingError, match="payment_required"):
            await bulk.claim(
                user_id="owner",
                share_id=review["shareId"],
                position=1,
                recipient_user_id="recipient",
            )
    provider.checkout.Session.create.assert_not_called()
    await payment.checkout(requester_user_id="recipient", request_id=request_id)
    checkout_params = provider.checkout.Session.create.call_args.kwargs
    assert checkout_params["line_items"][0]["price_data"]["unit_amount"] == 2500
    assert checkout_params["payment_intent_data"]["transfer_group"] == f"drive-request-{request_id}"
    payload, signature = _signed_event(
        request_id, amount=2500, attempt_id=checkout_params["metadata"]["checkout_attempt_id"]
    )
    await payment.process_webhook(payload=payload, signature=signature)
    await payment.process_webhook(payload=payload, signature=signature)
    if trusted:
        await bulk.approve(**approval)
    assert (await payment.get_payment(requester_user_id="recipient", request_id=request_id))[
        "status"
    ] == "paid"
    assert (await payouts.reconcile_due(max_orders=1))["fees_resolved"] == 0
    assert (await payouts.transfer_due(max_orders=1))["claimed"] == 0
    assert (await bank.owner_summary(user_id="owner"))["payouts"] == []

    for position in range(1, 4):
        job = await bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=position,
            recipient_user_id="recipient",
        )
        assert job is not None
        await bulk.mark_dispatching(job)
        assert await bulk.settle(
            job,
            state="succeeded" if position <= confirmed else "failed",
            safe_error_code=None if position <= confirmed else "permission_rejected",
            receipt={"managed": True} if position <= confirmed else None,
        )
    delivered = await delivery.delivery(user_id="recipient", request_id=request_id)
    assert delivered["sharedCount"] == confirmed
    assert delivered["status"] == ("completed" if confirmed == 3 else "partial")
    if refund_first:
        # Independent workers may confirm the zero-delivery refund before
        # the payout worker has frozen its delivery denominator.
        assert (await payment.reconcile_refunds(max_orders=1))["succeeded"] == 1
    await payouts.reconcile_due(max_orders=1)
    if refund:
        assert (await payouts.transfer_due(max_orders=1))["claimed"] == 0
        if not refund_first:
            assert (await payment.reconcile_refunds(max_orders=1))["succeeded"] == 1
        assert provider.Refund.create.call_args.kwargs["amount"] == refund
        await payouts.reconcile_due(max_orders=1)
    else:
        provider.Refund.create.assert_not_called()
    outcome = await payouts.transfer_due(max_orders=1)
    assert outcome["transferred"] == bool(earning)
    with sharing.db.engine.connect() as connection:
        ledger = dict(
            connection.execute(
                text("SELECT * FROM drive_request_owner_payouts WHERE request_id=:id"),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM drive_request_payment_webhook_events WHERE request_id=:id"
                ),
                {"id": request_id},
            ).scalar_one()
            == 1
        )
    assert (
        ledger["gross_amount_cents"],
        ledger["expected_files"],
        ledger["confirmed_files"],
        ledger["retained_amount_cents"],
        ledger["refund_amount_cents"],
        ledger["platform_fee_cents"],
    ) == (2500, 3, confirmed, retained, refund, commission)
    assert ledger["status"] == ("transferred" if earning else "void")
    assert ledger["stripe_mode"] == "test"
    if earning:
        assert ledger["owner_earning_cents"] == earning
        assert (
            ledger["actual_processing_fee_cents"] == ledger["allocated_processing_fee_cents"] == 103
        )
        assert provider.Transfer.create.call_args.kwargs == {
            "amount": earning,
            "currency": "usd",
            "destination": "acct_test_owner",
            "source_transaction": "ch_test_lifecycle",
            "transfer_group": f"drive-request-{request_id}",
            "metadata": {"payment_kind": "drive_request_owner_payout", "request_id": request_id},
            "api_key": "sk_test_local_only_synthetic",
            "idempotency_key": f"drive-owner-transfer:{request_id}",
        }
    else:
        provider.PaymentIntent.retrieve.assert_not_called()
        provider.Charge.retrieve.assert_not_called()
        provider.BalanceTransaction.retrieve.assert_not_called()
        provider.Transfer.list.assert_not_called()
        with sharing.db.engine.connect() as connection:
            assert tuple(
                connection.execute(
                    text("""SELECT o.status,b.status,
              o.reconciliation_required,b.reconciliation_required
              FROM drive_request_payment_orders o
              JOIN drive_request_payment_obligations b USING (request_id)
              WHERE o.request_id=:id"""),
                    {"id": request_id},
                ).one()
            ) == ("refunded", "refunded", True, True)
    history = (await payouts.owner_history(user_id="owner"))["transactions"]
    assert len(history) == 1 and history[0]["requestId"] == request_id
    assert history[0]["platformFeeCents"] == commission
    assert history[0]["refundAmountCents"] == refund
    assert history[0]["status"] == ledger["status"]
    if earning:
        assert history[0]["netAmountCents"] == earning
    assert (await payouts.owner_history(user_id="recipient"))["transactions"] == []
    assert (await bank.owner_summary(user_id="owner"))["payouts"] == []
    # Transfer completion never invents a bank deposit. Only a signed Connect
    # event plus the current provider Payout object may report the later deposit.
    if earning:
        bank_body = json.dumps(
            {
                "id": "evt_test_bank_lifecycle",
                "type": "payout.paid",
                "livemode": False,
                "account": "acct_test_owner",
                "data": {"object": {"id": "po_test_lifecycle", "object": "payout"}},
            }
        ).encode()
        timestamp = int(time.time())
        bank_signature = hmac.new(
            b"whsec_connect_lifecycle_test_secret",
            f"{timestamp}.".encode() + bank_body,
            hashlib.sha256,
        ).hexdigest()
        signed = f"t={timestamp},v1={bank_signature}"
        assert await bank.process_webhook(payload=bank_body, signature=signed) == "updated"
        assert await bank.process_webhook(payload=bank_body, signature=signed) == "duplicate"
        snapshot = (await bank.owner_summary(user_id="owner"))["payouts"]
        assert len(snapshot) == 1
        assert (snapshot[0]["status"], snapshot[0]["amountCents"]) == ("paid", 5000)
        assert "requestId" not in snapshot[0]
        assert (await bank.owner_summary(user_id="recipient"))["payouts"] == []
        provider.Payout.retrieve.assert_called_once_with(
            "po_test_lifecycle",
            stripe_account="acct_test_owner",
            api_key="sk_test_local_only_synthetic",
        )
    await payouts.reconcile_due(max_orders=1)
    assert (await payouts.transfer_due(max_orders=1))["claimed"] == 0
    assert (await payment.reconcile_refunds(max_orders=1))["claimed"] == 0
    assert provider.Transfer.create.call_count == bool(earning)
    assert provider.Refund.create.call_count == bool(refund)
    provider.checkout.Session.create.assert_called_once()


@pytest.mark.asyncio
async def test_owner_payout_lease_claim_and_stale_completion_are_fenced_in_postgres(sharing):
    from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService

    created = await request(sharing)
    identity = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET status='completed' WHERE request_id=:id"),
            {"id": identity},
        )
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
                (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
                VALUES ('test','owner','acct_test_owner',TRUE,TRUE,TRUE)""")
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
                (stripe_mode,request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
                VALUES ('test',:id,'owner','recipient','paid','pi_test_lease',clock_timestamp())"""),
            {"id": identity},
        )
        connection.execute(
            text("""INSERT INTO drive_request_owner_payouts
                (stripe_mode,request_id,gross_amount_cents,status,expected_files,confirmed_files,
                 retained_amount_cents,refund_amount_cents,platform_fee_cents,
                 actual_processing_fee_cents,allocated_processing_fee_cents,owner_earning_cents,
                 finalized_at,stripe_payment_intent_id,stripe_charge_id,stripe_balance_transaction_id)
                VALUES ('test',:id,1000,'due',1,1,1000,0,30,59,59,911,
                  clock_timestamp(),'pi_test_lease','ch_test_lease','txn_test_lease')"""),
            {"id": identity},
        )
    service = DriveRequestOwnerPayoutService(db=sharing.db)
    claims = await asyncio.gather(
        service._transaction(lambda connection: service._claim_transfer(connection, identity)),
        service._transaction(lambda connection: service._claim_transfer(connection, identity)),
    )
    assert sum(claim is not None for claim in claims) == 1
    first = next(claim for claim in claims if claim is not None)
    assert first["first_transfer_attempt"] is True
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_owner_payouts
              SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'
              WHERE request_id=:id"""),
            {"id": identity},
        )
    retry = await service._transaction(
        lambda connection: service._claim_transfer(connection, identity)
    )
    assert retry is not None and retry["first_transfer_attempt"] is False
    assert retry["transfer_attempt_id"] != first["transfer_attempt_id"]
    assert retry["first_dispatch_at"] == first["first_dispatch_at"]
    await service._transaction(
        lambda connection: service._finish_transfer(connection, first, None, "account_unavailable")
    )
    with sharing.db.engine.connect() as connection:
        current = (
            connection.execute(
                text("""SELECT status,first_dispatch_at,transfer_attempt_id
               FROM drive_request_owner_payouts WHERE request_id=:id"""),
                {"id": identity},
            )
            .mappings()
            .one()
        )
    assert current["status"] == "dispatching"
    assert current["transfer_attempt_id"] == retry["transfer_attempt_id"]
    assert current["first_dispatch_at"] == first["first_dispatch_at"]
    await service._transaction(
        lambda connection: service._finish_transfer(connection, retry, None, "account_unavailable")
    )
    with sharing.db.engine.connect() as connection:
        current = (
            connection.execute(
                text("""SELECT status,first_dispatch_at,transfer_attempt_id
               FROM drive_request_owner_payouts WHERE request_id=:id"""),
                {"id": identity},
            )
            .mappings()
            .one()
        )
    assert current["status"] == "awaiting_account"
    assert current["first_dispatch_at"] == first["first_dispatch_at"]
    assert current["transfer_attempt_id"] == retry["transfer_attempt_id"]


@pytest.fixture(autouse=True)
def fresh_payment_runtime_settings(monkeypatch):
    monkeypatch.setenv("STRIPE_MODE", "test")
    clear_runtime_settings_caches()
    yield
    clear_runtime_settings_caches()


def _owner_allowed(private: dict, amount_cents: int | None) -> dict:
    """The sealed fields an owner's Allow adds; payments read only this marker."""
    return {
        **private,
        "trusted_auto": True,
        "owner_allowed": owner_allowed_record(
            amount_cents=amount_cents, allowed_at=datetime.now(UTC).isoformat()
        ),
    }


def _reseal_request(sharing, request_id: str, change) -> None:
    """Re-seal a stored request the way Allow does, leaving its revision unchanged."""
    with sharing.db.engine.begin() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        envelope = sharing.sharing_cipher.seal(
            change(sharing._open_request(row)),
            user_id="owner",
            resource_id=request_id,
            purpose="request",
        )
        connection.execute(
            text("""UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb),
              preparation_error_code='trusted_auto_queued',preparation_next_at=clock_timestamp(),
              updated_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id, "envelope": json.dumps(envelope)},
        )


def _owner_allow(sharing, request_id: str, *, amount_cents: int | None) -> None:
    _reseal_request(sharing, request_id, lambda private: _owner_allowed(private, amount_cents))
    # Allow also stamps the plaintext hint, which only a disconnect clears.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET owner_allowed_at=clock_timestamp(),
              quoted_amount_cents=CASE WHEN quoted_amount_cents IS NOT NULL
                THEN :amount ELSE NULL END
              WHERE request_id=:request"""),
            {"request": request_id, "amount": amount_cents},
        )


def _signed_event(
    request_id: str,
    *,
    amount: int = 1000,
    session_id: str = "cs_test_bound",
    attempt_id: str | None = None,
    event_type: str = "checkout.session.completed",
    payment_status: str = "paid",
    payment_intent: str | None = "pi_test_bound",
):
    payer_ref = hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()
    metadata = {"payment_kind": "drive_request", "request_id": request_id, "payer_ref": payer_ref}
    if attempt_id is not None:
        metadata["checkout_attempt_id"] = attempt_id
    body = json.dumps(
        {
            "id": "evt_test_" + uuid4().hex,
            "object": "event",
            "type": event_type,
            "data": {
                "object": {
                    "id": session_id,
                    "object": "checkout.session",
                    "client_reference_id": request_id,
                    "metadata": metadata,
                    "mode": "payment",
                    "payment_status": payment_status,
                    "amount_total": amount,
                    "currency": "usd",
                    "livemode": False,
                    "payment_intent": payment_intent,
                }
            },
        }
    ).encode()
    timestamp = int(time.time())
    signature = hmac.new(
        b"whsec_payment_test_secret", f"{timestamp}.".encode() + body, hashlib.sha256
    ).hexdigest()
    return body, f"t={timestamp},v1={signature}"


def test_live_stripe_key_requires_explicit_live_mode(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_should_not_be_used")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        _config()


@pytest.mark.asyncio
@pytest.mark.parametrize("stored_mode", ["test", "legacy"])
async def test_live_cutover_never_reuses_old_checkout_or_refunds_old_money(
    sharing, monkeypatch, stored_mode
):
    request_id = (await request(sharing))["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET payment_required=TRUE,status='approved' WHERE request_id=:id"
            ),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,stripe_mode,status)
              VALUES (:id,'owner','recipient',:mode,'awaiting_payment')"""),
            {"id": request_id, "mode": stored_mode},
        )
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_only_synthetic_test_fixture")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    create = Mock()
    service = DriveRequestPaymentService(
        db=sharing.db,
        stripe_api=SimpleNamespace(
            checkout=SimpleNamespace(Session=SimpleNamespace(create=create))
        ),
    )
    state = await service.payment_state(requester_user_id="recipient", request_id=request_id)
    assert (state["status"], state["paymentLinkExpired"], state["stripeMode"]) == (
        "expired",
        True,
        stored_mode,
    )
    assert await service.due_checkout_orders() == []
    with pytest.raises(DriveSharingError, match="payment_checkout_expired"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    create.assert_not_called()
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders SET status='paid',
              stripe_payment_intent_id='pi_previous_mode',paid_at=clock_timestamp()
              WHERE request_id=:id"""),
            {"id": request_id},
        )
        connection.execute(
            text("UPDATE drive_share_requests SET status='no_match' WHERE request_id=:id"),
            {"id": request_id},
        )
        assert _claim_refunds(service, connection, limit=10) == []
    # Positive control: returning to the known sandbox mode can reconcile its
    # own charge. An unclassified legacy charge remains held in every mode.
    monkeypatch.setenv("STRIPE_MODE", "test")
    with sharing.db.engine.begin() as connection:
        claims = _claim_refunds(service, connection, limit=10)
    assert len(claims) == (1 if stored_mode == "test" else 0)


def test_paid_grant_guard_blocks_reconciliation_hold():
    connection = SimpleNamespace(execute=Mock())
    connection.execute.return_value.mappings.return_value.first.return_value = {
        "status": "paid",
        "stripe_mode": "test",
        "paid_at": object(),
        "reconciliation_required": True,
    }
    request_row = {"payment_required": True, "request_id": str(uuid4())}
    with pytest.raises(DriveSharingError, match="payment_required"):
        DriveRequestPaymentStore.require_paid_if_required(connection, request_row)
    connection.execute.return_value.mappings.return_value.first.return_value[
        "reconciliation_required"
    ] = False
    DriveRequestPaymentStore.require_paid_if_required(connection, request_row)


@pytest.mark.parametrize(
    "owner_price,quoted_price,amount",
    [
        (None, None, 1000),
        (3000, None, 3000),
        (None, 2500, 2500),
        (3000, 2500, 2500),
    ],
)
def test_non_trusted_approval_creates_order_without_premature_pay_notification(
    monkeypatch, owner_price, quoted_price, amount
):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    monkeypatch.delenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", raising=False)
    if quoted_price is not None:
        monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    record_payout = Mock()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_owner_payout_service.DriveRequestOwnerPayoutService.record_order",
        record_payout,
    )
    insert_result = Mock()
    insert_result.rowcount = 1
    selected_result = Mock()
    selected_result.mappings.return_value.first.return_value = {"status": "awaiting_payment"}
    ready_result = Mock()
    ready_result.mappings.return_value.first.return_value = {"account_ready": True}
    connection = SimpleNamespace(
        execute=Mock(
            side_effect=[
                insert_result,
                *([ready_result] if quoted_price is not None else []),
                selected_result,
            ]
        )
    )
    request_id = str(uuid4())
    private = {"purpose": DATED_PURPOSE}
    if owner_price is not None:
        private = _owner_allowed(private, owner_price)
    request_row = {
        "request_id": request_id,
        "user_id": "owner",
        "recipient_user_id": "requester",
        "payment_required": True,
        "quoted_amount_cents": quoted_price,
        "revision": 2,
        "request_envelope": DriveSharingCipher().seal(
            private, user_id="owner", resource_id=request_id, purpose="request"
        ),
    }

    assert DriveRequestPaymentStore.ensure_order_for_approved_request(connection, request_row)
    assert connection.execute.call_count == (3 if quoted_price is not None else 2)
    insert = connection.execute.call_args_list[0]
    assert "ON CONFLICT (request_id) DO NOTHING" in str(insert.args[0])
    # A manual approval keeps the default price; an allowed request the owner's.
    assert insert.args[1]["amount"] == amount
    assert record_payout.call_count == (1 if quoted_price is not None else 0)


def test_new_owner_settlement_never_falls_back_to_platform_price():
    private = {"owner_settlement_required": True}
    for missing_price in (None, 0, 1050):
        with pytest.raises(DriveSharingError, match="owner_price_required"):
            _order_amount_cents({"quoted_amount_cents": missing_price}, private)
    assert _order_amount_cents({"quoted_amount_cents": 200}, private) == 200
    assert _order_amount_cents({}, {}) == 1000  # Legacy payment terms stay unchanged.


@pytest.mark.parametrize(
    "enabled,ready,error",
    [
        (False, True, "payout_unavailable"),
        (True, False, "owner_payout_required"),
        (True, True, None),
    ],
)
def test_new_quoted_order_requires_payout_admission_before_enrollment(
    monkeypatch, enabled, ready, error
):
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", str(enabled).lower())
    record = Mock()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_owner_payout_service.DriveRequestOwnerPayoutService.record_order",
        record,
    )
    result = Mock()
    result.mappings.return_value.first.return_value = {"account_ready": ready}
    connection = SimpleNamespace(execute=Mock(return_value=result))
    arguments = dict(
        request_id=str(uuid4()), owner_user_id="owner", amount_cents=200, quoted_request=True
    )
    if error:
        with pytest.raises(DriveSharingError, match=error):
            _record_new_owner_payout(connection, **arguments)
        record.assert_not_called()
    else:
        _record_new_owner_payout(connection, **arguments)
        record.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("approved,expected", [(False, "preparing"), (True, "awaiting_payment")])
async def test_payment_status_read_never_creates_unapproved_order_or_event(
    monkeypatch, approved, expected
):
    request = {
        "request_id": str(uuid4()),
        "user_id": "owner",
        "recipient_user_id": "recipient",
        "revision": 1,
        "payment_required": True,
        "status": "pending",
        "access_stop_requested_at": None,
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    order = {
        "stripe_mode": "test",
        "status": "awaiting_payment",
        "reconciliation_required": False,
        "amount_cents": 2000,
        "currency": "usd",
    }
    store = DriveRequestPaymentStore(db=object())
    store._row = Mock(side_effect=[request, order])
    store.owner_approved_progressive_batch = Mock(return_value=approved)
    store._event = Mock()
    monkeypatch.setattr(
        DriveSharingStore,
        "_open_request",
        lambda self, row: {"purpose": {"periodStart": "2026-10-01", "periodEnd": "2026-10-09"}},
    )
    connection = SimpleNamespace(execute=Mock())

    async def transaction(operation):
        return operation(connection)

    store._transaction = transaction
    state = await store.payment_state(
        requester_user_id="recipient", request_id=request["request_id"]
    )
    assert state["status"] == expected
    # The requester is quoted the stored order amount, never a fixed price.
    assert (state["amountCents"], state["currency"]) == (2000, "usd")
    connection.execute.assert_not_called()
    store._event.assert_not_called()


def test_new_request_payment_boundary_is_after_consent_for_non_trusted_requests():
    create = inspect.getsource(DriveSharingStore.create_request)
    prepare = inspect.getsource(DriveSharingStore.prepare_review)
    approve = inspect.getsource(DriveSharingStore.approve_review)
    assert "not owner_initiated" in create
    assert "enforce_payment=False" in prepare
    assert "ensure_order_for_approved_request" in approve
    assert "enforce_payment=False" in approve


def test_erasure_locks_connector_share_request_then_order():
    retention = inspect.getsource(erase_drive_account_in_transaction)
    connector = retention.index("FROM user_external_connector_connections")
    share = retention.index("ORDER BY share_id FOR UPDATE")
    request = retention.index(
        "FROM drive_share_requests\n                  WHERE request_id=:request FOR UPDATE"
    )
    order = retention.index(
        "FROM drive_request_payment_orders\n                  WHERE request_id=:request FOR UPDATE"
    )
    assert connector < share < request < order


def test_legacy_grant_and_bulk_claim_follow_erasure_lock_order():
    grant = inspect.getsource(DrivePermissionStore._grant_authority)
    assert grant.index("self._participant_gate") < grant.index("self._management_context")
    assert grant.index("self._management_context") < grant.index("self._related_request")
    assert grant.index("self._related_request") < grant.index("require_paid_if_required")

    claim = inspect.getsource(DriveBulkShareStore.claim)
    assert claim.index("self._owned(") < claim.index(
        "FROM drive_share_requests WHERE request_id=:request FOR UPDATE"
    )
    assert (
        claim.index("FROM drive_share_requests WHERE request_id=:request FOR UPDATE")
        < claim.index("FROM drive_request_payment_orders ")
        < claim.index("FROM drive_bulk_share_effects WHERE share_id=:share")
    )
    assert claim.index("FROM drive_bulk_share_effects WHERE share_id=:share") < claim.index(
        "self._require_paid_for_origin"
    )

    dispatch = inspect.getsource(DriveBulkShareStore.mark_dispatching)
    assert dispatch.index("self._lock(") < dispatch.index("self._owned(")
    assert (
        dispatch.index("self._owned(")
        < dispatch.index("FROM drive_share_requests WHERE request_id=:request FOR UPDATE")
        < dispatch.index("self._effect_current")
    )


def test_payment_identity_writes_lock_graph_before_request_and_order():
    ensure = inspect.getsource(DriveRequestPaymentStore._ensure_ready)
    assert (
        ensure.index("lock_connection_graph_users(")
        < ensure.index("AND user_id=:user FOR UPDATE")
        < ensure.index("INSERT INTO drive_request_payment_orders")
    )

    defer = inspect.getsource(DriveRequestPaymentStore.defer_unready_checkout_order)
    assert (
        defer.index("lock_connection_graph_users(")
        < defer.index("recipient_user_id=:requester FOR UPDATE")
        < defer.index("UPDATE drive_request_payment_orders")
    )

    finish = inspect.getsource(_finish_refund)
    assert (
        finish.index("lock_connection_graph_users(")
        < finish.index("WHERE request_id=:request FOR UPDATE")
        < finish.index("document_share_payment_refunded")
    )

    webhook = inspect.getsource(DriveRequestPaymentService.process_webhook)
    assert (
        webhook.index("lock_connection_graph_users(")
        < webhook.index("SELECT * FROM drive_share_requests WHERE request_id=:request")
        < webhook.index("document_share_payment_confirmed")
    )


def test_bulk_identity_writes_gate_participant_graph_before_row_locks(monkeypatch):
    gate = Mock()
    monkeypatch.setattr(
        "hushh_mcp.services.connection_graph_service.lock_connection_graph_users", gate
    )
    connection = SimpleNamespace(execute=Mock())
    connection.execute.return_value.mappings.return_value.all.return_value = [
        {"user_id": "owner", "recipient_user_id": "recipient"}
    ]
    DriveBulkShareStore._gate_graph_for_share(connection, user_id="owner", share_id=str(uuid4()))
    gate.assert_called_once_with(connection, user_ids=["owner", "recipient"])

    create = inspect.getsource(DriveBulkShareStore.create_review)
    assert (
        create.index("lock_connection_graph_users(")
        < create.index("self._lock(connection")
        < create.index("INSERT INTO drive_bulk_shares")
    )
    for method in (
        DriveBulkShareStore.approve,
        DriveBulkShareStore.retry,
        DriveBulkShareStore.claim,
    ):
        source = inspect.getsource(method)
        assert source.index("self._gate_graph_for_share(") < source.index("self._lock(")
    for method in (
        DriveBulkShareStore.stop,
        DriveBulkShareStore.settle,
        DriveBulkShareStore.release,
    ):
        source = inspect.getsource(method)
        assert source.index("self._gate_graph_for_share(") < source.index("self._owned(")
    refresh = inspect.getsource(DriveBulkShareStore.refresh_request)
    assert refresh.index("self._gate_graph_for_request(") < refresh.index(
        "self._finalize_progressive_request("
    )


@pytest.mark.parametrize("owner_price,amount", [(None, 1000), (3000, 3000)])
def test_first_frozen_batch_orders_at_the_owner_allowed_price(monkeypatch, owner_price, amount):
    request_id = str(uuid4())
    participant = {"user_id": "owner", "recipient_user_id": "recipient"}
    request = {
        "request_id": request_id,
        **participant,
        "payment_required": True,
        "status": "pending",
        "access_stop_requested_at": None,
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    # A Trusted request carries only trusted_auto; an allowed one adds the owner's price.
    private = {"trusted_auto": True, "purpose": DATED_PURPOSE}
    if owner_price is not None:
        private = _owner_allowed(private, owner_price)
    monkeypatch.setattr(DriveSharingStore, "_open_request", lambda self, row: private)
    order = {"status": "awaiting_payment", "amount_cents": amount}
    store = DriveRequestPaymentStore(db=object())
    store._row = Mock(side_effect=[participant, request, None, {"share_id": str(uuid4())}, order])
    connection = SimpleNamespace(execute=Mock())

    _, created, notified = store._ensure_ready(
        connection, user_id="owner", request_id=request_id, share_id=None
    )

    assert created is order and notified is False
    insert = next(
        call
        for call in connection.execute.call_args_list
        if "INSERT INTO drive_request_payment_orders" in str(call.args[0])
    )
    assert insert.args[1]["amount"] == amount


@pytest.mark.parametrize(
    "status,expired", [("cancelled", False), ("declined", False), ("pending", True)]
)
def test_closed_request_does_not_requeue_payment_ready(status, expired):
    request_id = str(uuid4())
    participant = {"user_id": "owner", "recipient_user_id": "recipient"}
    request = {
        "request_id": request_id,
        **participant,
        "payment_required": True,
        "status": status,
        "access_stop_requested_at": None,
        "expires_at": datetime.now(UTC) + timedelta(hours=-1 if expired else 1),
    }
    order = {"status": "awaiting_payment"}
    store = DriveRequestPaymentStore(db=object())
    store._row = Mock(side_effect=[participant, request, order])
    store._event = Mock()
    _, found, notified = store._ensure_ready(
        SimpleNamespace(execute=Mock()), user_id="owner", request_id=request_id, share_id=None
    )
    assert found is order and notified is False
    store._event.assert_not_called()


def test_queued_unposted_grants_do_not_block_terminal_refund_candidate():
    assert "'queued'" not in _REFUND_CANDIDATES_SQL.split("AND NOT EXISTS", 1)[1]
    claim = inspect.getsource(_claim_refunds)
    effects_check = claim[
        claim.index("# Queued grants have not reached") : claim.index(
            "UPDATE drive_request_payment_obligations"
        )
    ]
    assert "'queued'" not in effects_check
    assert "'dispatching'" in effects_check and "'unknown'" in effects_check


def test_payment_migration_replay_guards_existing_triggers():
    migration = (
        Path(__file__).resolve().parents[2] / "db/migrations/262_drive_request_payments.sql"
    ).read_text()
    for trigger, table in (
        ("drive_request_payment_obligation_mirror", "drive_request_payment_orders"),
        ("drive_request_payment_erasure", "drive_share_requests"),
    ):
        guard = f"tgname='{trigger}'\n      AND tgrelid='{table}'::regclass"
        assert guard in migration
        assert migration.index(guard) < migration.index(f"CREATE TRIGGER {trigger}")


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_raw_body_signature_before_database(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    payload, signature = _signed_event(str(uuid4()))
    with pytest.raises(DriveSharingError, match="payment_invalid_signature"):
        await DriveRequestPaymentService(db=object()).process_webhook(
            payload=payload + b" ", signature=signature
        )


@pytest.mark.asyncio
async def test_webhook_maps_missing_signature_type_error_to_client_error(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    stripe_api = SimpleNamespace(
        Webhook=SimpleNamespace(
            construct_event=Mock(side_effect=TypeError("signature header is required"))
        )
    )
    with pytest.raises(DriveSharingError, match="payment_invalid_signature"):
        await DriveRequestPaymentService(db=object(), stripe_api=stripe_api).process_webhook(
            payload=b"{}", signature=None
        )


@pytest.mark.asyncio
async def test_webhook_rejects_non_mapping_stripe_event(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    stripe_api = SimpleNamespace(Webhook=SimpleNamespace(construct_event=Mock(return_value=None)))
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await DriveRequestPaymentService(db=object(), stripe_api=stripe_api).process_webhook(
            payload=b"{}", signature="valid"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "amount,reaches_settlement", [(2000, True), (0, False), (50_100, False), (True, False)]
)
async def test_webhook_checks_amount_shape_before_the_locked_order_binding(
    monkeypatch, amount, reaches_settlement
):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    service = DriveRequestPaymentService(db=object())
    # Settlement compares the locked order amount; here it only records the call.
    service._transaction = AsyncMock(return_value=False)
    payload, signature = _signed_event(str(uuid4()), amount=amount)
    if reaches_settlement:
        await service.process_webhook(payload=payload, signature=signature)
    else:
        with pytest.raises(DriveSharingError, match="payment_invalid_event"):
            await service.process_webhook(payload=payload, signature=signature)
    assert service._transaction.await_count == (1 if reaches_settlement else 0)


def test_checkout_reservation_keeps_attempt_id_for_concurrent_tabs():
    source = inspect.getsource(DriveRequestPaymentService.checkout)
    assert 'if order["checkout_attempt_id"] is None' in source
    assert "expires_at=checkout_expires_at" in source
    assert (
        "idempotency_key=f\"drive-request-{request_id}-{order['checkout_attempt_id']}\"" in source
    )


@pytest.mark.asyncio
async def test_unrelated_signed_checkout_event_is_acknowledged_without_database(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    payload, _ = _signed_event(str(uuid4()))
    document = json.loads(payload)
    document["data"]["object"]["metadata"] = {"payment_kind": "other_product"}
    payload = json.dumps(document).encode()
    timestamp = int(time.time())
    signature = hmac.new(
        b"whsec_payment_test_secret", f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    await DriveRequestPaymentService(db=object()).process_webhook(
        payload=payload, signature=f"t={timestamp},v1={signature}"
    )


@pytest.mark.asyncio
async def test_erased_webhook_requires_reserved_attempt_and_queues_refund(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    request_id, attempt_id = str(uuid4()), str(uuid4())
    payer_ref = hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()
    obligation = {
        "stripe_mode": "test",
        "erased_at": datetime.now(UTC),
        "checkout_attempt_id": attempt_id,
        "stripe_checkout_session_id": None,
        "stripe_payment_intent_id": None,
        "payer_ref": payer_ref,
        "amount_cents": 1000,
        "currency": "usd",
        "status": "checkout_open",
    }
    stripe_api = SimpleNamespace(
        Webhook=SimpleNamespace(
            construct_event=lambda payload, signature, secret: json.loads(payload)
        )
    )
    service = DriveRequestPaymentService(db=object(), stripe_api=stripe_api)
    connection = SimpleNamespace(execute=Mock())

    async def transact(operation):
        return operation(connection)

    service._transaction = transact
    wake = Mock()

    async def wake_sharing(stage):
        wake(stage)

    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.wake_drive_work", wake_sharing
    )
    service._row = Mock(side_effect=[None, None, None, obligation])
    wrong, signature = _signed_event(request_id, attempt_id=str(uuid4()))
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong, signature=signature)
    connection.execute.assert_not_called()

    service._row.side_effect = [None, None, None, obligation]
    payload, signature = _signed_event(request_id, attempt_id=attempt_id)
    await service.process_webhook(payload=payload, signature=signature)
    sql = [str(call.args[0]) for call in connection.execute.call_args_list]
    assert any(
        "UPDATE drive_request_payment_obligations" in statement
        and "reconciliation_required=TRUE" in statement
        for statement in sql
    )
    assert any("INSERT INTO drive_request_payment_webhook_events" in statement for statement in sql)
    wake.assert_called_once_with("sharing")


def test_refund_list_outage_then_same_key_retry_sends_first_create():
    refunds = SimpleNamespace(
        list=Mock(side_effect=[RuntimeError("list unavailable"), {"data": [], "has_more": False}]),
        create=Mock(
            return_value={
                "id": "re_test_once",
                "status": "succeeded",
                "payment_intent": "pi_test_bound",
                "amount": 2000,
                "currency": "usd",
            }
        ),
    )
    service = SimpleNamespace(stripe_api=SimpleNamespace(Refund=refunds))
    # The claim carries the paid obligation's own amount (an owner's $20 price).
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "amount_cents": 2000,
        "attempt_id": str(uuid4()),
        "refund_id": None,
        "first_dispatch_at": datetime.now(UTC),
        "create_allowed": True,
    }
    with pytest.raises(RuntimeError, match="list unavailable"):
        _provider_refund(service, claim, "sk_test_local_only_synthetic")
    refunds.create.assert_not_called()

    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert error is None and refund["id"] == "re_test_once"
    kwargs = refunds.create.call_args.kwargs
    assert kwargs["amount"] == 2000 and kwargs["payment_intent"] == "pi_test_bound"
    assert kwargs["metadata"] == {
        "payment_kind": "drive_request",
        "request_id": claim["request_id"],
    }

    # Negative control: an existing refund for the old fixed price is not this one.
    refunds.list.side_effect = None
    refunds.list.return_value = {
        "data": [{**refunds.create.return_value, "amount": 1000}],
        "has_more": False,
    }
    assert _provider_refund(service, claim, "sk_test_local_only_synthetic") == (
        None,
        "provider_mismatch",
    )
    assert refunds.create.call_count == 1


def test_uncertain_refund_create_retries_same_key_then_stops_after_window():
    created = {
        "id": "re_test_once",
        "status": "succeeded",
        "payment_intent": "pi_test_bound",
        "amount": 1000,
        "currency": "usd",
    }
    refunds = SimpleNamespace(
        list=Mock(return_value={"data": [], "has_more": False}),
        create=Mock(side_effect=[RuntimeError("response lost"), created]),
    )
    service = SimpleNamespace(stripe_api=SimpleNamespace(Refund=refunds))
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "amount_cents": 1000,
        "attempt_id": str(uuid4()),
        "refund_id": None,
        "first_dispatch_at": datetime.now(UTC),
        "create_allowed": True,
    }
    with pytest.raises(RuntimeError, match="response lost"):
        _provider_refund(service, claim, "sk_test_local_only_synthetic")
    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert error is None and refund == created
    assert refunds.create.call_count == 2
    assert (
        refunds.create.call_args_list[0].kwargs["idempotency_key"]
        == refunds.create.call_args_list[1].kwargs["idempotency_key"]
    )

    claim["first_dispatch_at"] = datetime.now(UTC) - timedelta(hours=21)
    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert refund is None and error == "idempotency_window_elapsed"
    assert refunds.create.call_count == 2

    request = {"request_id": claim["request_id"]}
    order = {"status": "paid"}
    refund_row = {"attempt_id": claim["attempt_id"], "status": "dispatching"}
    participant = {"user_id": "owner", "recipient_user_id": "recipient"}
    finish_service = SimpleNamespace(
        _row=Mock(
            side_effect=[
                participant,
                request,
                {"request_id": claim["request_id"]},
                order,
                refund_row,
            ]
        )
    )
    connection = SimpleNamespace(execute=Mock())
    assert _finish_refund(finish_service, connection, claim, None, error) == "manual_review"
    assert connection.execute.call_args.args[1]["status"] == "manual_review"

    claim["create_allowed"] = False
    refunds.list.return_value = {"data": [created], "has_more": False}
    refund, error = _provider_refund(service, claim, "sk_test_local_only_synthetic")
    assert error is None and refund == created
    assert refunds.create.call_count == 2


@pytest.mark.asyncio
async def test_refund_first_dispatch_timestamp_survives_uncertain_retry(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests
          SET payment_required=TRUE,status='expired'
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
          VALUES ('test',:request,'owner','recipient','paid','pi_test_refund',clock_timestamp())"""),
            {"request": request_id},
        )
        first = _claim_refunds(DriveRequestPaymentService(db=sharing.db), connection, limit=1)
    assert len(first) == 1 and first[0]["create_allowed"] is True
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_refunds
          SET status='unknown',lease_expires_at=NULL,
              next_check_at=clock_timestamp()-interval '1 second'
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        second = _claim_refunds(DriveRequestPaymentService(db=sharing.db), connection, limit=1)
    assert len(second) == 1
    assert second[0]["first_dispatch_at"] == first[0]["first_dispatch_at"]
    assert second[0]["attempt_id"] == first[0]["attempt_id"]


def test_confirmed_refund_queues_requester_notice_once():
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "amount_cents": 1000,
        "attempt_id": str(uuid4()),
    }
    request = {"request_id": claim["request_id"], "recipient_user_id": "recipient", "revision": 1}
    order = {"status": "paid"}
    refund_row = {"attempt_id": claim["attempt_id"], "status": "dispatching"}
    participant = {"user_id": "owner", "recipient_user_id": "recipient"}
    service = SimpleNamespace(
        _row=Mock(
            side_effect=[
                participant,
                request,
                {"request_id": claim["request_id"]},
                order,
                refund_row,
            ]
        ),
        _event=Mock(),
    )
    connection = SimpleNamespace(execute=Mock())
    refund = {
        "id": "re_test_once",
        "payment_intent": "pi_test_bound",
        "amount": 1000,
        "currency": "usd",
        "status": "succeeded",
    }
    assert _finish_refund(service, connection, claim, refund, None) == "succeeded"
    service._event.assert_called_once_with(connection, request, "document_share_payment_refunded")

    service._row.side_effect = [
        participant,
        request,
        {"request_id": claim["request_id"]},
        {"status": "refunded"},
        {"attempt_id": claim["attempt_id"], "status": "succeeded"},
    ]
    assert _finish_refund(service, connection, claim, refund, None) == "succeeded"
    service._event.assert_called_once()


def test_partial_refund_keeps_delivered_payment_paid():
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_partial",
        "amount_cents": 500,
        "gross_amount_cents": 1000,
        "attempt_id": str(uuid4()),
    }
    request = {"request_id": claim["request_id"], "recipient_user_id": "recipient", "revision": 1}
    service = SimpleNamespace(
        _row=Mock(
            side_effect=[
                {"user_id": "owner", "recipient_user_id": "recipient"},
                request,
                {"request_id": claim["request_id"]},
                {"status": "paid", "amount_cents": 1000},
                {"attempt_id": claim["attempt_id"], "status": "dispatching"},
            ]
        ),
        _event=Mock(),
    )
    connection = SimpleNamespace(execute=Mock())
    refund = {
        "id": "re_test_partial",
        "payment_intent": "pi_test_partial",
        "amount": 500,
        "currency": "usd",
        "status": "succeeded",
    }
    assert _finish_refund(service, connection, claim, refund, None) == "succeeded"
    service._event.assert_called_once_with(connection, request, "document_share_payment_refunded")
    assert not any(
        "status='refunded'" in str(call.args[0]) for call in connection.execute.call_args_list
    )


def test_inflight_refund_finishes_after_request_erasure_without_feed_event():
    claim = {
        "request_id": str(uuid4()),
        "payment_intent": "pi_test_bound",
        "amount_cents": 1000,
        "attempt_id": str(uuid4()),
    }
    obligation = {"status": "paid", "erased_at": datetime.now(UTC)}
    refund_row = {"attempt_id": claim["attempt_id"], "status": "dispatching"}
    service = SimpleNamespace(
        _row=Mock(side_effect=[None, None, obligation, refund_row]), _event=Mock()
    )
    connection = SimpleNamespace(execute=Mock())
    refund = {
        "id": "re_test_erased",
        "payment_intent": "pi_test_bound",
        "amount": 1000,
        "currency": "usd",
        "status": "succeeded",
    }

    assert _finish_refund(service, connection, claim, refund, None) == "succeeded"
    service._event.assert_not_called()
    statements = [str(call.args[0]) for call in connection.execute.call_args_list]
    assert any(
        "UPDATE drive_request_payment_obligations" in sql and "status='refunded'" in sql
        for sql in statements
    )


@pytest.mark.asyncio
async def test_signed_webhook_requires_exact_order_binding_and_replays_once(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,status,stripe_checkout_session_id,
           stripe_checkout_url,stripe_checkout_expires_at)
          VALUES ('test',:id,'owner','recipient','checkout_open','cs_test_bound',
                  'https://checkout.stripe.com/test',clock_timestamp()+interval '1 hour')"""),
            {"id": request_id},
        )
    service = DriveRequestPaymentService(db=sharing.db)

    wrong_amount, signature = _signed_event(request_id, amount=900)
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong_amount, signature=signature)
    wrong_session, signature = _signed_event(request_id, session_id="cs_test_other")
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong_session, signature=signature)

    payload, signature = _signed_event(request_id)
    await service.process_webhook(payload=payload, signature=signature)
    await service.process_webhook(payload=payload, signature=signature)
    with sharing.db.engine.begin() as connection:
        order = (
            connection.execute(
                text("""SELECT status,paid_at,stripe_checkout_url
          FROM drive_request_payment_orders WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        events = connection.execute(
            text("""SELECT count(*) FROM drive_request_payment_webhook_events
          WHERE request_id=:id"""),
            {"id": request_id},
        ).scalar_one()
    assert order["status"] == "paid" and order["paid_at"] is not None
    assert order["stripe_checkout_url"] is None
    assert events == 1


@pytest.mark.asyncio
async def test_owner_priced_payment_settles_and_refunds_only_at_its_order_amount(
    sharing, monkeypatch
):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    request_id = (await request(sharing))["requestId"]
    attempt = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET payment_required=TRUE,status='approved'
              WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,amount_cents,status,checkout_attempt_id,
               stripe_checkout_session_id,stripe_checkout_url,stripe_checkout_expires_at)
              VALUES ('test',:request,'owner','recipient',2000,'checkout_open',:attempt,'cs_test_bound',
                      'https://checkout.stripe.com/test',clock_timestamp()+interval '1 hour')"""),
            {"request": request_id, "attempt": attempt},
        )
    refunds = SimpleNamespace(
        list=Mock(return_value={"data": [], "has_more": False}),
        create=Mock(
            side_effect=lambda **kwargs: {
                "id": "re_test_owner_price",
                "status": "succeeded",
                "payment_intent": kwargs["payment_intent"],
                "amount": kwargs["amount"],
                "currency": "usd",
            }
        ),
    )
    service = DriveRequestPaymentService(
        db=sharing.db, stripe_api=SimpleNamespace(Webhook=stripe.Webhook, Refund=refunds)
    )

    def payment_row():
        with sharing.db.engine.begin() as connection:
            return tuple(
                connection.execute(
                    text("""SELECT o.status,o.reconciliation_required,b.amount_cents
                      FROM drive_request_payment_orders o
                      JOIN drive_request_payment_obligations b ON b.request_id=o.request_id
                      WHERE o.request_id=:request"""),
                    {"request": request_id},
                ).one()
            )

    # Negative control: the former fixed $10 total no longer matches this order.
    wrong, signature = _signed_event(request_id, amount=1000, attempt_id=attempt)
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong, signature=signature)
    assert payment_row() == ("checkout_open", False, 2000)
    payload, signature = _signed_event(request_id, amount=2000, attempt_id=attempt)
    await service.process_webhook(payload=payload, signature=signature)
    assert payment_row() == ("paid", False, 2000)

    # Nothing was delivered before the request closed: refund what was paid.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET status='expired' WHERE request_id=:request"),
            {"request": request_id},
        )
    outcomes = await service.reconcile_refunds(max_orders=1)
    assert (outcomes["claimed"], outcomes["succeeded"]) == (1, 1)
    assert refunds.create.call_args.kwargs["amount"] == 2000
    assert payment_row()[0] == "refunded"


@pytest.mark.asyncio
async def test_expired_checkout_webhook_marks_link_expired_and_is_idempotent(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id = created["requestId"]
    attempt = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,status,checkout_attempt_id,
           stripe_checkout_session_id,stripe_checkout_url,stripe_checkout_expires_at)
          VALUES ('test',:id,'owner','recipient','checkout_open',:attempt,'cs_test_expired',
                  'https://checkout.stripe.com/expired',clock_timestamp()+interval '1 hour')"""),
            {"id": request_id, "attempt": attempt},
        )
    service = DriveRequestPaymentService(db=sharing.db)
    payload, signature = _signed_event(
        request_id,
        session_id="cs_test_expired",
        event_type="checkout.session.expired",
        payment_status="unpaid",
        payment_intent=None,
        attempt_id=attempt,
    )
    await service.process_webhook(payload=payload, signature=signature)
    await service.process_webhook(payload=payload, signature=signature)
    with sharing.db.engine.begin() as connection:
        order = (
            connection.execute(
                text("""SELECT status,stripe_checkout_session_id,stripe_checkout_url
                  FROM drive_request_payment_orders WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        events = connection.execute(
            text("""SELECT count(*) FROM drive_request_payment_webhook_events
              WHERE request_id=:id"""),
            {"id": request_id},
        ).scalar_one()
    assert order["status"] == "expired"
    assert order["stripe_checkout_session_id"] == "cs_test_expired"
    assert order["stripe_checkout_url"] is None
    assert events == 1


@pytest.mark.asyncio
async def test_payment_state_reports_expired_checkout_link(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,status,checkout_attempt_id,
           stripe_checkout_session_id,stripe_checkout_url,stripe_checkout_expires_at)
          VALUES ('test',:id,'owner','recipient','checkout_open',:attempt,'cs_test_old',
                  'https://checkout.stripe.com/old',clock_timestamp()-interval '1 second')"""),
            {"id": request_id, "attempt": str(uuid4())},
        )
    state = await DriveRequestPaymentService(db=sharing.db).payment_state(
        requester_user_id="recipient", request_id=request_id
    )
    assert state["status"] == "expired"
    assert state["paymentLinkExpired"] is True
    assert state["checkoutExpiresAt"] is not None


@pytest.mark.asyncio
async def test_deleting_request_keeps_opaque_payment_obligation(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:id"),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id) VALUES ('test',:id,'owner','recipient')"""),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_webhook_events
          (stripe_event_id,stripe_checkout_session_id,request_id)
          VALUES ('evt_test_erasure','cs_test_erasure',:id)"""),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_refunds
          (request_id,attempt_id,status) VALUES (:id,:attempt,'queued')"""),
            {"id": request_id, "attempt": str(uuid4())},
        )
        # The existing request-erasure path removes its generic outbox first.
        connection.execute(
            text("DELETE FROM drive_share_events WHERE request_id=:id"), {"id": request_id}
        )
        connection.execute(
            text("DELETE FROM drive_share_requests WHERE request_id=:id"), {"id": request_id}
        )
        order_count = connection.execute(
            text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
        obligation = (
            connection.execute(
                text("""SELECT status,erased_at,payer_ref,
          reconciliation_required FROM drive_request_payment_obligations
          WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        event_count = connection.execute(
            text("SELECT count(*) FROM drive_request_payment_webhook_events WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
        refund_count = connection.execute(
            text("SELECT count(*) FROM drive_request_payment_refunds WHERE request_id=:id"),
            {"id": request_id},
        ).scalar_one()
    assert (order_count, event_count, refund_count) == (0, 1, 1)
    assert obligation["erased_at"] is not None
    assert obligation["reconciliation_required"] is True
    assert obligation["payer_ref"] == hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()


@pytest.mark.asyncio
async def test_late_paid_webhook_after_erasure_uses_reserved_attempt(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id = created["requestId"]
    attempt_id = str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET payment_required=TRUE
          WHERE request_id=:id"""),
            {"id": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,checkout_attempt_id)
          VALUES ('test',:id,'owner','recipient',:attempt)"""),
            {"id": request_id, "attempt": attempt_id},
        )
        connection.execute(
            text("DELETE FROM drive_share_events WHERE request_id=:id"), {"id": request_id}
        )
        connection.execute(
            text("DELETE FROM drive_share_requests WHERE request_id=:id"), {"id": request_id}
        )

    service = DriveRequestPaymentService(db=sharing.db)
    wrong, signature = _signed_event(request_id, attempt_id=str(uuid4()))
    with pytest.raises(DriveSharingError, match="payment_invalid_event"):
        await service.process_webhook(payload=wrong, signature=signature)

    payload, signature = _signed_event(request_id, attempt_id=attempt_id)
    await service.process_webhook(payload=payload, signature=signature)
    await service.process_webhook(payload=payload, signature=signature)
    with sharing.db.engine.begin() as connection:
        obligation = (
            connection.execute(
                text("""SELECT status,paid_at,
          stripe_checkout_session_id,stripe_payment_intent_id,
          reconciliation_required FROM drive_request_payment_obligations
          WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
        events = connection.execute(
            text("""SELECT count(*)
          FROM drive_request_payment_webhook_events WHERE request_id=:id"""),
            {"id": request_id},
        ).scalar_one()
        claims = _claim_refunds(service, connection, limit=1)
    assert obligation["status"] == "paid" and obligation["paid_at"] is not None
    assert obligation["stripe_checkout_session_id"] == "cs_test_bound"
    assert obligation["stripe_payment_intent_id"] == "pi_test_bound"
    assert obligation["reconciliation_required"] is True and events == 1
    assert len(claims) == 1 and claims[0]["payment_intent"] == "pi_test_bound"


def _checkout_fixture(monkeypatch, provider_create, *, amount_cents=1000):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    request_id, attempt_id = str(uuid4()), str(uuid4())
    order = {
        "stripe_mode": "test",
        "status": "awaiting_payment",
        "amount_cents": amount_cents,
        "currency": "usd",
        "request_status": "pending",
        "request_expires_at": datetime.now(UTC) + timedelta(hours=1),
        "checkout_attempt_id": attempt_id,
        "stripe_checkout_url": None,
        "stripe_checkout_session_id": None,
        "stripe_checkout_expires_at": datetime.fromtimestamp(int(time.time()) + 31 * 60, UTC),
    }
    service = DriveRequestPaymentService(
        db=object(),
        stripe_api=SimpleNamespace(
            checkout=SimpleNamespace(Session=SimpleNamespace(create=provider_create))
        ),
    )
    service.payment_state = AsyncMock(return_value={"status": "awaiting_payment"})
    service._current_checkout_authority = Mock(
        return_value={"request_id": request_id, "recipient_user_id": "recipient", "revision": 1}
    )
    service._row = Mock(side_effect=lambda *args, **kwargs: order.copy())
    connection = SimpleNamespace(execute=Mock())

    async def transact(operation):
        return operation(connection)

    service._transaction = transact
    return service, request_id, attempt_id, connection


def _checkout_sdk_response(params, session_id="cs_test_checkout_regression", *, amount_total=None):
    # Stripe totals the one line item unless a test overrides the provider's answer.
    price = params["line_items"][0]["price_data"]
    return stripe.checkout.Session.construct_from(
        {
            "id": session_id,
            "object": "checkout.session",
            "mode": params["mode"],
            "client_reference_id": params["client_reference_id"],
            "amount_total": price["unit_amount"] if amount_total is None else amount_total,
            "currency": price["currency"],
            "livemode": False,
            "metadata": params["metadata"],
            "url": f"https://checkout.stripe.com/c/pay/{session_id}",
            "expires_at": params["expires_at"],
        },
        params["api_key"],
    )


@pytest.mark.asyncio
async def test_enrolled_checkout_stops_before_reservation_when_payouts_disabled(monkeypatch):
    create = Mock()
    service, request_id, _, connection = _checkout_fixture(monkeypatch, create)
    monkeypatch.delenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", raising=False)
    service.payment_state = AsyncMock(
        return_value={
            "status": "awaiting_payment",
            "_payout_enrolled": True,
            "_payout_owner_user_id": "owner",
        }
    )
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    connection.execute.assert_not_called()
    create.assert_not_called()


@pytest.mark.asyncio
async def test_enrolled_checkout_binds_verified_connect_destination(monkeypatch):
    from hushh_mcp.services.pkm_payout_service import PkmPayoutService

    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setattr(
        PkmPayoutService,
        "refresh_account",
        AsyncMock(
            return_value={
                "stripe_account_id": "acct_verified",
                "readiness": {"ready": True},
            }
        ),
    )
    create = Mock(side_effect=lambda **params: _checkout_sdk_response(params))
    service, request_id, _, _ = _checkout_fixture(monkeypatch, create)
    service.payment_state = AsyncMock(
        return_value={
            "status": "awaiting_payment",
            "_payout_enrolled": True,
            "_payout_owner_user_id": "owner",
        }
    )
    original_row = service._row.side_effect

    def row(connection, sql, params):
        if "FROM stripe_owner_payout_accounts" in sql:
            return {
                "stripe_account_id": "acct_verified",
                "details_submitted": True,
                "payouts_enabled": True,
            }
        if "UPDATE drive_request_owner_payouts" in sql:
            return {"destination_account_id": "acct_verified"}
        return original_row(connection, sql, params)

    service._row.side_effect = row
    await service.checkout(requester_user_id="recipient", request_id=request_id)
    bound = [
        call
        for call in service._row.call_args_list
        if "UPDATE drive_request_owner_payouts" in call.args[1]
    ]
    assert len(bound) == 1
    assert bound[0].args[2]["account"] == "acct_verified"
    assert create.call_args.kwargs["payment_intent_data"]["transfer_group"] == (
        f"drive-request-{request_id}"
    )


@pytest.mark.asyncio
async def test_enrolled_checkout_rejects_changed_connect_mapping_before_charge(monkeypatch):
    from hushh_mcp.services.pkm_payout_service import PkmPayoutService

    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setattr(
        PkmPayoutService,
        "refresh_account",
        AsyncMock(
            return_value={
                "stripe_account_id": "acct_verified",
                "readiness": {"ready": True},
            }
        ),
    )
    create = Mock()
    service, request_id, _, _ = _checkout_fixture(monkeypatch, create)
    service.payment_state = AsyncMock(
        return_value={
            "status": "awaiting_payment",
            "_payout_enrolled": True,
            "_payout_owner_user_id": "owner",
        }
    )
    original_row = service._row.side_effect

    def row(connection, sql, params):
        if "FROM stripe_owner_payout_accounts" in sql:
            return {
                "stripe_account_id": "acct_changed",
                "details_submitted": True,
                "payouts_enabled": True,
            }
        return original_row(connection, sql, params)

    service._row.side_effect = row
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    create.assert_not_called()
    assert not any(
        "UPDATE drive_request_owner_payouts" in call.args[1] for call in service._row.call_args_list
    )


@pytest.mark.asyncio
async def test_requester_payment_projection_does_not_expose_payout_owner():
    service = DriveRequestPaymentService(db=object())
    service.payment_state = AsyncMock(
        return_value={
            "status": "awaiting_payment",
            "amountCents": 1000,
            "_payout_enrolled": True,
            "_payout_owner_user_id": "owner-secret",
        }
    )
    assert await service.get_payment(requester_user_id="recipient", request_id=str(uuid4())) == {
        "status": "awaiting_payment",
        "amountCents": 1000,
    }


@pytest.mark.asyncio
async def test_checkout_uses_supported_stripe_parameters_and_binds_sdk_session(monkeypatch):
    def create_session(**params):
        # UAT Stripe rejected this legacy argument before opening Checkout.
        if "payment_method_types" in params:
            raise stripe.InvalidRequestError(
                "payment_method_types is no longer supported",
                "payment_method_types",
                http_status=400,
            )
        assert params["mode"] == "payment"
        assert params["line_items"] == [
            {
                "price_data": {
                    "currency": "usd",
                    "unit_amount": 1000,
                    "product_data": {"name": "Document request"},
                },
                "quantity": 1,
            }
        ]
        assert params["idempotency_key"] == f"drive-request-{request_id}-{attempt_id}"
        assert params["payment_intent_data"]["metadata"] == params["metadata"]
        return _checkout_sdk_response(params)

    create = Mock(side_effect=create_session)
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    result = await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert result == {
        "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_checkout_regression"
    }
    create.assert_called_once()
    assert service._current_checkout_authority.call_count == 2
    binding = next(
        call.args[1]
        for call in connection.execute.call_args_list
        if "SET status='checkout_open'" in str(call.args[0])
    )
    assert binding["request"] == request_id
    assert binding["session"] == "cs_test_checkout_regression"
    assert binding["url"] == result["checkoutUrl"]
    calls = connection.execute.call_args_list
    assert next(
        i for i, call in enumerate(calls) if "SET status='checkout_open'" in str(call.args[0])
    ) < next(
        i
        for i, call in enumerate(calls)
        if call.args[1].get("type") == "document_share_payment_ready"
    )
    assert create.call_args.kwargs["expires_at"] == binding["expires"]


@pytest.mark.asyncio
async def test_checkout_charges_the_order_amount_and_binds_only_that_amount(monkeypatch):
    create = Mock(side_effect=lambda **params: _checkout_sdk_response(params))
    service, request_id, _, connection = _checkout_fixture(monkeypatch, create, amount_cents=2000)
    result = await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert result["checkoutUrl"].endswith("cs_test_checkout_regression")
    assert create.call_args.kwargs["line_items"][0]["price_data"] == {
        "currency": "usd",
        "unit_amount": 2000,
        "product_data": {"name": "Document request"},
    }

    # Negative control: a session Stripe totals differently is never bound.
    create = Mock(side_effect=lambda **params: _checkout_sdk_response(params, amount_total=1000))
    service, request_id, _, connection = _checkout_fixture(monkeypatch, create, amount_cents=2000)
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert not any(
        "SET status='checkout_open'" in str(call.args[0])
        for call in connection.execute.call_args_list
    )


@pytest.mark.asyncio
async def test_checkout_recovers_rejected_legacy_attempt_with_stable_retry_key(monkeypatch):
    def create_session(**params):
        if params["idempotency_key"] == original_key:
            if params.get("payment_method_types") == ["card"]:
                raise stripe.InvalidRequestError(
                    "payment_method_types is no longer supported",
                    "payment_method_types",
                    http_status=400,
                )
            raise stripe.IdempotencyError("Different parameters", http_status=400)
        assert params["idempotency_key"] == original_key + "-dynamic-methods-v1"
        assert "payment_method_types" not in params
        return _checkout_sdk_response(params)

    create = Mock(side_effect=create_session)
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    original_key = f"drive-request-{request_id}-{attempt_id}"
    # The provider succeeds, but the database bind is interrupted. Retrying the
    # same order must replay the same fallback key instead of opening a new order.
    connection.execute.side_effect = [
        None,
        RuntimeError("bind interrupted"),
        None,
        None,
        Mock(rowcount=1),
    ]
    with pytest.raises(RuntimeError, match="bind interrupted"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    result = await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert result["checkoutUrl"].endswith("cs_test_checkout_regression")
    calls = [call.kwargs for call in create.call_args_list]
    assert [call["idempotency_key"] for call in calls] == [
        original_key,
        original_key,
        original_key + "-dynamic-methods-v1",
        original_key,
        original_key,
        original_key + "-dynamic-methods-v1",
    ]
    assert calls[1] == {**calls[0], "payment_method_types": ["card"]}
    assert calls[2] == {**calls[0], "idempotency_key": original_key + "-dynamic-methods-v1"}
    assert calls[:3] == calls[3:]
    assert any(
        call.args[1].get("session") == "cs_test_checkout_regression"
        for call in connection.execute.call_args_list
    )


@pytest.mark.asyncio
async def test_checkout_binds_cached_legacy_success_without_creating_another_session(monkeypatch):
    def create_session(**params):
        if "payment_method_types" not in params:
            raise stripe.IdempotencyError("Different parameters", http_status=400)
        assert params["payment_method_types"] == ["card"]
        return _checkout_sdk_response(params, "cs_test_existing_legacy")

    create = Mock(side_effect=create_session)
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    result = await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert result["checkoutUrl"].endswith("cs_test_existing_legacy")
    assert create.call_count == 2
    assert {call.kwargs["idempotency_key"] for call in create.call_args_list} == {
        f"drive-request-{request_id}-{attempt_id}"
    }
    assert any(
        call.args[1].get("session") == "cs_test_existing_legacy"
        for call in connection.execute.call_args_list
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "legacy_error",
    [
        stripe.APIConnectionError("Provider outcome is unknown"),
        stripe.InvalidRequestError("Different parameter rejected", "currency", http_status=400),
        stripe.InvalidRequestError("Provider failed", "payment_method_types", http_status=500),
        stripe.IdempotencyError("Legacy payload mismatch", http_status=400),
    ],
    ids=["network", "other-parameter", "server-error", "legacy-idempotency-conflict"],
)
async def test_checkout_does_not_change_retry_key_for_uncertain_legacy_outcome(
    monkeypatch, legacy_error
):
    create = Mock(
        side_effect=[stripe.IdempotencyError("Different parameters", http_status=400), legacy_error]
    )
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    assert create.call_count == 2
    assert {call.kwargs["idempotency_key"] for call in create.call_args_list} == {
        f"drive-request-{request_id}-{attempt_id}"
    }
    # Only reserve happened; no checkout session was bound and no alternate
    # provider key was tried for an outcome that could already have succeeded.
    assert connection.execute.call_count == 1


@pytest.mark.asyncio
async def test_checkout_does_not_replay_or_rotate_an_in_progress_idempotency_key(monkeypatch):
    create = Mock(
        side_effect=stripe.IdempotencyError(
            "Another request is in progress", http_status=409, code="idempotency_key_in_use"
        )
    )
    service, request_id, attempt_id, connection = _checkout_fixture(monkeypatch, create)
    with pytest.raises(DriveSharingError, match="payment_unavailable"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    create.assert_called_once()
    assert create.call_args.kwargs["idempotency_key"] == f"drive-request-{request_id}-{attempt_id}"
    assert "payment_method_types" not in create.call_args.kwargs
    assert connection.execute.call_count == 1


@pytest.mark.asyncio
async def test_expired_bound_checkout_cannot_open_another_payment_window(monkeypatch):
    create = Mock(side_effect=AssertionError("expired Checkout must not rotate"))
    service, request_id, _, connection = _checkout_fixture(monkeypatch, create)
    service.payment_state = AsyncMock(
        return_value={"status": "expired", "paymentLinkExpired": True}
    )

    with pytest.raises(DriveSharingError, match="payment_checkout_expired"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)

    create.assert_not_called()
    connection.execute.assert_not_called()


@pytest.mark.asyncio
async def test_unbound_reservation_expiry_is_not_an_actionable_pay_deadline(monkeypatch):
    request_id = str(uuid4())
    request_row = {
        "request_id": request_id,
        "user_id": "owner",
        "recipient_user_id": "recipient",
        "payment_required": True,
        "status": "approved",
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
        "access_stop_requested_at": None,
    }
    order = {
        "stripe_mode": "test",
        "status": "awaiting_payment",
        "amount_cents": 1000,
        "currency": "usd",
        "reconciliation_required": False,
        "stripe_checkout_session_id": None,
        "stripe_checkout_expires_at": datetime.now(UTC) - timedelta(minutes=1),
    }
    store = DriveRequestPaymentStore(db=object())
    store._row = Mock(side_effect=[request_row, order])
    monkeypatch.setattr(DriveSharingStore, "_open_request", lambda *_: {"trusted_auto": False})

    async def transaction(operation):
        return operation(SimpleNamespace())

    store._transaction = transaction
    state = await store.payment_state(requester_user_id="recipient", request_id=request_id)
    assert state["status"] == "awaiting_payment"
    assert state["paymentLinkExpired"] is False
    assert state["checkoutExpiresAt"] is None


@pytest.mark.asyncio
async def test_checkout_preparation_is_bounded_and_does_not_announce_failed_payment(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    first, second = str(uuid4()), str(uuid4())
    service = SimpleNamespace(
        due_checkout_orders=AsyncMock(
            return_value=[
                {"request_id": first, "requester_user_id": "recipient"},
                {"request_id": second, "requester_user_id": "recipient"},
            ]
        ),
        checkout=AsyncMock(
            side_effect=[
                DriveSharingError("payment_not_ready"),
                {"checkoutUrl": "https://checkout.stripe.com/test"},
            ]
        ),
        defer_unready_checkout_order=AsyncMock(),
    )
    result = await DriveRequestPaymentCheckoutWorker(service).run(max_jobs=2, deadline_seconds=20)
    assert result == {"outcomes": {"not_ready": 1, "ready": 1}}
    assert service.checkout.await_count == 2
    service.defer_unready_checkout_order.assert_awaited_once_with(
        request_id=first, requester_user_id="recipient"
    )
    service.due_checkout_orders.assert_awaited_once_with(limit=10)


@pytest.mark.asyncio
async def test_four_stale_orders_do_not_consume_four_provider_slots(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    ids = [str(uuid4()) for _ in range(5)]
    service = SimpleNamespace(
        due_checkout_orders=AsyncMock(
            return_value=[
                {"request_id": request_id, "requester_user_id": "recipient"} for request_id in ids
            ]
        ),
        checkout=AsyncMock(
            side_effect=[
                *[DriveSharingError("payment_not_ready") for _ in range(4)],
                {"checkoutUrl": "https://checkout.stripe.com/test"},
            ]
        ),
        defer_unready_checkout_order=AsyncMock(),
    )

    result = await DriveRequestPaymentCheckoutWorker(service).run(max_jobs=4, deadline_seconds=20)

    assert result == {"outcomes": {"not_ready": 4, "ready": 1}}
    assert service.checkout.await_count == 5
    assert service.defer_unready_checkout_order.await_count == 4


@pytest.mark.asyncio
async def test_checkout_candidates_exclude_pending_without_approved_or_frozen_batch(sharing):
    stale = [(await request(sharing))["requestId"] for _ in range(4)]
    approved = (await request(sharing))["requestId"]
    with sharing.db.engine.begin() as connection:
        for request_id in [*stale, approved]:
            connection.execute(
                text("""UPDATE drive_share_requests SET payment_required=TRUE
                  WHERE request_id=:request"""),
                {"request": request_id},
            )
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                  (stripe_mode,request_id,user_id,requester_user_id)
                  VALUES ('test',:request,'owner','recipient')"""),
                {"request": request_id},
            )
        connection.execute(
            text("""UPDATE drive_share_requests SET status='approved'
              WHERE request_id=:request"""),
            {"request": approved},
        )

    due = await DriveRequestPaymentStore(db=sharing.db).due_checkout_orders(limit=4)
    assert [row["request_id"] for row in due] == [approved]


@pytest.mark.asyncio
async def test_owner_allowed_request_pays_the_owner_price_without_trusted_membership(
    request_bulk, sharing
):
    # The requester is connected, but the owner's Trusted circle holds someone else.
    request_id = (await request(sharing))["requestId"]
    _owner_allow(sharing, request_id, amount_cents=3000)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=_search(request_bulk, request_id=request_id, count=1),
        client_request_id=str(uuid4()),
        origin_request_id=request_id,
        recipients=[
            {
                "userId": "recipient",
                "email": "recipient@example.invalid",
                "subject": "1234567",
                "kind": "google_provider",
            }
        ],
        excluded=[],
        selected_positions=[1],
    )
    create_session = Mock(
        side_effect=lambda **params: _checkout_sdk_response(params, "cs_test_owner_price")
    )
    payment = DriveRequestPaymentService(
        db=sharing.db,
        stripe_api=SimpleNamespace(
            checkout=SimpleNamespace(Session=SimpleNamespace(create=create_session))
        ),
    )
    quote = await payment.payment_state(requester_user_id="recipient", request_id=request_id)
    assert (quote["status"], quote["amountCents"]) == ("preparing", 3000)

    ready = await payment.ensure_payment_for_frozen_batch("owner", request_id, review["shareId"])
    assert ready["status"] == "awaiting_payment"
    with sharing.db.engine.begin() as connection:
        stored = connection.execute(
            text("""SELECT o.amount_cents,b.amount_cents FROM drive_request_payment_orders o
              JOIN drive_request_payment_obligations b ON b.request_id=o.request_id
              WHERE o.request_id=:request"""),
            {"request": request_id},
        ).one()
    assert tuple(stored) == (3000, 3000)
    checkout = await payment.checkout(requester_user_id="recipient", request_id=request_id)
    assert checkout["checkoutUrl"].endswith("cs_test_owner_price")
    assert create_session.call_args.kwargs["line_items"][0]["price_data"]["unit_amount"] == 3000

    def authority():
        with sharing.db.engine.begin() as connection:
            return payment._current_checkout_authority(
                connection, request_id=request_id, requester_user_id="recipient"
            )

    # Negative controls: trusted_auto without the owner's Allow, then no connection.
    _reseal_request(
        sharing,
        request_id,
        lambda private: {key: value for key, value in private.items() if key != "owner_allowed"},
    )
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        authority()
    _owner_allow(sharing, request_id, amount_cents=3000)
    assert authority()["recipient_user_id"] == "recipient"
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE connections SET status='removed'
              WHERE 'recipient' IN (user_a_id,user_b_id)""")
        )
        # The disconnect transaction ends the Allow (ConnectionsService.remove_connection).
        end_owner_allows_for_disconnected_pair(connection, user_a_id="owner", user_b_id="recipient")
    with pytest.raises(DriveSharingError, match="connection_required"):
        authority()
    # Reconnecting never restores the Allow, so the requester cannot pay for it.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE connections SET status='active'
              WHERE 'recipient' IN (user_a_id,user_b_id)""")
        )
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        authority()
    with pytest.raises(DriveSharingError, match="payment_not_ready"):
        await payment.checkout(requester_user_id="recipient", request_id=request_id)
    assert create_session.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "order",
    [
        None,
        {
            "status": "awaiting_payment",
            "amount_cents": 1000,
            "currency": "usd",
            "reconciliation_required": False,
        },
    ],
)
async def test_no_match_request_closes_unpaid_payment_state(order):
    request = {
        "request_id": str(uuid4()),
        "user_id": "owner",
        "recipient_user_id": "recipient",
        "payment_required": True,
        "status": "no_match",
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    store = DriveRequestPaymentStore(db=object())
    store._row = Mock(side_effect=[request, order])

    async def transaction(operation):
        return operation(SimpleNamespace())

    store._transaction = transaction
    state = await store.payment_state(
        requester_user_id="recipient", request_id=request["request_id"]
    )
    assert state["status"] == "expired"
    assert store._row.call_count == 2


def _make_legacy_undated_paid_request(sharing, connection, request_id):
    row = (
        connection.execute(
            text("SELECT * FROM drive_share_requests WHERE request_id=:request"),
            {"request": request_id},
        )
        .mappings()
        .one()
    )
    private = sharing._open_request(row)
    private["purpose"]["periodStart"] = None
    private["purpose"]["periodEnd"] = None
    envelope = sharing.sharing_cipher.seal(
        private, user_id="owner", resource_id=request_id, purpose="request"
    )
    connection.execute(
        text("""UPDATE drive_share_requests
      SET payment_required=TRUE,request_envelope=CAST(:envelope AS jsonb)
      WHERE request_id=:request"""),
        {"request": request_id, "envelope": json.dumps(envelope)},
    )


@pytest.mark.asyncio
async def test_legacy_undated_request_cannot_prepare_a_payment_order(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        _make_legacy_undated_paid_request(sharing, connection, request_id)
        with pytest.raises(DriveSharingError, match="date_range_required"):
            DriveRequestPaymentStore(db=sharing.db)._ensure_ready(
                connection, user_id="owner", request_id=request_id, share_id=None
            )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )


@pytest.mark.asyncio
async def test_legacy_undated_order_cannot_start_checkout(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        _make_legacy_undated_paid_request(sharing, connection, request_id)
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,status)
          VALUES ('test',:request,'owner','recipient','awaiting_payment')"""),
            {"request": request_id},
        )
    stripe_api = Mock()
    service = DriveRequestPaymentService(db=sharing.db, stripe_api=stripe_api)
    with pytest.raises(DriveSharingError, match="date_range_required"):
        await service.checkout(requester_user_id="recipient", request_id=request_id)
    stripe_api.checkout.Session.create.assert_not_called()


@pytest.mark.asyncio
async def test_paid_undated_request_stays_visible_and_enters_refund_reconciliation(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        _make_legacy_undated_paid_request(sharing, connection, request_id)
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
          VALUES ('test',:request,'owner','recipient','paid','pi_test_undated',clock_timestamp())"""),
            {"request": request_id},
        )
    service = DriveRequestPaymentService(db=sharing.db)
    state = await service.payment_state(requester_user_id="recipient", request_id=request_id)
    assert state["status"] == "paid"
    assert state["reconciliationRequired"] is True
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT reconciliation_required FROM drive_request_payment_orders
              WHERE request_id=:request"""),
                {"request": request_id},
            ).scalar_one()
            is False
        )
    assert await service.repair_paid_request_authority(limit=64) == 1
    with sharing.db.engine.begin() as connection:
        claims = _claim_refunds(service, connection, limit=1)
    assert len(claims) == 1
    assert claims[0]["payment_intent"] == "pi_test_undated"


@pytest.mark.asyncio
async def test_authority_repair_keeps_an_owner_allowed_paid_order(sharing):
    allowed = (await request(sharing))["requestId"]
    unapproved = (await request(sharing))["requestId"]
    _owner_allow(sharing, allowed, amount_cents=1000)
    with sharing.db.engine.begin() as connection:
        for request_id in (allowed, unapproved):
            connection.execute(
                text("""UPDATE drive_share_requests SET payment_required=TRUE
                  WHERE request_id=:request"""),
                {"request": request_id},
            )
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                  (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
                  VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())"""),
                {"request": request_id},
            )

    # Negative control: a paid order the owner neither allowed nor approved is held.
    assert await DriveRequestPaymentService(db=sharing.db).repair_paid_request_authority() == 1
    with sharing.db.engine.begin() as connection:
        held = dict(
            connection.execute(
                text("""SELECT request_id::text,reconciliation_required
                  FROM drive_request_payment_orders""")
            ).all()
        )
    assert held == {allowed: False, unapproved: True}


@pytest.mark.asyncio
async def test_paid_no_match_request_is_immediately_refund_eligible(sharing):
    created = await request(sharing)
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests
          SET payment_required=TRUE,status='no_match'
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
          (stripe_mode,request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
          VALUES ('test',:request,'owner','recipient','paid','pi_test_no_match',clock_timestamp())"""),
            {"request": request_id},
        )
        claims = _claim_refunds(DriveRequestPaymentService(db=sharing.db), connection, limit=1)
    assert len(claims) == 1
    assert str(claims[0]["request_id"]) == request_id
    assert claims[0]["payment_intent"] == "pi_test_no_match"


@pytest.mark.asyncio
async def test_webhook_waits_for_account_erasure_and_reconciles_late_payment(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    created = await request(sharing)
    request_id, attempt_id = created["requestId"], str(uuid4())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:request"),
            {"request": request_id},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,checkout_attempt_id,
               stripe_checkout_session_id)
              VALUES ('test',:request,'owner','recipient','checkout_open',:attempt,'cs_test_bound')"""),
            {"request": request_id, "attempt": attempt_id},
        )

    service = DriveRequestPaymentService(db=sharing.db)
    erasure_held = threading.Event()
    release_erasure = threading.Event()
    webhook_entered = threading.Event()
    erasure_pid: list[int] = []
    webhook_pid: list[int] = []

    def erase(connection):
        # Hold account erasure's graph gate while the webhook has already read
        # the still-present request; it must wait before writing payment state.
        lock_connection_graph_users(connection, user_ids=["recipient"])
        erasure_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        erasure_held.set()
        assert release_erasure.wait(20), "erasure barrier was not released"
        erase_drive_account_in_transaction(connection, user_id="recipient", permanent=False)

    original_gate = lock_connection_graph_users

    def observe_webhook_gate(connection, *, user_ids):
        webhook_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        webhook_entered.set()
        original_gate(connection, user_ids=user_ids)

    erase_task = asyncio.create_task(service._transaction(erase))
    webhook_task = None
    try:
        assert await asyncio.to_thread(erasure_held.wait, 10)
        monkeypatch.setattr(
            "hushh_mcp.services.connection_graph_service.lock_connection_graph_users",
            observe_webhook_gate,
        )
        payload, signature = _signed_event(request_id, attempt_id=attempt_id)
        webhook_task = asyncio.create_task(
            service.process_webhook(payload=payload, signature=signature)
        )
        assert await asyncio.to_thread(webhook_entered.wait, 10)
        deadline = asyncio.get_running_loop().time() + 5
        while True:
            with sharing.db.engine.connect() as connection:
                blocked = connection.execute(
                    text("SELECT :holder = ANY(pg_blocking_pids(:waiter))"),
                    {"holder": erasure_pid[0], "waiter": webhook_pid[0]},
                ).scalar_one()
            if blocked:
                break
            assert asyncio.get_running_loop().time() < deadline, "webhook did not wait on erasure"
            await asyncio.sleep(0.01)
    finally:
        release_erasure.set()
        outcomes = await asyncio.wait_for(
            asyncio.gather(
                *([erase_task, webhook_task] if webhook_task else [erase_task]),
                return_exceptions=True,
            ),
            30,
        )
    assert outcomes == [None, None]
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_share_requests WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        obligation = (
            connection.execute(
                text("""SELECT status,paid_at,erased_at,reconciliation_required,payer_ref
              FROM drive_request_payment_obligations WHERE request_id=:request"""),
                {"request": request_id},
            )
            .mappings()
            .one()
        )
        events = connection.execute(
            text(
                "SELECT count(*) FROM drive_request_payment_webhook_events WHERE request_id=:request"
            ),
            {"request": request_id},
        ).scalar_one()
        feed_events = connection.execute(
            text("SELECT count(*) FROM drive_share_events WHERE request_id=:request"),
            {"request": request_id},
        ).scalar_one()
    assert obligation["status"] == "paid"
    assert obligation["paid_at"] is not None and obligation["erased_at"] is not None
    assert obligation["reconciliation_required"] is True
    assert obligation["payer_ref"] == hashlib.sha256(f"{request_id}:recipient".encode()).hexdigest()
    assert events == 1 and feed_events == 0
