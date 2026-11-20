"""Owner payout activity on PostgreSQL.

Running balance, keyset pages, mode and owner isolation, kind filters, since=
updates, receipts without provider IDs, owner-only request labels, the typed
hold/release doorbell and migration 315 replay and rollback.
"""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixture

import base64
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text

from api.middleware import require_vault_owner_token
from api.routes.one import payout_activity as activity_routes
from hushh_mcp.services import external_connector_lifecycle_store as lifecycle_store
from hushh_mcp.services import payout_activity_service as activity_module
from hushh_mcp.services import payout_review, stripe_connect_balances
from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService
from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher
from hushh_mcp.services.hashcoin_wallet_service import HashcoinWalletService
from hushh_mcp.services.payout_activity_service import (
    PayoutActivityError,
    PayoutActivityService,
)
from hushh_mcp.services.payout_request_labels import owner_request_labels
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"
LIVE_ACCOUNT = "acct_1OwnerLiveAccount"
TEST_ACCOUNT = "acct_1OwnerTestAccount"
OTHER_ACCOUNT = "acct_1OtherLiveAccount"
# A provider object ID anywhere in a response is a leak (po_ deposit IDs are public).
PROVIDER_ID = re.compile(r"(?<![A-Za-z0-9])(?:acct|ch|pi|tr|trr)_[A-Za-z0-9]")
LIVE_ENV = {
    "ENVIRONMENT": "uat",
    "HUSHH_DEPLOY_ENV": "uat",
    "STRIPE_MODE": "live",
    "STRIPE_CONNECT_MODE": "live",
    "STRIPE_SECRET_KEY": "sk_live_" + "x" * 30,
    "STRIPE_WEBHOOK_SECRET": "whsec_payment_" + "p" * 25,
    "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect_" + "c" * 25,
    "DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED": "true",
    "DRIVE_REQUEST_HASHCOINS_ENABLED": "true",
    "DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED": "true",
    "DRIVE_SHARING_KEY_V1": base64.urlsafe_b64encode(b"activity-test-key-32-bytes-long!").decode(),
}
_SUPPORT_DDL = (
    "CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY)",
    "INSERT INTO actor_profiles VALUES ('owner'),('other')",
    """CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY,user_id TEXT NOT NULL,
      recipient_user_id TEXT,status TEXT,request_envelope JSONB)""",
    """CREATE TABLE drive_request_payment_orders(request_id UUID PRIMARY KEY,user_id TEXT,
      amount_cents INT,status TEXT,paid_at TIMESTAMPTZ,stripe_mode TEXT,
      reconciliation_required BOOLEAN DEFAULT FALSE,stripe_payment_intent_id TEXT)""",
    """CREATE TABLE drive_request_payment_obligations(request_id UUID PRIMARY KEY,status TEXT,
      stripe_mode TEXT,reconciliation_required BOOLEAN DEFAULT FALSE,
      stripe_payment_intent_id TEXT,erased_at TIMESTAMPTZ,
      delivery_confirmed_at_erasure BOOLEAN DEFAULT FALSE,
      delivery_unsettled_at_erasure BOOLEAN DEFAULT FALSE,
      v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE)""",
    """CREATE TABLE drive_request_payment_refunds(request_id UUID PRIMARY KEY,status TEXT,
      stripe_refund_id TEXT)""",
    "CREATE TABLE drive_bulk_shares(share_id UUID PRIMARY KEY,origin_request_id UUID)",
    """CREATE TABLE stripe_owner_payout_accounts(user_id TEXT NOT NULL,stripe_mode TEXT NOT NULL,
      stripe_account_id TEXT NOT NULL UNIQUE,PRIMARY KEY (user_id,stripe_mode))""",
)
# 316 and 317 belong to other lanes. Their files are applied when filled; these
# contract columns and tables keep this read model testable either way.
_CONNECT_DDL = (
    """ALTER TABLE stripe_connect_bank_payouts
      ADD COLUMN IF NOT EXISTS destination_id TEXT,
      ADD COLUMN IF NOT EXISTS destination_kind TEXT,
      ADD COLUMN IF NOT EXISTS destination_bank_name TEXT,
      ADD COLUMN IF NOT EXISTS destination_last4 TEXT,
      ADD COLUMN IF NOT EXISTS payout_method TEXT,
      ADD COLUMN IF NOT EXISTS automatic BOOLEAN,
      ADD COLUMN IF NOT EXISTS trace_status TEXT,
      ADD COLUMN IF NOT EXISTS trace_value TEXT,
      ADD COLUMN IF NOT EXISTS reconciliation_status TEXT,
      ADD COLUMN IF NOT EXISTS provider_observed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ""",
    """CREATE TABLE IF NOT EXISTS stripe_connect_balance_transactions(
      stripe_balance_transaction_id TEXT PRIMARY KEY,stripe_account_id TEXT NOT NULL,
      livemode BOOLEAN NOT NULL,txn_type TEXT NOT NULL,amount_cents BIGINT NOT NULL,
      fee_cents BIGINT NOT NULL DEFAULT 0,net_cents BIGINT NOT NULL,status TEXT NOT NULL,
      available_on TIMESTAMPTZ,provider_created_at TIMESTAMPTZ,source_id TEXT,
      source_transfer_id TEXT,source_charge_id TEXT,stripe_payout_id TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS stripe_connect_payout_reconciliations(
      stripe_payout_id TEXT PRIMARY KEY,stripe_account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',cursor TEXT,scan_started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
)


def _apply(connection, name):
    connection.exec_driver_sql(
        (MIGRATIONS / name).read_text(), execution_options={"no_parameters": True}
    )


def _filled(name, marker):
    return marker in (MIGRATIONS / name).read_text()


@pytest.fixture
def world(connector_postgres_url, monkeypatch):
    for key, value in LIVE_ENV.items():
        monkeypatch.setenv(key, value)
    schema = "activity_" + uuid4().hex
    admin = create_engine(connector_postgres_url)
    with admin.begin() as c:
        c.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url, connect_args={"options": f"-csearch_path={schema},public"}
    )
    with engine.begin() as c:
        for statement in _SUPPORT_DDL:
            c.exec_driver_sql(statement)
        _apply(c, "292_drive_request_owner_payouts.sql")
        c.exec_driver_sql(
            "ALTER TABLE drive_request_owner_payouts ADD COLUMN stripe_mode TEXT DEFAULT 'legacy'"
        )
        # Compact read-model fixtures include the durable V1 provenance field
        # read by record_order; existing payout histories remain unmarked.
        c.exec_driver_sql(
            "ALTER TABLE drive_request_owner_payouts ADD COLUMN "
            "v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE"
        )
        for name in (
            "299_hashcoin_wallet.sql",
            "303_hashcoin_live_redemption.sql",
            "294_drive_request_bank_payout_events.sql",
        ):
            _apply(c, name)
        if _filled("316_connect_bank_payout_snapshot.sql", "destination_last4"):
            _apply(c, "316_connect_bank_payout_snapshot.sql")
        if _filled("317_connect_balance_ledger.sql", "stripe_connect_balance_transactions"):
            _apply(c, "317_connect_balance_ledger.sql")
        if _filled("319_hashcoin_hold_tracking.sql", "held_at"):
            _apply(c, "319_hashcoin_hold_tracking.sql")
        for statement in _CONNECT_DDL:
            c.exec_driver_sql(statement)
        for _ in range(2):
            _apply(c, "315_payout_activity_indexes.sql")
    db = SimpleNamespace(engine=engine)
    yield SimpleNamespace(
        engine=engine,
        activity=PayoutActivityService(db=db),
        wallet=HashcoinWalletService(db=db),
        payouts=DriveRequestOwnerPayoutService(db=db),
    )
    engine.dispose()
    with admin.begin() as c:
        c.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
    admin.dispose()


def _request(world, owner="owner", *, label="October statements", paid=True, retained=1000):
    """A paid, delivered request whose fee is not resolved yet (pending earning)."""
    request = str(uuid4())
    envelope = DriveSharingCipher().seal(
        {"purpose": {"purpose": label}}, user_id=owner, resource_id=request, purpose="request"
    )
    with world.engine.begin() as c:
        c.execute(
            text("""INSERT INTO drive_share_requests
              (request_id,user_id,recipient_user_id,status,request_envelope,settlement_method)
              VALUES (:id,:owner,'requester','completed',CAST(:envelope AS jsonb),'hashcoins')"""),
            {"id": request, "owner": owner, "envelope": json.dumps(envelope)},
        )
        c.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,amount_cents,status,stripe_mode,settlement_method)
              VALUES (:id,:owner,1000,'awaiting_payment','live','hashcoins')"""),
            {"id": request, "owner": owner},
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
            owner_user_id=owner,
            amount_cents=1000,
            settlement_method="hashcoins",
        )
        if paid:
            c.execute(
                text("""UPDATE drive_request_payment_orders SET status='paid',
                  paid_at=clock_timestamp(),stripe_payment_intent_id=:intent WHERE request_id=:id"""),
                {"id": request, "intent": "pi_" + request},
            )
            c.execute(
                text("""UPDATE drive_request_owner_payouts SET status='awaiting_fee',
                  retained_amount_cents=:retained,refund_amount_cents=1000-:retained,
                  platform_fee_cents=(:retained*300+5000)/10000,expected_files=1,
                  confirmed_files=CASE WHEN :retained=1000 THEN 1 ELSE 0 END,
                  finalized_at=clock_timestamp() WHERE request_id=:id"""),
                {"id": request, "retained": retained},
            )
    return request


