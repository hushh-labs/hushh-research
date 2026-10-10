"""Financial regressions execute migrations and wallet locks in PostgreSQL."""

# ruff: noqa: F811 -- isolated PostgreSQL fixture import
import asyncio
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService
from hushh_mcp.services.hashcoin_wallet_service import HashcoinError, HashcoinWalletService
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"


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
async def test_dispute_won_releases_only_resolved_hold_without_destroying_earnings(ledger):
    first, second = _prepare(ledger), _prepare(ledger)
    _settle(ledger, first)
    _settle(ledger, second)
    service = DriveRequestOwnerPayoutService(db=ledger.db)
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, first, "dispute_pending")
        service._finish_coin_source_check(c, second, "dispute_pending")
        service._finish_coin_source_check(c, first, "clear")
    assert (await ledger.summary(user_id="owner"))["live"]["held"]
    with ledger.db.engine.begin() as c:
        service._finish_coin_source_check(c, second, "clear")
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
