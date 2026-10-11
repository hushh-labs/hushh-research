"""Financial regressions execute migrations and wallet locks in PostgreSQL."""

# ruff: noqa: F811 -- isolated PostgreSQL fixture import
import asyncio
import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services.account_external_connector_erasure import clear_external_connector_data
from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService
from hushh_mcp.services.hashcoin_redemption_service import HashcoinRedemptionService
from hushh_mcp.services.hashcoin_wallet_service import HashcoinError, HashcoinWalletService
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"


def test_wallet_notification_is_sse_feed_reset_doorbell():
    from api.consent_listener import _is_user_state_event_type

    payloads = []

    class Connection:
        def execute(self, _statement, parameters):
            payloads.append(json.loads(parameters["payload"]))

    HashcoinWalletService._notify(Connection(), {"user_id": "owner"})
    assert payloads[0]["type"] == "bank_payout_changed"
    assert payloads[0]["user_id"] == "owner"
    assert _is_user_state_event_type(payloads[0]["type"])


@pytest.fixture
def ledger(connector_postgres_url, monkeypatch):
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_ENABLED", "true")
    schema = "hashcoins_" + uuid4().hex
    admin = create_engine(connector_postgres_url)
    with admin.begin() as c:
        c.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url, connect_args={"options": f"-csearch_path={schema},public"}
    )
    with engine.begin() as c:
        c.exec_driver_sql("CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY)")
        c.exec_driver_sql("INSERT INTO actor_profiles VALUES ('owner'),('other')")
        c.exec_driver_sql(
            "CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY,user_id TEXT,recipient_user_id TEXT,status TEXT)"
        )
        c.exec_driver_sql("""CREATE TABLE drive_request_payment_orders(request_id UUID PRIMARY KEY,
          user_id TEXT,amount_cents INT,status TEXT,paid_at TIMESTAMPTZ,stripe_mode TEXT,
          reconciliation_required BOOLEAN DEFAULT FALSE,stripe_payment_intent_id TEXT)""")
        c.exec_driver_sql("""CREATE TABLE drive_request_payment_obligations(request_id UUID PRIMARY KEY,
          status TEXT,stripe_mode TEXT,reconciliation_required BOOLEAN DEFAULT FALSE,
          stripe_payment_intent_id TEXT,erased_at TIMESTAMPTZ,
          delivery_confirmed_at_erasure BOOLEAN DEFAULT FALSE,
          delivery_unsettled_at_erasure BOOLEAN DEFAULT FALSE)""")
        c.exec_driver_sql(
            "CREATE TABLE drive_request_payment_refunds(request_id UUID PRIMARY KEY,status TEXT,stripe_refund_id TEXT)"
        )
        c.exec_driver_sql(
            "CREATE TABLE drive_bulk_shares(share_id UUID PRIMARY KEY,origin_request_id UUID)"
        )
        c.exec_driver_sql(
            (MIGRATIONS / "292_drive_request_owner_payouts.sql").read_text(),
            execution_options={"no_parameters": True},
        )
        c.exec_driver_sql(
            "ALTER TABLE drive_request_owner_payouts ADD COLUMN stripe_mode TEXT DEFAULT 'live'"
        )
        for _ in range(2):
            c.exec_driver_sql(
                (MIGRATIONS / "299_hashcoin_wallet.sql").read_text(),
                execution_options={"no_parameters": True},
            )
            c.exec_driver_sql(
                (MIGRATIONS / "303_hashcoin_live_redemption.sql").read_text(),
                execution_options={"no_parameters": True},
            )
    yield HashcoinWalletService(db=SimpleNamespace(engine=engine))
    engine.dispose()
    with admin.begin() as c:
        c.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
    admin.dispose()


