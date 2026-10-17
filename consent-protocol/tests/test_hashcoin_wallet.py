"""Financial regressions execute migrations and wallet locks in PostgreSQL."""

# ruff: noqa: F811 -- isolated PostgreSQL fixture import
import asyncio
import json
from datetime import UTC, datetime
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
            payloads.append(parameters["payload"])

    for _ in range(2):
        HashcoinWalletService._notify(Connection(), {"user_id": "owner"})
    # An erased wallet has no owner to tell.
    HashcoinWalletService._notify(Connection(), {"user_id": None})
    # Identical payloads collapse inside one transaction, so a burst of ledger
    # posts rings once: no random event ID, and only the wallet kind.
    assert payloads == [payloads[0]] * 2
    assert json.loads(payloads[0]) == {
        "type": "bank_payout_changed",
        "user_id": "owner",
        "kinds": ["wallet"],
    }
    assert _is_user_state_event_type(json.loads(payloads[0])["type"])


class _DoorbellSpy:
    """Records owner doorbells queued on a connection, whichever helper rings them."""

    def __init__(self, connection):
        self._connection = connection
        self.owners = []

    def execute(self, statement, *args, **kwargs):
        if "pg_notify('one_user_state_changed'" in str(statement):
            self.owners.append(json.loads(args[0]["payload"])["user_id"])
        return self._connection.execute(statement, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._connection, name)


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
          delivery_unsettled_at_erasure BOOLEAN DEFAULT FALSE,
          v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE)""")
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
        # Mirror migration352's provenance column in this compact wallet-only
        # schema; these historical orders intentionally stay outside V1.
        c.exec_driver_sql(
            "ALTER TABLE drive_request_owner_payouts ADD COLUMN "
            "v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE"
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
            c.exec_driver_sql(
                (MIGRATIONS / "319_hashcoin_hold_tracking.sql").read_text(),
                execution_options={"no_parameters": True},
            )
        # Added last so positional request inserts keep their column order.
        c.exec_driver_sql("ALTER TABLE drive_share_requests ADD COLUMN request_envelope JSONB")
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
    with ledger.db.engine.begin() as c:
        spy = _DoorbellSpy(c)
        service._finish_coin_source_check(spy, first, "dispute_pending")
        service._finish_coin_source_check(spy, second, "dispute_pending")
        service._finish_coin_source_check(spy, first, "clear")
    assert spy.owners == ["owner", "owner", "owner"]
    assert (await ledger.summary(user_id="owner"))["live"]["held"]
    with ledger.db.engine.begin() as c:
        spy = _DoorbellSpy(c)
        service._finish_coin_source_check(spy, second, "clear")
    assert spy.owners == ["owner"]
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


@pytest.mark.parametrize(
    ("payout", "expected"),
    [
        (
            {"status": "hashcoins_held", "safe_error_code": "charge_unavailable"},
            ("payment_disputed", "wait_for_bank"),
        ),
        (
            {"status": "hashcoins_held", "safe_error_code": "provider_mismatch"},
            ("payment_check", "none"),
        ),
        (
            {"status": "hashcoins_held", "safe_error_code": "refund_mismatch"},
            ("refund_check", "none"),
        ),
        # A code that is not a hold reason, or none at all, is a neutral check.
        (
            {"status": "hashcoins_held", "safe_error_code": "provider_unavailable"},
            ("under_review", "none"),
        ),
        ({"status": "hashcoins_held", "safe_error_code": None}, ("under_review", "none")),
        # A manual-review code is an operator fence, never a dispute verdict.
        (
            {"status": "manual_review", "safe_error_code": "charge_unavailable"},
            ("under_review", "none"),
        ),
        ({"status": "hashcoins_credited", "safe_error_code": None}, None),
        ({"status": "hashcoins_reversed", "safe_error_code": "external_debit"}, None),
    ],
)
def test_earning_review_maps_closed_server_codes(payout, expected):
    from hushh_mcp.services.payout_review import review_for_earning

    review = review_for_earning(payout)
    assert (None if review is None else (review["reason"], review["nextStep"])) == expected


@pytest.mark.parametrize(
    ("redemption", "source", "expected"),
    [
        (
            {"status": "succeeded", "provider_review_reason": "transfer_reversed"},
            None,
            ("transfer_reversed", "contact_support"),
        ),
        (
            {"status": "succeeded", "provider_review_reason": "transfer_mismatch"},
            None,
            ("transfer_check", "none"),
        ),
        (
            {"status": "succeeded", "provider_review_reason": "newer_reason"},
            None,
            ("under_review", "none"),
        ),
        ({"status": "succeeded"}, {"status": "hashcoins_reversed"}, ("refund_recovery", "none")),
        ({"status": "unknown"}, {"status": "hashcoins_reversed"}, ("refund_recovery", "none")),
        # Without the source row, a recovery state still proves the refund.
        ({"status": "succeeded", "reversal_status": "due"}, None, ("refund_recovery", "none")),
        (
            {"status": "succeeded", "reversal_status": "manual_review"},
            {"status": "hashcoins_reversed"},
            ("recovery_review", "contact_support"),
        ),
        # Negative controls: recovered, never sent, sandbox, or not refunded.
        (
            {"status": "succeeded", "reversal_status": "reversed"},
            {"status": "hashcoins_reversed"},
            None,
        ),
        ({"status": "failed"}, {"status": "hashcoins_reversed"}, None),
        ({"status": "reserved"}, {"status": "hashcoins_reversed"}, None),
        ({"status": "succeeded", "stripe_mode": "test"}, {"status": "hashcoins_reversed"}, None),
        ({"status": "succeeded"}, {"status": "hashcoins_credited"}, None),
    ],
)
def test_cash_out_review_mirrors_the_wallet_release_predicate(redemption, source, expected):
    from hushh_mcp.services.payout_review import review_for_redemption

    row = {"stripe_mode": "live", "reversal_status": "none", "provider_review_reason": None}
    review = review_for_redemption({**row, **redemption}, source)
    assert (None if review is None else (review["reason"], review["nextStep"])) == expected


def test_wallet_review_names_debt_and_unexplained_holds_only():
    from hushh_mcp.services.payout_review import (
        HOLD_NEXT_STEPS,
        HOLD_REASONS,
        review_for_balance,
    )

    assert review_for_balance(balance_coins=-1, held=True, explained=True) == {
        "reason": "negative_balance",
        "nextStep": "none",
    }
    assert review_for_balance(balance_coins=5, held=True, explained=False) == {
        "reason": "under_review",
        "nextStep": "none",
    }
    assert review_for_balance(balance_coins=5, held=True, explained=True) is None
    assert review_for_balance(balance_coins=0, held=False, explained=False) is None
    # The vocabulary mirrors hushh-webapp/lib/payouts/review-copy.ts.
    copy = (
        Path(__file__).resolve().parents[2] / "hushh-webapp/lib/payouts/review-copy.ts"
    ).read_text()
    for code in HOLD_REASONS + HOLD_NEXT_STEPS:
        assert f'"{code}"' in copy


def _labels(monkeypatch, label="October statements"):
    from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher

    monkeypatch.setattr(
        DriveSharingCipher, "open", lambda self, envelope, **kw: {"purpose": {"purpose": label}}
    )


@pytest.mark.asyncio
async def test_redeemable_total_matches_sequential_cash_outs(ledger, monkeypatch):
    _labels(monkeypatch)
    first = _claim_live_source(ledger, monkeypatch)
    second = _prepare(ledger)
    _settle(ledger, second)
    third = _prepare(ledger, retained=667, refund=333, confirmed=2, expected=3)
    _settle(ledger, third)
    # An unrelated debit leaves 1,500 available: 911 + 588 fit, a second 911 cannot.
    with ledger.db.engine.begin() as c:
        c.execute(
            text("""INSERT INTO hashcoin_ledger_entries
              (entry_id,wallet_id,entry_kind,source_ref,amount_coins)
              SELECT :entry,wallet_id,'reversal',:source,-910 FROM hashcoin_wallets
              WHERE user_id='owner' AND stripe_mode='live'"""),
            {"entry": str(uuid4()), "source": str(uuid4())},
        )
    live = (await ledger.summary(user_id="owner"))["live"]
    assert (live["availableCoins"], live["nextRedeemCoins"]) == (1500, 911)
    assert {
        key: live[key]
        for key in (
            "redeemableCoins",
            "redeemableCount",
            "remainingAfterNextCoins",
            "notRedeemableCoins",
        )
    } == {
        "redeemableCoins": 1499,
        "redeemableCount": 2,
        "remainingAfterNextCoins": 589,
        "notRedeemableCoins": 1,
    }
    assert live["nextRedeemSource"] == {"requestId": first, "label": "October statements"}
    assert live["holds"] == []
    # Owner boundary: another owner's request never lends its ID or label.
    with ledger.db.engine.begin() as c:
        c.execute(
            text("UPDATE drive_share_requests SET user_id='other' WHERE request_id=:id"),
            {"id": first},
        )
    assert (await ledger.summary(user_id="owner"))["live"]["nextRedeemSource"] is None
    with ledger.db.engine.begin() as c:
        c.execute(
            text("UPDATE drive_share_requests SET user_id='owner' WHERE request_id=:id"),
            {"id": first},
        )
    # Cash out exactly as the Redeem button would, until nothing is offered.
    spent = []
    while next_coins := (await ledger.summary(user_id="owner"))["live"]["nextRedeemCoins"]:
        record = await ledger.reserve_redemption(
            user_id="owner",
            amount_coins=next_coins,
            request_key=str(uuid4()),
            destination_account_id="acct_live",
            stripe_mode="live",
        )
        spent.append((record["sourceRequestId"], next_coins))
    assert spent == [(first, 911), (third, 588)]
    final = (await ledger.summary(user_id="owner"))["live"]
    assert (final["redeemableCoins"], final["redeemableCount"]) == (0, 0)
    assert (final["availableCoins"], final["notRedeemableCoins"]) == (1, 1)
    assert final["nextRedeemSource"] is None
    assert final["holds"] == []
    # A debt holds the wallet even before any hold flag is set.
    with ledger.db.engine.begin() as c:
        c.execute(
            text("""INSERT INTO hashcoin_ledger_entries
              (entry_id,wallet_id,entry_kind,source_ref,amount_coins)
              SELECT :entry,wallet_id,'reversal',:source,-1501 FROM hashcoin_wallets
              WHERE user_id='owner' AND stripe_mode='live' AND NOT held"""),
            {"entry": str(uuid4()), "source": str(uuid4())},
        )
    debt = (await ledger.summary(user_id="owner"))["live"]
    assert debt["held"] and (debt["availableCoins"], debt["redeemableCoins"]) == (0, 0)
    assert [(hold["id"], hold["reason"], hold["coins"]) for hold in debt["holds"]] == [
        ("balance", "negative_balance", 1)
    ]


@pytest.mark.asyncio
async def test_summary_reads_redeemable_sources_once_and_not_while_cash_out_is_off(
    ledger, monkeypatch
):
    from sqlalchemy import event

    _labels(monkeypatch)
    first = _claim_live_source(ledger, monkeypatch)
    second = _prepare(ledger)
    _settle(ledger, second)
    source_reads = []

    def record(_connection, _cursor, statement, *_args):
        if "NOT EXISTS (SELECT 1 FROM hashcoin_redemptions r" in statement:
            source_reads.append(statement)

    event.listen(ledger.db.engine, "before_cursor_execute", record)
    try:
        live = (await ledger.summary(user_id="owner"))["live"]
        assert (live["nextRedeemCoins"], live["redeemableCoins"], live["redeemableCount"]) == (
            911,
            1822,
            2,
        )
        assert live["nextRedeemSource"] == {"requestId": first, "label": "October statements"}
        # The next cash-out and the totals come from one scan of the owner's sources.
        assert len(source_reads) == 1
        source_reads.clear()
        monkeypatch.setenv("DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED", "false")
        off = (await ledger.summary(user_id="owner"))["live"]
        assert (off["nextRedeemCoins"], off["redeemableCoins"], off["redeemableCount"]) == (
            0,
            0,
            0,
        )
        assert off["nextRedeemSource"] is None and off["availableCoins"] == 1822
        # Nothing is offered while live cash-out is off, so nothing is scanned.
        assert source_reads == []
    finally:
        event.remove(ledger.db.engine, "before_cursor_execute", record)


@pytest.mark.asyncio
async def test_held_earnings_name_their_reason_and_start(ledger, monkeypatch):
    _labels(monkeypatch)
    disputed, mismatched = _prepare(ledger), _prepare(ledger)
    _settle(ledger, disputed)
    _settle(ledger, mismatched)
    service = DriveRequestOwnerPayoutService(db=ledger.db)
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, disputed, "dispute_pending")
        service._finish_coin_source_check(c, mismatched, "provider_mismatch")
        started = dict(
            c.execute(
                text("""SELECT request_id::text,held_at FROM drive_request_owner_payouts
                  WHERE held_at IS NOT NULL""")
            ).all()
        )
    live = (await ledger.summary(user_id="owner"))["live"]
    assert live["held"] and live["availableCoins"] == 0
    assert live["holds"] == [
        {
            "id": f"earning:{request}",
            "reason": reason,
            "nextStep": next_step,
            "coins": 911,
            "requestId": request,
            "requestLabel": "October statements",
            "since": started[request].isoformat(),
        }
        for request, reason, next_step in [
            (disputed, "payment_disputed", "wait_for_bank"),
            (mismatched, "payment_check", "none"),
        ]
    ]
    assert (live["redeemableCoins"], live["notRedeemableCoins"]) == (0, 0)
    assert live["nextRedeemSource"] is None
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, disputed, "clear")
        assert (
            c.execute(
                text("SELECT held_at FROM drive_request_owner_payouts WHERE request_id=:id"),
                {"id": disputed},
            ).scalar_one()
            is None
        )
    live = (await ledger.summary(user_id="owner"))["live"]
    assert [hold["id"] for hold in live["holds"]] == [f"earning:{mismatched}"]
    # A wallet still held after its last fence lifts reads as a neutral check
    # on what it freezes, never as a refund.
    with ledger.db.engine.begin() as c:
        c.execute(
            text("""UPDATE drive_request_owner_payouts SET status='hashcoins_credited',
              safe_error_code=NULL WHERE request_id=:id"""),
            {"id": mismatched},
        )
    live = (await ledger.summary(user_id="owner"))["live"]
    assert live["held"]
    assert live["holds"] == [
        {
            "id": "balance",
            "reason": "under_review",
            "nextStep": "none",
            "coins": 1822,
            "requestId": None,
            "requestLabel": None,
            "since": None,
        }
    ]


@pytest.mark.asyncio
async def test_refunded_cash_out_holds_until_its_transfer_is_recovered(ledger, monkeypatch):
    request = _claim_live_source(ledger, monkeypatch)
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
        outcome="succeeded",
        stripe_transfer_id="tr_sent",
        attempt_id=claim["attemptId"],
    )
    assert (await ledger.summary(user_id="owner"))["live"]["holds"] == []
    with ledger.db.engine.begin() as c:
        assert ledger.reverse_earning(c, request_id=request)
        refunded_at = c.execute(
            text("""SELECT created_at FROM hashcoin_ledger_entries
              WHERE entry_kind='reversal' AND source_ref=:id"""),
            {"id": request},
        ).scalar_one()

    async def holds():
        return [
            (hold["id"], hold["reason"], hold["nextStep"], hold["coins"])
            for hold in (await ledger.summary(user_id="owner"))["live"]["holds"]
        ]

    cash_out = f"redemption:{record['id']}"
    assert await holds() == [
        ("balance", "negative_balance", "none", 911),
        (cash_out, "refund_recovery", "none", 911),
    ]
    live = (await ledger.summary(user_id="owner"))["live"]
    assert live["holds"][1]["since"] == refunded_at.isoformat()
    assert live["holds"][1]["requestId"] == request
    reversal = await ledger.claim_live_reversal(redemption_id=record["id"])
    await ledger.finish_live_reversal(
        redemption_id=record["id"],
        attempt_id=reversal["reversalAttemptId"],
        outcome="manual_review",
        review_reason="provider_mismatch",
    )
    assert (await holds())[1] == (cash_out, "recovery_review", "contact_support", 911)
    await ledger.record_live_transfer_check(
        redemption_id=record["id"],
        stripe_transfer_id="tr_sent",
        review_reason="transfer_mismatch",
    )
    assert (await holds())[1] == (cash_out, "transfer_check", "none", 911)


def test_hold_tracking_migration_replays_backfills_and_rolls_back(ledger):
    request = _prepare(ledger)
    _settle(ledger, request)
    forward = (MIGRATIONS / "319_hashcoin_hold_tracking.sql").read_text()
    rollback = (MIGRATIONS / "rollback/319_hashcoin_hold_tracking.rollback.sql").read_text()

    def run(sql):
        with ledger.db.engine.connect() as c:
            c.exec_driver_sql(sql, execution_options={"no_parameters": True})

    def installed(c):
        return (
            c.execute(
                text("""SELECT count(*) FROM information_schema.columns
                  WHERE table_schema=current_schema() AND column_name='held_at'
                    AND table_name='drive_request_owner_payouts'""")
            ).scalar_one(),
            c.execute(
                text("""SELECT count(*) FROM pg_trigger WHERE tgname='drive_owner_payout_held_at'
                  AND tgrelid='drive_request_owner_payouts'::regclass""")
            ).scalar_one(),
            c.execute(
                text("SELECT to_regprocedure('stamp_drive_owner_payout_held_at()') IS NOT NULL")
            ).scalar_one(),
        )

    def held_at(c):
        return c.execute(
            text("SELECT held_at FROM drive_request_owner_payouts WHERE request_id=:id"),
            {"id": request},
        ).scalar_one()

    run(rollback)
    held_before = datetime(2026, 10, 1, tzinfo=UTC)
    with ledger.db.engine.begin() as c:
        assert installed(c) == (0, 0, False)
        # Held before the migration existed: backfilled from its last update.
        c.execute(
            text("""UPDATE drive_request_owner_payouts SET status='hashcoins_held',
              safe_error_code='charge_unavailable',updated_at=:at WHERE request_id=:id"""),
            {"id": request, "at": held_before},
        )
    run(forward)
    run(forward)
    with ledger.db.engine.begin() as c:
        assert installed(c) == (1, 1, True)
        assert held_at(c) == held_before
        # A check that keeps the hold keeps its start; leaving clears it.
        c.execute(
            text("""UPDATE drive_request_owner_payouts SET status='hashcoins_held',
              updated_at=clock_timestamp() WHERE request_id=:id"""),
            {"id": request},
        )
        assert held_at(c) == held_before
        c.execute(
            text("""UPDATE drive_request_owner_payouts SET status='hashcoins_credited',
              safe_error_code=NULL WHERE request_id=:id"""),
            {"id": request},
        )
        assert held_at(c) is None
        c.execute(
            text("""UPDATE drive_request_owner_payouts SET status='hashcoins_held',
              safe_error_code='charge_unavailable' WHERE request_id=:id"""),
            {"id": request},
        )
        assert held_at(c) > held_before
    run(rollback)
    run(rollback)
    with ledger.db.engine.begin() as c:
        assert installed(c) == (0, 0, False)
        # Money evidence stays: the held earning and both ledger credits.
        assert (
            c.execute(
                text("SELECT status FROM drive_request_owner_payouts WHERE request_id=:id"),
                {"id": request},
            ).scalar_one()
            == "hashcoins_held"
        )
        assert c.execute(text("SELECT count(*) FROM hashcoin_ledger_entries")).scalar_one() == 2
    run(forward)
    with ledger.db.engine.begin() as c:
        assert installed(c) == (1, 1, True)