def _settle(world, request):
    """Resolve the actual Stripe fee: 1000 gross - 30 Hussh - 59 Stripe = 911 coins."""
    with world.engine.begin() as c:
        assert world.payouts._finish_fee(
            c,
            {"request_id": request},
            {"id": "pi_" + request},
            {"id": "ch_" + request, "amount": 1000},
            {"id": "txn_" + request, "fee": 59},
        )


def _earning(world, owner="owner", **kwargs):
    request = _request(world, owner, **kwargs)
    _settle(world, request)
    return request


async def _cash_out(
    world, owner="owner", coins=911, *, outcome="succeeded", mode="live", account=None
):
    if account is None:
        own = LIVE_ACCOUNT if mode == "live" else TEST_ACCOUNT
        account = own if owner == "owner" else OTHER_ACCOUNT
    record = await world.wallet.reserve_redemption(
        user_id=owner,
        amount_coins=coins,
        request_key=str(uuid4()),
        destination_account_id=account,
        stripe_mode=mode,
    )
    if outcome == "reserved":
        return record
    if outcome == "failed":
        return await world.wallet.finish_redemption(redemption_id=record["id"], outcome="failed")
    claim = await world.wallet.claim_redemption(
        user_id=owner, redemption_id=record["id"], stripe_mode=mode
    )
    return await world.wallet.finish_redemption(
        redemption_id=record["id"],
        outcome="succeeded",
        stripe_transfer_id="tr_" + uuid4().hex,
        attempt_id=claim["attemptId"],
    )


def _reverse(world, request):
    with world.engine.begin() as c:
        assert HashcoinWalletService.reverse_earning(c, request_id=request)


async def _recover(world, redemption_id):
    claim = await world.wallet.claim_live_reversal(redemption_id=redemption_id)
    return await world.wallet.finish_live_reversal(
        redemption_id=redemption_id,
        attempt_id=claim["reversalAttemptId"],
        outcome="reversed",
        stripe_reversal_id="trr_" + uuid4().hex,
    )


def _map_account(world, owner, mode, account):
    with world.engine.begin() as c:
        c.execute(
            text("""INSERT INTO stripe_owner_payout_accounts(user_id,stripe_mode,stripe_account_id)
              VALUES (:owner,:mode,:account)"""),
            {"owner": owner, "mode": mode, "account": account},
        )


_SNAPSHOT = (
    "destination_bank_name",
    "destination_last4",
    "payout_method",
    "automatic",
    "trace_status",
    "trace_value",
)