def _prepare(ledger, *, method="hashcoins", retained=1000, refund=0, confirmed=1, expected=1):
    request = str(uuid4())
    with ledger.db.engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO drive_share_requests VALUES (:id,'owner','requester','completed',:method)"
            ),
            {"id": request, "method": method},
        )
        c.execute(
            text("""INSERT INTO drive_request_payment_orders
          (request_id,user_id,amount_cents,status,stripe_mode,settlement_method)
          VALUES (:id,'owner',1000,'awaiting_payment','live',:method)"""),
            {"id": request, "method": method},
        )
        c.execute(
            text("""INSERT INTO drive_request_payment_obligations
          (request_id,status,stripe_mode,stripe_payment_intent_id)
          VALUES (:id,'paid','live',:intent)"""),
            {"id": request, "intent": "pi_" + request},
        )
        DriveRequestOwnerPayoutService.record_order(
            c,
            request_id=request,
            owner_user_id="owner",
            amount_cents=1000,
            settlement_method=method,
        )
        c.execute(
            text("""UPDATE drive_request_payment_orders SET status='paid',paid_at=now(),
          stripe_payment_intent_id=:intent WHERE request_id=:id"""),
            {"id": request, "intent": "pi_" + request},
        )
        c.execute(
            text("""UPDATE drive_request_owner_payouts SET status='awaiting_fee',
          retained_amount_cents=:retained,refund_amount_cents=:refund,
          platform_fee_cents=(:retained*300+5000)/10000,expected_files=:expected,
          confirmed_files=:confirmed,finalized_at=now() WHERE request_id=:id"""),
            {
                "id": request,
                "retained": retained,
                "refund": refund,
                "confirmed": confirmed,
                "expected": expected,
            },
        )
        if refund:
            c.execute(
                text(
                    "INSERT INTO drive_request_payment_refunds VALUES (:id,'succeeded','re_test',:refund)"
                ),
                {"id": request, "refund": refund},
            )
    return request


def _settle(ledger, request):
    with ledger.db.engine.begin() as c:
        return DriveRequestOwnerPayoutService(db=ledger.db)._finish_fee(
            c,
            {"request_id": request},
            {"id": "pi_" + request},
            {"id": "ch_" + request, "amount": 1000},
            {"id": "txn_" + request, "fee": 59},
        )


@pytest.mark.asyncio
async def test_net_earning_once_partial_refund_and_legacy_isolation(ledger):
    request = _prepare(ledger, retained=667, refund=333, confirmed=2, expected=3)
    assert _settle(ledger, request)
    assert not _settle(ledger, request)
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["balanceCoins"] == snapshot["sandbox"]["balanceCoins"] == 588
    assert snapshot["liveRedemptionEnabled"] is False
    assert snapshot["coinName"] == "Hussh Coins"
    assert (await ledger.summary(user_id="other"))["live"]["balanceCoins"] == 0
    legacy = _prepare(ledger, method="stripe_transfer")
    assert _settle(ledger, legacy)
    assert (await ledger.summary(user_id="owner"))["live"]["balanceCoins"] == 588
    with ledger.db.engine.begin() as c:
        assert (
            c.execute(
                text("SELECT status FROM drive_request_owner_payouts WHERE request_id=:id"),
                {"id": legacy},
            ).scalar_one()
            == "due"
        )
        with pytest.raises(HashcoinError, match="earning_not_settled"):
            ledger.credit_earning(c, request_id=legacy)


@pytest.mark.asyncio
async def test_concurrent_redemption_cannot_double_spend_and_never_debits_live(ledger):
    request = _prepare(ledger)
    _settle(ledger, request)
    results = await asyncio.gather(
        *[
            ledger.reserve_redemption(
                user_id="owner",
                amount_coins=700,
                request_key=str(uuid4()),
                destination_account_id="acct_test",
            )
            for _ in range(2)
        ],
        return_exceptions=True,
    )
    accepted = [r for r in results if isinstance(r, dict)]
    assert len(accepted) == 1
    assert (
        sum(isinstance(r, HashcoinError) and r.code == "insufficient_balance" for r in results) == 1
    )
    record = accepted[0]
    claim = await ledger.claim_redemption(user_id="owner", redemption_id=record["id"])
    assert claim and claim["previousStatus"] == "reserved"
    assert await ledger.claim_redemption(user_id="owner", redemption_id=record["id"]) is None
    for _ in range(2):
        completed = await ledger.finish_redemption(
            redemption_id=record["id"],
            outcome="succeeded",
            stripe_transfer_id="tr_test",
            attempt_id=claim["attemptId"],
        )
        assert completed["status"] == "succeeded"
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["balanceCoins"] == 911
    assert snapshot["sandbox"]["balanceCoins"] == 211
    assert snapshot["sandbox"]["reservedCoins"] == 0
    assert (await ledger.list_redemptions(user_id="owner"))[0]["status"] == "succeeded"
    with pytest.raises(HashcoinError, match="live_redemption_unavailable"):
        await ledger.reserve_redemption(
            user_id="owner",
            amount_coins=1,
            request_key=str(uuid4()),
            destination_account_id="acct_live",
            stripe_mode="live",
        )