def _deposit(world, account, *, livemode=True, amount=911, status="paid", created_at=None, **snap):
    assert set(snap) <= {*_SNAPSHOT, "failure_code"}
    payout = "po_" + uuid4().hex[:24]
    rank = {"pending": 0, "in_transit": 1, "paid": 2, "canceled": 3, "failed": 4}[status]
    with world.engine.begin() as c:
        c.execute(
            text("""INSERT INTO stripe_connect_bank_payouts
              (stripe_payout_id,stripe_account_id,livemode,amount_cents,status,status_rank,
               expected_arrival_at,failure_code,created_at,updated_at,destination_bank_name,
               destination_last4,payout_method,automatic,trace_status,trace_value)
              VALUES (:id,:account,:livemode,:amount,:status,:rank,
                clock_timestamp()+interval '2 days',:failure_code,
                COALESCE(CAST(:created AS timestamptz),clock_timestamp()),clock_timestamp(),
                :destination_bank_name,:destination_last4,:payout_method,:automatic,
                :trace_status,:trace_value)"""),
            {
                "id": payout,
                "account": account,
                "livemode": livemode,
                "amount": amount,
                "status": status,
                "rank": rank,
                "created": created_at,
                "failure_code": snap.get("failure_code"),
                **{column: snap.get(column) for column in _SNAPSHOT},
            },
        )
    return payout


async def _everything(world, owner="owner", *, mode="live", kind="all", limit=50):
    items, cursor = [], None
    for _ in range(200):
        page = await world.activity.activity(
            user_id=owner, mode=mode, kind=kind, cursor=cursor, limit=limit
        )
        assert page["sourceItemCount"] == len(page["items"])
        items.extend(page["items"])
        cursor = page["nextCursor"]
        if cursor is None:
            return items, page
    raise AssertionError("pagination did not finish")


@pytest.mark.asyncio
async def test_activity_reports_a_source_row_skipped_before_final_page(world):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    payout_id = _deposit(world, LIVE_ACCOUNT)
    with world.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE stripe_connect_bank_payouts SET stripe_payout_id='po_bad!' "
                "WHERE stripe_payout_id=:id"
            ),
            {"id": payout_id},
        )
    page = await world.activity.activity(user_id="owner", mode="live")
    assert page["items"] == []
    assert page["nextCursor"] is None
    assert page["sourceItemCount"] == 1


@pytest.mark.asyncio
async def test_running_balance_follows_commit_order_and_ends_at_the_wallet_balance(world):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    first, _second, _third = (_earning(world) for _ in range(3))
    sent = await _cash_out(world)  # spends the oldest earning, `first`
    _reverse(world, first)  # the buyer's refund after the cash-out
    await _recover(world, sent["id"])  # Stripe returned the transfer
    pending = await _cash_out(world, outcome="reserved")
    held_request = _earning(world)
    with world.engine.begin() as c:
        c.execute(
            text(
                "UPDATE drive_request_owner_payouts SET status='hashcoins_held' WHERE request_id=:id"
            ),
            {"id": held_request},
        )
    _deposit(world, LIVE_ACCOUNT)

    items, page = await _everything(world, kind="all")
    ledger = sorted(
        (item for item in items if item["balanceAfterCoins"] is not None),
        key=lambda item: item["occurredAt"],
    )
    running = 0
    for item in ledger:
        running += item["coinsDelta"]
        assert item["balanceAfterCoins"] == running, item["id"]
    with world.engine.begin() as c:
        wallet = dict(
            c.execute(
                text("SELECT * FROM hashcoin_wallets WHERE user_id='owner' AND stripe_mode='live'")
            )
            .mappings()
            .one()
        )
        balance = HashcoinWalletService._balance(c, wallet)["balanceCoins"]
    assert running == page["balanceCoins"] == balance == 2733
    assert [item["type"] for item in ledger] == [
        "earning",
        "earning",
        "earning",
        "cash_out",
        "earning_reversed",
        "cash_out_returned",
        "earning",
    ]
    by_id = {item["id"]: item for item in items}
    reserved = by_id["redemption:" + pending["id"]]
    assert (reserved["status"], reserved["coinsDelta"], reserved["balanceAfterCoins"]) == (
        "pending",
        None,
        None,
    )
    assert reserved["amountCents"] == 911
    assert by_id["earning:" + first]["status"] == "reversed"
    assert by_id["earning:" + held_request]["status"] == "held"
    assert by_id["redemption:" + sent["id"]]["reversalStatus"] == "reversed"
    # Items are newest first by occurrence and the list holds every source once.
    assert [item["occurredAt"] for item in items] == sorted(
        (item["occurredAt"] for item in items), reverse=True
    )
    assert len(by_id) == len(items) == 9


@pytest.mark.asyncio
async def test_pages_never_repeat_or_skip_rows_while_new_rows_arrive(world):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    for _ in range(3):
        _earning(world)
    await _cash_out(world)
    pending_request = _request(world)  # paid, fee not resolved yet
    _request(world, paid=False)  # an abandoned checkout is not an earning
    tie = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    tied = {_deposit(world, LIVE_ACCOUNT, created_at=tie) for _ in range(3)}
    before, _ = await _everything(world)
    before_ids = [item["id"] for item in before]
    assert "earning:" + pending_request in before_ids
    assert {"deposit:" + payout for payout in tied} <= set(before_ids)
    assert len(before_ids) == 8

    seen = []
    page = await world.activity.activity(user_id="owner", mode="live", limit=1)
    seen.extend(item["id"] for item in page["items"])
    # New money arrives between page reads: it is newer than every cursor.
    arrived = {"earning:" + _earning(world), "deposit:" + _deposit(world, LIVE_ACCOUNT)}
    for _ in range(50):
        if page["nextCursor"] is None:
            break
        page = await world.activity.activity(
            user_id="owner", mode="live", limit=1, cursor=page["nextCursor"]
        )
        seen.extend(item["id"] for item in page["items"])
    assert len(seen) == len(set(seen)), "a row repeated across pages"
    assert seen == before_ids, "a row was skipped or reordered"
    head = await world.activity.activity(user_id="owner", mode="live", limit=2)
    assert {item["id"] for item in head["items"]} == arrived


@pytest.mark.asyncio
async def test_modes_and_owners_never_mix(world):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    _map_account(world, "owner", "test", TEST_ACCOUNT)
    _map_account(world, "other", "live", OTHER_ACCOUNT)
    earned = _earning(world)
    sandbox = await _cash_out(world, coins=300, mode="test")
    live_deposit = _deposit(world, LIVE_ACCOUNT)
    test_deposit = _deposit(world, TEST_ACCOUNT, livemode=False)
    stray = _deposit(world, LIVE_ACCOUNT, livemode=False)  # wrong mode on a live mapping
    other_earning = _earning(world, "other")
    other_cash_out = await _cash_out(world, "other")
    other_deposit = _deposit(world, OTHER_ACCOUNT)

    live, live_page = await _everything(world, mode="live")
    test, test_page = await _everything(world, mode="test")
    assert {item["id"] for item in live} == {"earning:" + earned, "deposit:" + live_deposit}
    assert {item["id"] for item in test} == {
        "earning:" + earned,  # the sandbox mirror of the same request
        "redemption:" + sandbox["id"],
        "deposit:" + test_deposit,
    }
    assert {item["test"] for item in live} == {False}
    assert {item["test"] for item in test} == {True}
    assert (live_page["balanceCoins"], test_page["balanceCoins"]) == (911, 611)
    leaked = {
        "deposit:" + stray,
        "earning:" + other_earning,
        "redemption:" + other_cash_out["id"],
        "deposit:" + other_deposit,
    }
    assert not leaked & {item["id"] for item in live + test}
    others, _ = await _everything(world, "other")
    assert {item["id"] for item in others} == {
        "earning:" + other_earning,
        "redemption:" + other_cash_out["id"],
        "deposit:" + other_deposit,
    }
    nobody = await world.activity.activity(user_id="nobody", mode="live")
    assert (nobody["items"], nobody["balanceCoins"], nobody["nextCursor"]) == ([], 0, None)


@pytest.mark.asyncio
async def test_kind_filters_partition_the_list_and_coins_excludes_deposits(world):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    reversed_request = _earning(world)
    _earning(world)
    sent = await _cash_out(world)
    _reverse(world, reversed_request)
    await _recover(world, sent["id"])
    _request(world)
    _deposit(world, LIVE_ACCOUNT)
    everything, _ = await _everything(world)
    by_kind = {}
    for item in everything:
        by_kind.setdefault(item["kind"], []).append(item["id"])
    assert set(by_kind) == {"earning", "redemption", "adjustment", "deposit"}
    for kind, ids in by_kind.items():
        filtered, _ = await _everything(world, kind=kind, limit=2)
        assert [item["id"] for item in filtered] == ids, kind
    coins, _ = await _everything(world, kind="coins", limit=3)
    assert [item["id"] for item in coins] == [
        item["id"] for item in everything if item["kind"] != "deposit"
    ]
    page = await world.activity.activity(user_id="owner", mode="live", kind="coins", limit=1)
    with pytest.raises(PayoutActivityError, match="invalid_cursor"):
        await world.activity.activity(
            user_id="owner", mode="live", kind="all", cursor=page["nextCursor"]
        )
    with pytest.raises(PayoutActivityError, match="invalid_cursor"):
        await world.activity.activity(
            user_id="other", mode="live", kind="coins", cursor=page["nextCursor"]
        )


@pytest.mark.asyncio
async def test_since_returns_only_changed_rows_and_resets_past_one_hundred(world, monkeypatch):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    _earning(world)
    pending = await _cash_out(world, outcome="reserved")  # spends the oldest earning
    held = _earning(world)
    _earning(world)
    quiet_deposit = _deposit(world, LIVE_ACCOUNT)
    monkeypatch.setattr(activity_module, "SINCE_OVERLAP", timedelta(0))
    first = await world.activity.activity(user_id="owner", mode="live")
    as_of = datetime.fromisoformat(first["asOf"])

    # After the snapshot: the cash-out is sent, an earning is held, a deposit lands.
    claim = await world.wallet.claim_redemption(
        user_id="owner", redemption_id=pending["id"], stripe_mode="live"
    )
    await world.wallet.finish_redemption(
        redemption_id=pending["id"],
        outcome="succeeded",
        stripe_transfer_id="tr_" + uuid4().hex,
        attempt_id=claim["attemptId"],
    )
    with world.engine.begin() as c:
        world.payouts._finish_coin_source_check(c, held, "dispute_pending")
    new_deposit = _deposit(world, LIVE_ACCOUNT)

    delta = await world.activity.activity(user_id="owner", mode="live", since=as_of)
    by_id = {item["id"]: item for item in delta["items"]}
    assert set(by_id) == {
        "earning:" + held,
        "redemption:" + pending["id"],
        "deposit:" + new_deposit,
    }
    assert (delta["reset"], delta["nextCursor"]) == (False, None)
    with world.engine.begin() as c:
        row = dict(
            c.execute(
                text("SELECT * FROM drive_request_owner_payouts WHERE request_id=:id"),
                {"id": held},
            )
            .mappings()
            .one()
        )
    assert by_id["earning:" + held]["status"] == "held"
    assert by_id["earning:" + held]["review"] == payout_review.review_for_earning(row)
    moved = by_id["redemption:" + pending["id"]]
    assert (moved["status"], moved["coinsDelta"]) == ("succeeded", -911)
    assert moved["balanceAfterCoins"] == delta["balanceCoins"] == 1822
    assert "deposit:" + quiet_deposit not in by_id
    # Only the kinds asked for come back.
    deposits_only = await world.activity.activity(
        user_id="owner", mode="live", kind="deposit", since=as_of
    )
    assert [item["id"] for item in deposits_only["items"]] == ["deposit:" + new_deposit]
    # The test wallet's sandbox mirror of the held earning changed too.
    sandbox = await world.activity.activity(user_id="owner", mode="test", since=as_of)
    assert [item["id"] for item in sandbox["items"]] == ["earning:" + held]

    second = await world.activity.activity(user_id="owner", mode="live")
    for _ in range(101):
        _deposit(world, LIVE_ACCOUNT, amount=100)
    burst = await world.activity.activity(
        user_id="owner", mode="live", since=datetime.fromisoformat(second["asOf"])
    )
    assert (burst["reset"], burst["items"], burst["nextCursor"]) == (True, [], None)
    with pytest.raises(PayoutActivityError, match="invalid_query"):
        await world.activity.activity(
            user_id="owner", mode="live", since=as_of, cursor=first["nextCursor"] or "x"
        )