@pytest.mark.asyncio
async def test_live_redemption_binds_one_paid_charge_and_debits_live_once(ledger, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_" + "p" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_" + "c" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "live")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED", "true")
    request = _prepare(ledger)
    _settle(ledger, request)
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["nextRedeemCoins"] == 911
    key = str(uuid4())
    record = await ledger.reserve_redemption(
        user_id="owner",
        amount_coins=911,
        request_key=key,
        destination_account_id="acct_live",
        stripe_mode="live",
    )
    assert record["sourceRequestId"] == request
    assert record["sourceChargeId"] == "ch_" + request
    assert record["sourcePaymentIntentId"] == "pi_" + request
    assert (await ledger.summary(user_id="owner"))["live"]["nextRedeemCoins"] == 0
    assert (
        await ledger.reserve_redemption(
            user_id="owner",
            amount_coins=911,
            request_key=key,
            destination_account_id="acct_live",
            stripe_mode="live",
        )
    )["id"] == record["id"]
    claim = await ledger.claim_redemption(
        user_id="owner", redemption_id=record["id"], stripe_mode="live"
    )
    assert claim and claim["createAllowed"]
    for _ in range(2):
        assert (
            await ledger.finish_redemption(
                redemption_id=record["id"],
                outcome="succeeded",
                stripe_transfer_id="tr_live_once",
                attempt_id=claim["attemptId"],
            )
        )["status"] == "succeeded"
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["balanceCoins"] == 0
    assert snapshot["sandbox"]["balanceCoins"] == 911
    with pytest.raises(HashcoinError, match="insufficient_balance"):
        await ledger.reserve_redemption(
            user_id="owner",
            amount_coins=911,
            request_key=str(uuid4()),
            destination_account_id="acct_live",
            stripe_mode="live",
        )
    review_due = await ledger.list_live_completed_for_review()
    assert [item["id"] for item in review_due] == [record["id"]]
    await ledger.record_live_transfer_check(
        redemption_id=record["id"],
        stripe_transfer_id="tr_live_once",
        review_reason="transfer_reversed",
        reversed_coins=911,
    )
    await ledger.record_live_transfer_check(
        redemption_id=record["id"],
        stripe_transfer_id="tr_live_once",
        review_reason="transfer_reversed",
        reversed_coins=911,
    )
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["held"]
    assert snapshot["live"]["balanceCoins"] == 0
    assert await ledger.list_live_completed_for_review() == []
    with ledger.db.engine.begin() as c:
        assert (
            c.execute(
                text("SELECT count(*) FROM hashcoin_ledger_entries WHERE entry_kind='redemption'")
            ).scalar_one()
            == 1
        )
    with pytest.raises(HashcoinError, match="wallet_held"):
        await ledger.reserve_redemption(
            user_id="owner",
            amount_coins=911,
            request_key=str(uuid4()),
            destination_account_id="acct_live",
            stripe_mode="live",
        )
    with ledger.db.engine.begin() as c:
        assert ledger.reverse_earning(c, request_id=request)
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["balanceCoins"] == -911
    assert snapshot["live"]["availableCoins"] == 0
    assert snapshot["live"]["held"]
    assert (await ledger.get_redemption(user_id="owner", request_key=key, stripe_mode="live"))[
        "reversalStatus"
    ] == "due"
    assert [item["id"] for item in await ledger.list_due_live_reversals()] == [record["id"]]
    reversal_claim = await ledger.claim_live_reversal(redemption_id=record["id"])
    assert reversal_claim["reversalStatus"] == "unknown"
    assert (
        await ledger.finish_live_reversal(
            redemption_id=record["id"],
            attempt_id=reversal_claim["reversalAttemptId"],
            outcome="unknown",
            review_reason="provider_unavailable",
        )
    )["reversalStatus"] == "unknown"
    assert (await ledger.summary(user_id="owner"))["live"]["balanceCoins"] == -911
    assert (await ledger.summary(user_id="owner"))["live"]["held"]
    with ledger.db.engine.begin() as c:
        c.execute(
            text("""UPDATE hashcoin_redemptions SET
              reversal_next_check_at=clock_timestamp()-interval '1 second'
              WHERE redemption_id=:id"""),
            {"id": record["id"]},
        )
    reversal_claim = await ledger.claim_live_reversal(redemption_id=record["id"])
    assert reversal_claim["reversalStatus"] == "unknown"
    assert (
        await ledger.finish_live_reversal(
            redemption_id=record["id"],
            attempt_id=reversal_claim["reversalAttemptId"],
            outcome="reversed",
            stripe_reversal_id="trr_refund_once",
        )
    )["reversalStatus"] == "reversed"
    assert await ledger.list_due_live_reversals() == []
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["balanceCoins"] == 0 and not snapshot["live"]["held"]
    provider_reversals = [
        {
            "id": "trr_refund_once",
            "transfer": "tr_live_once",
            "amount": 911,
            "currency": "usd",
        }
    ]

    class Transfers:
        @staticmethod
        def retrieve(transfer_id, **_):
            assert transfer_id == "tr_live_once"
            return {
                "id": transfer_id,
                "livemode": True,
                "amount": 911,
                "amount_reversed": 911,
                "currency": "usd",
                "destination": "acct_live",
                "source_transaction": "ch_" + request,
                "transfer_group": "drive-request-" + request,
                "metadata": {
                    "payment_kind": "hashcoin_live_redemption",
                    "hashcoin_redemption_id": record["id"],
                },
                "reversed": True,
            }

        @staticmethod
        def list_reversals(transfer_id, **_):
            assert transfer_id == "tr_live_once"
            return {"data": provider_reversals, "has_more": False}

    review_service = HashcoinRedemptionService(
        wallet=ledger, stripe_api=SimpleNamespace(Transfer=Transfers)
    )
    with ledger.db.engine.begin() as c:
        c.execute(
            text("""UPDATE hashcoin_redemptions SET
              last_provider_checked_at=clock_timestamp()-interval '2 hours'
              WHERE redemption_id=:id"""),
            {"id": record["id"]},
        )
    assert await review_service._review_completed_live(max_items=1) == 1
    assert not (await ledger.summary(user_id="owner"))["live"]["held"]
    with ledger.db.engine.begin() as c:
        assert not ledger.reverse_earning(c, request_id=request)
    assert not (await ledger.summary(user_id="owner"))["live"]["held"]
    next_request = _prepare(ledger)
    _settle(ledger, next_request)
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["balanceCoins"] == 911
    assert snapshot["live"]["nextRedeemCoins"] == 911
    assert (
        await ledger.reserve_redemption(
            user_id="owner",
            amount_coins=911,
            request_key=str(uuid4()),
            destination_account_id="acct_live",
            stripe_mode="live",
        )
    )["sourceRequestId"] == next_request
    provider_reversals.append(
        {"id": "trr_unexpected", "transfer": "tr_live_once", "amount": 1, "currency": "usd"}
    )
    with ledger.db.engine.begin() as c:
        c.execute(
            text("""UPDATE hashcoin_redemptions SET
              last_provider_checked_at=clock_timestamp()-interval '2 hours'
              WHERE redemption_id=:id"""),
            {"id": record["id"]},
        )
    assert await review_service._review_completed_live(max_items=1) == 1
    assert (await ledger.summary(user_id="owner"))["live"]["held"]
    with ledger.db.engine.begin() as c:
        assert (
            c.execute(
                text("""SELECT count(*) FROM hashcoin_ledger_entries
              WHERE entry_kind='redemption_reversal' AND source_ref=:id"""),
                {"id": record["id"]},
            ).scalar_one()
            == 1
        )