@pytest.mark.asyncio
async def test_running_balance_breaks_created_at_ties_by_entry_id(world, monkeypatch):
    # Backfilled or imported ledger rows can share created_at; entry_id is the tie-breaker.
    monkeypatch.setattr(activity_module, "SINCE_OVERLAP", timedelta(0))
    real = _earning(world)  # 911 coins
    with world.engine.begin() as c:
        tie = c.execute(
            text("""SELECT created_at FROM hashcoin_ledger_entries
              WHERE source_ref=:id AND entry_kind='earning'"""),
            {"id": real},
        ).scalar_one()
        wallet = HashcoinWalletService.ensure_wallet(c, user_id="owner", stripe_mode="live")
        raw = {}
        for entry_id, at, coins in (
            ("00000000-0000-4000-8000-000000000001", tie - timedelta(hours=1), 100),
            ("00000000-0000-0000-0000-000000000000", tie, 200),  # sorts before the real entry
            ("ffffffff-ffff-4fff-bfff-ffffffffffff", tie, 300),  # sorts after it
        ):
            raw[entry_id] = str(uuid4())
            c.execute(
                text("""INSERT INTO hashcoin_ledger_entries
                  (entry_id,wallet_id,entry_kind,source_ref,amount_coins,created_at)
                  VALUES (:entry,:wallet,'earning',:source,:coins,:at)"""),
                {
                    "entry": entry_id,
                    "wallet": wallet,
                    "source": raw[entry_id],
                    "coins": coins,
                    "at": at,
                },
            )
    early, before, after = ("earning:" + raw[key] for key in raw)
    expected = {early: 100, before: 300, "earning:" + real: 1211, after: 1511}

    items, page = await _everything(world, limit=1)
    assert {item["id"]: item["balanceAfterCoins"] for item in items} == expected
    assert page["balanceCoins"] == 1511
    # since= rows tied with each other, and a changed row tied with older ones.
    delta = await world.activity.activity(
        user_id="owner", mode="live", since=tie - timedelta(minutes=1)
    )
    assert {item["id"]: item["balanceAfterCoins"] for item in delta["items"]} == {
        key: expected[key] for key in (before, "earning:" + real, after)
    }
    mark = datetime.fromisoformat(page["asOf"])
    with world.engine.begin() as c:
        world.payouts._finish_coin_source_check(c, real, "clear")  # touches updated_at only
    touched = await world.activity.activity(user_id="owner", mode="live", since=mark)
    assert [(item["id"], item["balanceAfterCoins"]) for item in touched["items"]] == [
        ("earning:" + real, 1211)
    ]


# Tables every owner shares. The ledger is always read by wallet; in this seed the
# owner holds half of it, so a sequential read of it can be the right plan here.
_SHARED_TABLES = {"drive_request_owner_payouts", "hashcoin_redemptions"}
_SEED_EARNINGS = """
INSERT INTO drive_request_payment_obligations(request_id,status,stripe_mode,stripe_payment_intent_id)
SELECT md5(:wallet || g)::uuid,'paid','live','pi_' || md5(:wallet || g)
FROM generate_series(1,:count) g;
INSERT INTO drive_request_owner_payouts(request_id,gross_amount_cents,status,settlement_method,
  wallet_id,expected_files,confirmed_files,retained_amount_cents,refund_amount_cents,
  platform_fee_cents,actual_processing_fee_cents,allocated_processing_fee_cents,
  owner_earning_cents,finalized_at,stripe_payment_intent_id,stripe_charge_id,credited_at,
  stripe_mode,created_at,updated_at)
SELECT md5(:wallet || g)::uuid,1000,'hashcoins_credited','hashcoins',CAST(:wallet AS uuid),
  1,1,1000,0,30,59,59,911,CAST(:start AS timestamptz)+g*interval '1 minute',
  'pi_' || md5(:wallet || g),'ch_' || md5(:wallet || g),
  CAST(:start AS timestamptz)+g*interval '1 minute','live',
  CAST(:start AS timestamptz)+g*interval '1 minute',CAST(:start AS timestamptz)+g*interval '1 minute'
FROM generate_series(1,:count) g;
INSERT INTO hashcoin_ledger_entries(entry_id,wallet_id,entry_kind,source_ref,amount_coins,created_at)
SELECT gen_random_uuid(),CAST(:wallet AS uuid),'earning',md5(:wallet || g)::uuid,911,
  CAST(:start AS timestamptz)+g*interval '1 minute'
FROM generate_series(1,:count) g;
INSERT INTO hashcoin_redemptions(redemption_id,wallet_id,request_key,amount_coins,stripe_mode,
  destination_account_id,status,stripe_transfer_id,first_dispatch_at,source_request_id,
  source_charge_id,source_payment_intent_id,source_gross_cents,source_refund_cents,
  created_at,updated_at)
SELECT md5('r' || :wallet || g)::uuid,CAST(:wallet AS uuid),gen_random_uuid(),911,'live',
  :account,'succeeded','tr_' || md5('r' || :wallet || g),
  CAST(:start AS timestamptz)+g*interval '1 minute'+interval '30 seconds',
  md5(:wallet || g)::uuid,'ch_' || md5(:wallet || g),'pi_' || md5(:wallet || g),1000,0,
  CAST(:start AS timestamptz)+g*interval '1 minute'+interval '30 seconds',
  CAST(:start AS timestamptz)+g*interval '1 minute'+interval '30 seconds'
FROM generate_series(1,:count/2) g;
INSERT INTO hashcoin_ledger_entries(entry_id,wallet_id,entry_kind,source_ref,amount_coins,created_at)
SELECT gen_random_uuid(),CAST(:wallet AS uuid),'redemption',md5('r' || :wallet || g)::uuid,-911,
  CAST(:start AS timestamptz)+g*interval '1 minute'+interval '30 seconds'
FROM generate_series(1,:count/2) g;
"""


def _seq_scans(node):
    """Relations a JSON plan node, or any node under it, reads with a sequential scan."""
    found = {node["Relation Name"]} if node.get("Node Type") == "Seq Scan" else set()
    for child in node.get("Plans", []):
        found |= _seq_scans(child)
    return found


@pytest.mark.asyncio
async def test_since_reads_what_changed_through_indexes_not_whole_tables(world):
    """since= costs what changed, never every owner's payouts and cash-outs."""
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    start = datetime.now(UTC) - timedelta(days=30)
    with world.engine.begin() as c:
        wallets = [
            HashcoinWalletService.ensure_wallet(c, user_id=owner, stripe_mode="live")
            for owner in ["owner", *(f"other-{n}" for n in range(5))]
        ]
        for wallet, count in zip(wallets, [5000, *([1000] * 5)], strict=True):
            for statement in _SEED_EARNINGS.split(";")[:-1]:
                c.execute(
                    text(statement),
                    {"wallet": wallet, "count": count, "start": start, "account": LIVE_ACCOUNT},
                )
        # Hourly source checks touch two old earnings; a provider check, one old cash-out.
        touched = [
            "earning:" + str(row[0])
            for row in c.execute(
                text("""UPDATE drive_request_owner_payouts SET updated_at=clock_timestamp()
                  WHERE request_id IN (md5(:wallet || 10)::uuid,md5(:wallet || 4990)::uuid)
                  RETURNING request_id"""),
                {"wallet": wallets[0]},
            )
        ]
        touched += [
            "redemption:" + str(row[0])
            for row in c.execute(
                text("""UPDATE hashcoin_redemptions SET updated_at=clock_timestamp()
                  WHERE redemption_id=md5('r' || :wallet || 7)::uuid RETURNING redemption_id"""),
                {"wallet": wallets[0]},
            )
        ]
        reference = dict(
            c.execute(
                text("""SELECT entry_kind || ':' || source_ref::text,
                    SUM(amount_coins) OVER (ORDER BY created_at,entry_id)
                  FROM hashcoin_ledger_entries WHERE wallet_id=:wallet"""),
                {"wallet": wallets[0]},
            ).all()
        )
        c.exec_driver_sql("ANALYZE")
    statements = []

    def capture(_conn, _cursor, statement, parameters, _context, _many):
        statements.append((statement, parameters))

    event.listen(world.engine, "before_cursor_execute", capture)
    try:
        delta = await world.activity.activity(
            user_id="owner", mode="live", limit=50, since=datetime.now(UTC) - timedelta(minutes=5)
        )
    finally:
        event.remove(world.engine, "before_cursor_execute", capture)
    assert len(touched) == 3
    assert {item["id"]: item["balanceAfterCoins"] for item in delta["items"]} == {
        item_id: reference[item_id] for item_id in touched
    }
    assert delta["balanceCoins"] == 911 * 2500

    reads = [(sql, params) for sql, params in statements if sql.lstrip()[:4] in {"SELE", "WITH"}]
    assert len(reads) >= 3
    with world.engine.connect() as c:
        for sql, params in reads:
            plan = c.exec_driver_sql("EXPLAIN (FORMAT JSON) " + sql, params).scalar_one()
            assert not _seq_scans(plan[0]["Plan"]) & _SHARED_TABLES, sql


@pytest.mark.asyncio
async def test_receipts_join_stripe_facts_without_provider_ids_and_stay_owner_scoped(
    world, monkeypatch
):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    _map_account(world, "other", "live", OTHER_ACCOUNT)
    first = _earning(world, label="Tax return 2024")
    _earning(world)
    sent = await _cash_out(world)
    _reverse(world, first)
    await _recover(world, sent["id"])
    other_request = _earning(world, "other", label="Other owner's files")
    # Even a transfer to this owner's own account is never linked to someone else's cash-out.
    other_sent = await _cash_out(world, "other", account=LIVE_ACCOUNT)
    carried = _deposit(
        world,
        LIVE_ACCOUNT,
        destination_bank_name="STRIPE TEST BANK",
        destination_last4="6789",
        payout_method="standard",
        automatic=True,
        trace_status="supported",
        trace_value="TRACE12345",
    )
    failed = _deposit(world, LIVE_ACCOUNT, status="failed", failure_code="account_closed")
    # Another owner's failed deposit can never be opened from this owner's receipt.
    foreign = _deposit(world, OTHER_ACCOUNT, status="failed", failure_code="account_closed")
    with world.engine.begin() as c:
        transfers = dict(
            c.execute(
                text("SELECT redemption_id::text,stripe_transfer_id FROM hashcoin_redemptions")
            ).all()
        )
    available_on = datetime(2026, 10, 14, tzinfo=UTC)
    calls = []

    def funds(connection, *, stripe_account_id, transfer_ids):
        calls.append(("funds", stripe_account_id, tuple(transfer_ids)))
        return {
            transfer_ids[0]: {
                "status": "paid_out",
                "availableOn": available_on.isoformat(),
                "stripePayoutId": carried,
            }
        }

    def contents(connection, *, stripe_account_id, stripe_payout_id):
        calls.append(("contents", stripe_account_id, stripe_payout_id))
        return {
            "status": "complete",
            "items": [
                {"transferId": transfers[sent["id"]], "kind": "cash_out", "amountCents": 911},
                # Another owner's transfer can never be linked or labelled here.
                {"transferId": transfers[other_sent["id"]], "kind": "cash_out", "amountCents": 911},
                {"transferId": None, "kind": "refund", "amountCents": -100},
                {"kind": "returned_deposit", "amountCents": 300, "returnedPayoutId": failed},
                {"kind": "returned_deposit", "amountCents": 200, "returnedPayoutId": foreign},
                {"kind": "returned_deposit", "amountCents": 100, "returnedPayoutId": "po_gone"},
            ],
            "otherCents": 25,
        }

    monkeypatch.setattr(stripe_connect_balances, "funds_for_transfers", funds)
    monkeypatch.setattr(stripe_connect_balances, "payout_contents", contents)

    items, _ = await _everything(world)
    receipts = {
        item["id"]: await world.activity.receipt(user_id="owner", item_id=item["id"])
        for item in items
    }
    assert all(receipts.values())
    blob = json.dumps({"items": items, "receipts": receipts})
    assert not PROVIDER_ID.search(blob), PROVIDER_ID.search(blob)

    cash_out = receipts["redemption:" + sent["id"]]
    assert cash_out["reference"] == "HC-" + sent["id"].replace("-", "")[:8].upper()
    assert (cash_out["status"], cash_out["mode"], cash_out["coins"]) == ("succeeded", "live", 911)
    assert cash_out["transfer"]["status"] == "sent"
    assert all(cash_out["transfer"][key] for key in ("requestedAt", "sentAt", "completedAt"))
    assert cash_out["request"] == {
        "id": first,
        "label": "Tax return 2024",
        "confirmedFiles": 1,
        "expectedFiles": 1,
    }
    assert cash_out["earning"]["grossCents"] == 1000
    assert (cash_out["earning"]["platformFeeCents"], cash_out["earning"]["processingFeeCents"]) == (
        30,
        59,
    )
    assert cash_out["earning"]["netCents"] == 911
    assert cash_out["reversal"]["status"] == "reversed" and cash_out["reversal"]["at"]
    assert cash_out["funds"] == {"status": "paid_out", "availableOn": available_on.isoformat()}
    assert cash_out["bankDeposit"]["id"] == "deposit:" + carried
    assert cash_out["bankDeposit"]["bank"] == {"name": "STRIPE TEST BANK", "last4": "6789"}
    assert cash_out["review"] is None

    earning = receipts["earning:" + first]
    assert earning["status"] == "reversed"
    assert [stage["stage"] for stage in earning["stages"]] == [
        "paid",
        "delivered",
        "credited",
        "reversed",
    ]
    assert earning["cashOut"] == {"itemId": "redemption:" + sent["id"], "status": "succeeded"}
    assert earning["breakdown"]["netCents"] == earning["coins"] == 911

    reversal = receipts["reversal:" + first]
    assert (reversal["type"], reversal["coins"], reversal["relatedItemId"]) == (
        "earning_reversed",
        -911,
        "earning:" + first,
    )
    returned = receipts["redemption_reversal:" + sent["id"]]
    assert (returned["type"], returned["coins"], returned["relatedItemId"]) == (
        "cash_out_returned",
        911,
        "redemption:" + sent["id"],
    )

    deposit = receipts["deposit:" + carried]
    assert (deposit["bank"], deposit["bankReference"]) == (
        {"name": "STRIPE TEST BANK", "last4": "6789"},
        "TRACE12345",
    )
    assert (deposit["method"], deposit["automatic"], deposit["actionRequired"]) == (
        "standard",
        True,
        None,
    )
    assert deposit["contents"] == {
        "status": "complete",
        "items": [
            {
                "itemId": "redemption:" + sent["id"],
                "type": "cash_out",
                "requestLabel": "Tax return 2024",
                "amountCents": 911,
            },
            {"itemId": None, "type": "cash_out", "requestLabel": None, "amountCents": 911},
            {"itemId": None, "type": "refund", "requestLabel": None, "amountCents": -100},
            {
                "itemId": "deposit:" + failed,
                "type": "returned_deposit",
                "requestLabel": None,
                "amountCents": 300,
            },
            {"itemId": None, "type": "returned_deposit", "requestLabel": None, "amountCents": 200},
            {"itemId": None, "type": "returned_deposit", "requestLabel": None, "amountCents": 100},
        ],
        "otherCents": 25,
    }
    assert receipts["deposit:" + failed]["actionRequired"] == "update_bank"
    assert ("funds", LIVE_ACCOUNT, (transfers[sent["id"]],)) in calls

    # Another owner, or an unknown item, reads exactly like "not found".
    for item_id in receipts:
        assert await world.activity.receipt(user_id="other", item_id=item_id) is None
    for item_id in (
        "earning:" + other_request,
        "redemption:" + other_sent["id"],
        "earning:" + str(uuid4()),
        "deposit:po_unknown",
    ):
        assert await world.activity.receipt(user_id="owner", item_id=item_id) is None