@pytest.mark.asyncio
async def test_erased_owner_live_transfer_can_finish_without_new_dispatch(ledger, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_" + "p" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_" + "c" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "live")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED", "true")
    request = _prepare(ledger)
    _settle(ledger, request)
    record = await ledger.reserve_redemption(
        user_id="owner",
        amount_coins=911,
        request_key=str(uuid4()),
        destination_account_id="acct_live",
        stripe_mode="live",
    )
    claim = await ledger.claim_redemption(
        user_id="owner", redemption_id=record["id"], stripe_mode="live"
    )
    await ledger.finish_redemption(
        redemption_id=record["id"],
        attempt_id=claim["attemptId"],
        outcome="unknown",
    )
    with ledger.db.engine.begin() as c:
        c.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
        c.execute(
            text("""UPDATE hashcoin_redemptions SET updated_at=clock_timestamp()-interval '2 minutes'
              WHERE redemption_id=:id"""),
            {"id": record["id"]},
        )
    due = await ledger.list_reconcilable_redemptions(stripe_mode="live")
    assert len(due) == 1 and due[0]["userId"] is None
    claim = await ledger.claim_redemption(
        user_id=None, redemption_id=record["id"], stripe_mode="live", allow_erased=True
    )
    assert claim is not None and not claim["createAllowed"]
    assert (
        await ledger.finish_redemption(
            redemption_id=record["id"],
            attempt_id=claim["attemptId"],
            outcome="succeeded",
            stripe_transfer_id="tr_accepted_before_erasure",
        )
    )["status"] == "succeeded"
    with ledger.db.engine.begin() as c:
        assert (
            c.execute(
                text(
                    "SELECT COALESCE(sum(amount_coins),0) FROM hashcoin_ledger_entries WHERE wallet_id=:wallet"
                ),
                {
                    "wallet": c.execute(
                        text("SELECT wallet_id FROM hashcoin_redemptions WHERE redemption_id=:id"),
                        {"id": record["id"]},
                    ).scalar_one()
                },
            ).scalar_one()
            == 0
        )