@pytest.mark.asyncio
async def test_request_labels_open_only_the_owners_own_requests(world, monkeypatch):
    mine = _request(world, label="  Mortgage   papers  ")
    theirs = _request(world, "other", label="Not yours")
    opened = []
    original = DriveSharingCipher.open

    def spy(self, envelope, *, user_id, resource_id, purpose):
        opened.append(resource_id)
        return original(self, envelope, user_id=user_id, resource_id=resource_id, purpose=purpose)

    monkeypatch.setattr(DriveSharingCipher, "open", spy)
    with world.engine.begin() as c:
        labels = owner_request_labels(c, user_id="owner", request_ids=[mine, theirs, str(uuid4())])
        assert labels == {mine: "Mortgage papers"}
        assert opened == [mine]
        c.execute(
            text(
                "UPDATE drive_share_requests SET request_envelope='{}'::jsonb WHERE request_id=:id"
            ),
            {"id": mine},
        )
        assert owner_request_labels(c, user_id="owner", request_ids=[mine]) == {mine: None}


@pytest.mark.asyncio
async def test_hold_and_release_ring_the_typed_payout_doorbell(world):
    request = _earning(world)
    listener = world.engine.raw_connection()
    try:
        driver = listener.driver_connection
        driver.autocommit = True
        cursor = driver.cursor()
        cursor.execute("LISTEN one_user_state_changed")
        expected = {
            "type": "bank_payout_changed",
            "user_id": "owner",
            "kinds": ["earnings", "wallet"],
            "request_id": request,
        }
        for outcome, rings in (("dispute_pending", 1), ("dispute_pending", 0), ("clear", 1)):
            with world.engine.begin() as c:
                world.payouts._finish_coin_source_check(c, request, outcome)
            cursor.execute("SELECT 1")  # a round trip drains delivered notifications
            payloads = [json.loads(item.payload) for item in driver.notifies]
            driver.notifies.clear()
            assert payloads == [expected] * rings, outcome
    finally:
        listener.close()


@pytest.mark.asyncio
async def test_hold_and_release_commit_when_the_doorbell_refuses_the_owner(world, caplog):
    # Firebase UIDs fit the doorbell's 128 characters; hashcoin_wallets.user_id is unbounded.
    owner = "o" * 129
    request = _earning(world, owner)

    def state():
        with world.engine.begin() as c:
            payout = c.execute(
                text("""SELECT status,safe_error_code FROM drive_request_owner_payouts
                  WHERE request_id=:id"""),
                {"id": request},
            ).one()
            held = c.execute(
                text("""SELECT array_agg(held ORDER BY stripe_mode) FROM hashcoin_wallets
                  WHERE user_id=:owner"""),
                {"owner": owner},
            ).scalar_one()
        return (*payout, held)

    with world.engine.begin() as c:
        world.payouts._finish_coin_source_check(c, request, "dispute_pending")
    # The dispute fence holds the coins although no doorbell could ring.
    assert state() == ("hashcoins_held", "charge_unavailable", [True, True])
    assert "doorbell_skipped" in caplog.text
    with world.engine.begin() as c:
        world.payouts._finish_coin_source_check(c, request, "clear")
    assert state() == ("hashcoins_credited", None, [False, False])