def _claim_live_source(ledger, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_" + "p" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_" + "c" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "live")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED", "true")
    request = _prepare(ledger)
    _settle(ledger, request)
    return request


@pytest.mark.asyncio
async def test_live_dispatch_fence_rejects_transfer_after_owner_erasure(ledger, monkeypatch):
    _claim_live_source(ledger, monkeypatch)
    record = await ledger.reserve_redemption(
        user_id="owner",
        amount_coins=911,
        request_key=str(uuid4()),
        destination_account_id="acct_live",
        stripe_mode="live",
    )
    claim = await ledger.claim_redemption(
        user_id="owner", redemption_id=record["id"], stripe_mode="live"
    )
    with ledger.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
    transfers = []
    result = await ledger.create_live_transfer_fenced(
        redemption=claim, create=lambda: transfers.append("unexpected")
    )
    assert result is None
    assert transfers == []


@pytest.mark.asyncio
async def test_live_dispatch_fence_makes_erasure_wait_for_provider_write(ledger, monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_sharing_retention.erase_drive_account_in_transaction",
        lambda *args, **kwargs: None,
    )
    _claim_live_source(ledger, monkeypatch)
    record = await ledger.reserve_redemption(
        user_id="owner",
        amount_coins=911,
        request_key=str(uuid4()),
        destination_account_id="acct_live",
        stripe_mode="live",
    )
    claim = await ledger.claim_redemption(
        user_id="owner", redemption_id=record["id"], stripe_mode="live"
    )
    entered, release = Event(), Event()

    def provider_write():
        entered.set()
        assert release.wait(3)
        return "tr_accepted_before_erasure"

    def erase_owner():
        with ledger.db.engine.begin() as connection:
            clear_external_connector_data(
                connection,
                "owner",
                {},
                permanent=True,
                lock_graph_users=lambda *args, **kwargs: None,
            )
            connection.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))

    dispatch = asyncio.create_task(
        ledger.create_live_transfer_fenced(redemption=claim, create=provider_write)
    )
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        erasure = asyncio.create_task(asyncio.to_thread(erase_owner))
        await asyncio.sleep(0.15)
        assert not erasure.done()
    finally:
        release.set()
    assert await dispatch == "tr_accepted_before_erasure"
    await erasure
    assert (
        await ledger.finish_redemption(
            redemption_id=record["id"],
            attempt_id=claim["attemptId"],
            outcome="succeeded",
            stripe_transfer_id="tr_accepted_before_erasure",
        )
    )["status"] == "succeeded"
    with ledger.db.engine.begin() as connection:
        assert connection.execute(
            text("SELECT user_id IS NULL AND held FROM hashcoin_wallets WHERE wallet_id=:wallet"),
            {"wallet": claim["walletId"]},
        ).scalar_one()


@pytest.mark.asyncio
async def test_live_source_requires_exact_earning_and_matching_wallet_mode(ledger, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_" + "x" * 30)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_" + "p" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_" + "c" * 25)
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "live")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED", "true")
    request = _prepare(ledger)
    _settle(ledger, request)
    with pytest.raises(HashcoinError, match="live_source_unavailable"):
        await ledger.reserve_redemption(
            user_id="owner",
            amount_coins=900,
            request_key=str(uuid4()),
            destination_account_id="acct_live",
            stripe_mode="live",
        )
    with ledger.db.engine.begin() as c:
        test_wallet = c.execute(
            text("SELECT wallet_id FROM hashcoin_wallets WHERE stripe_mode='test'")
        ).scalar_one()
    with pytest.raises(DBAPIError), ledger.db.engine.begin() as c:
        c.execute(
            text("""INSERT INTO hashcoin_redemptions
                  (redemption_id,wallet_id,request_key,amount_coins,stripe_mode,
                   destination_account_id,source_request_id,source_charge_id,
                   source_payment_intent_id,source_gross_cents,source_refund_cents)
                  VALUES (:id,:wallet,:key,911,'live','acct_live',:request,:charge,:intent,1000,0)"""),
            {
                "id": str(uuid4()),
                "wallet": test_wallet,
                "key": str(uuid4()),
                "request": request,
                "charge": "ch_" + request,
                "intent": "pi_" + request,
            },
        )


@pytest.mark.asyncio
async def test_unknown_redemption_keeps_reservation_rejects_other_owner_and_changed_intent(ledger):
    _settle(ledger, _prepare(ledger))
    key = str(uuid4())
    record = await ledger.reserve_redemption(
        user_id="owner", amount_coins=500, request_key=key, destination_account_id="acct_test"
    )
    assert (
        await ledger.reserve_redemption(
            user_id="owner", amount_coins=500, request_key=key, destination_account_id="acct_test"
        )
    )["id"] == record["id"]
    with pytest.raises(HashcoinError, match="redemption_mismatch"):
        await ledger.reserve_redemption(
            user_id="owner", amount_coins=501, request_key=key, destination_account_id="acct_test"
        )
    assert await ledger.get_redemption(user_id="other", request_key=key) is None
    assert await ledger.claim_redemption(user_id="other", redemption_id=record["id"]) is None
    claim = await ledger.claim_redemption(user_id="owner", redemption_id=record["id"])
    await ledger.finish_redemption(
        redemption_id=record["id"], outcome="unknown", attempt_id=claim["attemptId"]
    )
    assert (await ledger.summary(user_id="owner"))["sandbox"]["reservedCoins"] == 500
    with pytest.raises(HashcoinError, match="redemption_lease_lost"):
        await ledger.finish_redemption(
            redemption_id=record["id"], outcome="failed", attempt_id=str(uuid4())
        )
    retry = await ledger.claim_redemption(user_id="owner", redemption_id=record["id"])
    assert retry["previousStatus"] == "unknown"
    await ledger.finish_redemption(
        redemption_id=record["id"],
        outcome="succeeded",
        stripe_transfer_id="tr_recovered",
        attempt_id=retry["attemptId"],
    )
    assert (await ledger.summary(user_id="owner"))["sandbox"]["balanceCoins"] == 411