@pytest.mark.asyncio
async def test_activity_routes_serve_real_reads_privately(world, monkeypatch):
    _map_account(world, "owner", "live", LIVE_ACCOUNT)
    _earning(world)
    sent = await _cash_out(world)
    _deposit(world, LIVE_ACCOUNT)
    monkeypatch.setattr(lifecycle_store, "get_db", lambda: SimpleNamespace(engine=world.engine))
    app = FastAPI()
    app.include_router(activity_routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner"}
    client = TestClient(app)
    first = client.get("/api/one/payouts/activity?limit=2&user_id=other")
    assert first.status_code == 200
    assert first.headers["Cache-Control"] == "private, no-store"
    assert [item["kind"] for item in first.json()["items"]] == ["deposit", "redemption"]
    rest = client.get(
        "/api/one/payouts/activity", params={"limit": 2, "cursor": first.json()["nextCursor"]}
    )
    assert rest.status_code == 200 and rest.json()["nextCursor"] is None
    receipt = client.get("/api/one/payouts/activity/redemption:" + sent["id"])
    assert receipt.status_code == 200 and receipt.json()["kind"] == "redemption"
    for response in (first, rest, receipt):
        assert not PROVIDER_ID.search(response.text)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "other"}
    hidden = client.get("/api/one/payouts/activity/redemption:" + sent["id"])
    assert hidden.status_code == 404
    assert hidden.headers["Cache-Control"] == "private, no-store"
    assert client.get("/api/one/payouts/activity").json()["items"] == []


def _index_definitions(connection):
    return dict(
        connection.exec_driver_sql(
            """SELECT indexname,substring(indexdef FROM ' USING .*$') FROM pg_indexes
            WHERE schemaname=current_schema() AND tablename IN
              ('hashcoin_ledger_entries','hashcoin_redemptions','drive_request_owner_payouts')"""
        ).all()
    )


def test_migration_306_replays_without_table_locks_skips_equivalents_and_rolls_back(
    connector_postgres_url,
):
    forward = (MIGRATIONS / "315_payout_activity_indexes.sql").read_text()
    rollback = (MIGRATIONS / "rollback/315_payout_activity_indexes.rollback.sql").read_text()
    created = {
        "hashcoin_ledger_wallet_seq": " USING btree (wallet_id, created_at, entry_id) "
        "INCLUDE (amount_coins, entry_kind, source_ref)",
        "hashcoin_redemptions_wallet_recent": " USING btree (wallet_id, created_at DESC, "
        "redemption_id DESC)",
        "drive_request_owner_payouts_wallet_status": " USING btree (wallet_id, status) "
        "WHERE (wallet_id IS NOT NULL)",
        "hashcoin_redemptions_wallet_changed": " USING btree (wallet_id, updated_at)",
        "drive_request_owner_payouts_wallet_changed": " USING btree (wallet_id, updated_at) "
        "WHERE (wallet_id IS NOT NULL)",
        "drive_request_owner_payouts_sandbox_changed": " USING btree (sandbox_wallet_id, "
        "updated_at) WHERE (sandbox_wallet_id IS NOT NULL)",
    }
    schema = "activity_migration_" + uuid4().hex
    admin = create_engine(connector_postgres_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url,
        isolation_level="AUTOCOMMIT",
        connect_args={"options": f"-csearch_path={schema}"},
    )
    try:
        with engine.connect() as c:
            c.exec_driver_sql("""CREATE TABLE hashcoin_ledger_entries(entry_id UUID PRIMARY KEY,
              wallet_id UUID,entry_kind TEXT,source_ref UUID,amount_coins BIGINT,
              created_at TIMESTAMPTZ DEFAULT clock_timestamp())""")
            c.exec_driver_sql("""CREATE TABLE hashcoin_redemptions(redemption_id UUID PRIMARY KEY,
              wallet_id UUID,created_at TIMESTAMPTZ DEFAULT clock_timestamp(),
              updated_at TIMESTAMPTZ DEFAULT clock_timestamp())""")
            c.exec_driver_sql("""CREATE TABLE drive_request_owner_payouts(
              request_id UUID PRIMARY KEY,wallet_id UUID,sandbox_wallet_id UUID,status TEXT,
              updated_at TIMESTAMPTZ DEFAULT clock_timestamp())""")
            c.exec_driver_sql(
                "INSERT INTO hashcoin_ledger_entries VALUES (gen_random_uuid(),gen_random_uuid(),"
                "'earning',gen_random_uuid(),911,clock_timestamp())"
            )
            c.exec_driver_sql(forward, execution_options={"no_parameters": True})
            assert _index_definitions(c).items() >= created.items()

            # Replay is a catalog check only: it must not wait for a busy writer.
            with engine.connect() as writer:
                writer.exec_driver_sql("BEGIN")
                writer.exec_driver_sql(
                    "LOCK TABLE hashcoin_ledger_entries,hashcoin_redemptions,"
                    "drive_request_owner_payouts IN ROW EXCLUSIVE MODE"
                )
                c.exec_driver_sql("SET lock_timeout='500ms'")
                c.exec_driver_sql(forward, execution_options={"no_parameters": True})
                writer.exec_driver_sql("ROLLBACK")
            assert _index_definitions(c).items() >= created.items()

            for _ in range(2):
                c.exec_driver_sql(rollback, execution_options={"no_parameters": True})
            assert not set(created) & set(_index_definitions(c))
            assert c.exec_driver_sql("SELECT count(*) FROM hashcoin_ledger_entries").scalar() == 1

            # An equivalent index under another name is reused, never duplicated.
            c.exec_driver_sql(
                "CREATE INDEX legacy_ledger_sequence ON hashcoin_ledger_entries"
                "(wallet_id,created_at,entry_id) INCLUDE (amount_coins,entry_kind,source_ref)"
            )
            c.exec_driver_sql(forward, execution_options={"no_parameters": True})
            definitions = _index_definitions(c)
            assert "hashcoin_ledger_wallet_seq" not in definitions
            assert definitions["legacy_ledger_sequence"] == created["hashcoin_ledger_wallet_seq"]
            others = set(created) - {"hashcoin_ledger_wallet_seq"}
            assert {name: definitions[name] for name in others} == {
                name: created[name] for name in others
            }
            c.exec_driver_sql(rollback, execution_options={"no_parameters": True})
            assert "legacy_ledger_sequence" in _index_definitions(c)
    finally:
        engine.dispose()
        with admin.connect() as c:
            c.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()