@pytest.mark.asyncio
async def test_refund_reversal_once_preserves_debt_and_erasure_liability(ledger):
    request = _prepare(ledger)
    _settle(ledger, request)
    record = await ledger.reserve_redemption(
        user_id="owner",
        amount_coins=700,
        request_key=str(uuid4()),
        destination_account_id="acct_test",
    )
    claim = await ledger.claim_redemption(user_id="owner", redemption_id=record["id"])
    await ledger.finish_redemption(
        redemption_id=record["id"],
        outcome="succeeded",
        stripe_transfer_id="tr_refunded",
        attempt_id=claim["attemptId"],
    )
    with ledger.db.engine.begin() as c:
        assert ledger.reverse_earning(c, request_id=request)
        assert not ledger.reverse_earning(c, request_id=request)
    snapshot = await ledger.summary(user_id="owner")
    assert snapshot["live"]["balanceCoins"] == 0
    assert snapshot["sandbox"]["balanceCoins"] == -700
    assert snapshot["sandbox"]["availableCoins"] == 0 and snapshot["sandbox"]["held"]
    with ledger.db.engine.begin() as c:
        c.execute(text("DELETE FROM actor_profiles WHERE user_id='owner'"))
        assert (
            c.execute(
                text("SELECT count(*) FROM hashcoin_wallets WHERE user_id IS NULL AND held")
            ).scalar_one()
            == 2
        )
        assert c.execute(text("SELECT count(*) FROM hashcoin_ledger_entries")).scalar_one() == 5
    assert (await ledger.summary(user_id="owner"))["live"]["balanceCoins"] == 0


@pytest.mark.asyncio
async def test_refund_cancels_provably_unused_reservation(ledger):
    request = _prepare(ledger)
    _settle(ledger, request)
    record = await ledger.reserve_redemption(
        user_id="owner",
        amount_coins=700,
        request_key=str(uuid4()),
        destination_account_id="acct_test",
    )
    with ledger.db.engine.begin() as c:
        ledger.reverse_earning(c, request_id=request)
    assert await ledger.claim_redemption(user_id="owner", redemption_id=record["id"]) is None
    assert (await ledger.summary(user_id="owner"))["sandbox"]["reservedCoins"] == 0


def test_database_fences_old_workers_ledger_mutation_and_settlement_retagging(ledger):
    request = _prepare(ledger)
    for statement in [
        "UPDATE drive_request_owner_payouts SET status='due' WHERE request_id=:id",
        "UPDATE drive_request_owner_payouts SET stripe_transfer_id='tr_bad' WHERE request_id=:id",
        "UPDATE drive_share_requests SET settlement_method='stripe_transfer' WHERE request_id=:id",
    ]:
        with pytest.raises(DBAPIError), ledger.db.engine.begin() as c:
            c.execute(text(statement), {"id": request})
    _settle(ledger, request)
    with pytest.raises(DBAPIError), ledger.db.engine.begin() as c:
        c.execute(text("DELETE FROM hashcoin_ledger_entries"))
    with ledger.db.engine.connect() as c:
        c.exec_driver_sql(
            (MIGRATIONS / "rollback/299_hashcoin_wallet.rollback.sql").read_text(),
            execution_options={"no_parameters": True},
        )
        assert c.execute(text("SELECT count(*) FROM hashcoin_ledger_entries")).scalar_one() == 2


def test_coin_source_refund_dispute_mode_and_amount_fences():
    source = {
        "stripe_charge_id": "ch_1",
        "stripe_payment_intent_id": "pi_1",
        "gross_amount_cents": 1000,
        "refund_amount_cents": 0,
    }
    charge = {
        "id": "ch_1",
        "payment_intent": "pi_1",
        "amount": 1000,
        "currency": "usd",
        "livemode": True,
        "paid": True,
        "disputed": False,
        "amount_refunded": 0,
    }
    intent = {"id": "pi_1", "livemode": True, "status": "succeeded"}
    outcome = DriveRequestOwnerPayoutService._coin_source_outcome
    assert outcome(source, charge, intent, "sk_live_synthetic") == "clear"
    assert (
        outcome(source, {**charge, "disputed": True}, intent, "sk_live_synthetic")
        == "dispute_pending"
    )
    assert (
        outcome(source, {**charge, "amount_refunded": 1000}, intent, "sk_live_synthetic")
        == "reverse"
    )
    assert (
        outcome(source, {**charge, "amount_refunded": 200}, intent, "sk_live_synthetic")
        == "refund_mismatch"
    )
    assert (
        outcome(source, {**charge, "livemode": False}, intent, "sk_live_synthetic")
        == "provider_mismatch"
    )


@pytest.mark.asyncio
async def test_dispute_won_releases_only_resolved_hold_without_destroying_earnings(
    ledger, monkeypatch
):
    first, second = _prepare(ledger), _prepare(ledger)
    _settle(ledger, first)
    _settle(ledger, second)
    service = DriveRequestOwnerPayoutService(db=ledger.db)
    doorbells = []
    monkeypatch.setattr(
        HashcoinWalletService,
        "_notify",
        staticmethod(lambda _connection, wallet: doorbells.append(wallet["user_id"])),
    )
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, first, "dispute_pending")
        service._finish_coin_source_check(c, second, "dispute_pending")
        service._finish_coin_source_check(c, first, "clear")
    assert doorbells == ["owner", "owner", "owner"]
    assert (await ledger.summary(user_id="owner"))["live"]["held"]
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, second, "clear")
    assert doorbells == ["owner"] * 4
    snapshot = await ledger.summary(user_id="owner")
    assert not snapshot["live"]["held"] and snapshot["live"]["balanceCoins"] == 1822
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, first, "dispute_pending")
        service._finish_coin_source_check(c, first, "reverse")
    snapshot = await ledger.summary(user_id="owner")
    assert not snapshot["live"]["held"] and snapshot["live"]["balanceCoins"] == 911


def test_earning_waits_for_paid_authority_and_exact_refund(ledger):
    request = _prepare(ledger, retained=667, refund=333, confirmed=2, expected=3)
    with ledger.db.engine.begin() as c:
        c.execute(
            text("UPDATE drive_request_payment_refunds SET status='pending' WHERE request_id=:id"),
            {"id": request},
        )
    assert not _settle(ledger, request)
    with ledger.db.engine.begin() as c:
        assert c.execute(text("SELECT count(*) FROM hashcoin_ledger_entries")).scalar_one() == 0
        c.execute(
            text(
                "UPDATE drive_request_payment_refunds SET status='succeeded' WHERE request_id=:id"
            ),
            {"id": request},
        )
        c.execute(
            text(
                "UPDATE drive_request_payment_orders SET reconciliation_required=TRUE WHERE request_id=:id"
            ),
            {"id": request},
        )
    assert not _settle(ledger, request)
    with ledger.db.engine.begin() as c:
        assert c.execute(text("SELECT count(*) FROM hashcoin_ledger_entries")).scalar_one() == 0
        live_wallet = c.execute(
            text("SELECT wallet_id FROM hashcoin_wallets WHERE stripe_mode='live'")
        ).scalar_one()
    with pytest.raises(DBAPIError), ledger.db.engine.begin() as c:
        c.execute(
            text("""INSERT INTO hashcoin_redemptions
          (redemption_id,wallet_id,request_key,amount_coins,stripe_mode,destination_account_id)
          VALUES (:id,:wallet,:key,1,'test','acct_test')"""),
            {"id": str(uuid4()), "wallet": live_wallet, "key": str(uuid4())},
        )


@pytest.mark.asyncio
async def test_dispute_update_never_clears_an_unrelated_manual_source_fence(ledger):
    request = _prepare(ledger)
    _settle(ledger, request)
    service = DriveRequestOwnerPayoutService(db=ledger.db)
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, request, "provider_mismatch")
        service._finish_coin_source_check(c, request, "dispute_pending")
        service._finish_coin_source_check(c, request, "clear")
        assert (
            c.execute(
                text(
                    "SELECT safe_error_code FROM drive_request_owner_payouts WHERE request_id=:id"
                ),
                {"id": request},
            ).scalar_one()
            == "provider_mismatch"
        )
    assert (await ledger.summary(user_id="owner"))["live"]["held"]
