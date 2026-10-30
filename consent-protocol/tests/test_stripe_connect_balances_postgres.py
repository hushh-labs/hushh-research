"""Real PostgreSQL proof of the Connect balance snapshot and deposit contents.

A fake Stripe client stands in for every provider read. The money boundaries
proven here: a refresh never stores another mode's data, a failure never
replaces the last good snapshot, deposit contents come only from Stripe's own
reconciliation and never cross connected accounts, and the owner route reads
only the token owner's account.
"""

# ruff: noqa: F811 -- isolated PostgreSQL fixture import
from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
import stripe
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

import api.routes.one.payout_balance as balance_routes
from api.middleware import require_vault_owner_token
from hushh_mcp.services import stripe_connect_balances as balances
from hushh_mcp.services.stripe_connect_balances import (
    ConnectBalanceError,
    StripeConnectBalances,
    enqueue_payout_reconciliation,
    funds_for_transfers,
    mark_balance_refresh_due,
    payout_contents,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"
MIGRATION = "317_connect_balance_ledger.sql"
ROLLBACK = "rollback/317_connect_balance_ledger.rollback.sql"
TEST_KEY = "sk_test_" + "k" * 30
OWNER_WALLET = "00000000-0000-4000-8000-00000000000a"
OTHER_WALLET = "00000000-0000-4000-8000-00000000000b"
CASH_OUT = "00000000-0000-4000-8000-0000000000c1"
FOREIGN_CASH_OUT = "00000000-0000-4000-8000-0000000000c2"
LEGACY_REQUEST = "00000000-0000-4000-8000-0000000000d1"
NOW = int(time.time())

PREREQUISITES = """
CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
INSERT INTO actor_profiles VALUES ('owner'),('other'),('third');
CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY,user_id TEXT,
  recipient_user_id TEXT,status TEXT);
CREATE TABLE drive_request_payment_orders(request_id UUID PRIMARY KEY,user_id TEXT,
  amount_cents INT,status TEXT,paid_at TIMESTAMPTZ,stripe_mode TEXT,
  reconciliation_required BOOLEAN DEFAULT FALSE,stripe_payment_intent_id TEXT);
CREATE TABLE drive_request_payment_obligations(request_id UUID PRIMARY KEY,status TEXT,
  stripe_mode TEXT,reconciliation_required BOOLEAN DEFAULT FALSE,
  stripe_payment_intent_id TEXT,erased_at TIMESTAMPTZ,
  delivery_confirmed_at_erasure BOOLEAN DEFAULT FALSE,
  delivery_unsettled_at_erasure BOOLEAN DEFAULT FALSE);
CREATE TABLE drive_request_payment_refunds(request_id UUID PRIMARY KEY,status TEXT,
  stripe_refund_id TEXT);
CREATE TABLE drive_bulk_shares(share_id UUID PRIMARY KEY,origin_request_id UUID);
"""

# The 298 mapping plus the 304 scan columns, without 298's unrelated rewrites.
ACCOUNTS = """
CREATE TABLE stripe_owner_payout_accounts (
  user_id TEXT NOT NULL,
  stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')),
  stripe_account_id TEXT NOT NULL UNIQUE,
  details_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  account_ready BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  bank_payout_scan_started_at TIMESTAMPTZ,
  bank_payout_scan_cursor TEXT,
  PRIMARY KEY (user_id,stripe_mode));
"""

SEED = f"""
INSERT INTO stripe_owner_payout_accounts(user_id,stripe_mode,stripe_account_id) VALUES
  ('owner','test','acct_owner'),('other','test','acct_other'),('third','test','acct_third'),
  ('owner','live','acct_owner_live');
INSERT INTO hashcoin_wallets(wallet_id,user_id,stripe_mode) VALUES
  ('{OWNER_WALLET}','owner','test'),('{OTHER_WALLET}','other','test');
INSERT INTO hashcoin_redemptions(redemption_id,wallet_id,request_key,amount_coins,
  stripe_mode,destination_account_id,status,stripe_transfer_id) VALUES
  ('{CASH_OUT}','{OWNER_WALLET}',gen_random_uuid(),155,'test','acct_owner',
   'succeeded','tr_cash'),
  ('{FOREIGN_CASH_OUT}','{OTHER_WALLET}',gen_random_uuid(),40,'test','acct_other',
   'succeeded','tr_foreign');
INSERT INTO drive_request_payment_obligations(request_id,status,stripe_mode)
  VALUES ('{LEGACY_REQUEST}','paid','test');
INSERT INTO drive_request_owner_payouts(request_id,gross_amount_cents,status,
  destination_account_id,stripe_transfer_id,transfer_attempt_id,stripe_mode)
  VALUES ('{LEGACY_REQUEST}',1000,'transferred','acct_owner','tr_legacy',
  gen_random_uuid(),'test');
"""


def _execute_file(engine, name: str) -> None:
    with engine.connect() as connection:
        connection = connection.execution_options(isolation_level="AUTOCOMMIT")
        connection.exec_driver_sql(
            (MIGRATIONS / name).read_text(), execution_options={"no_parameters": True}
        )


def _day(offset: int) -> int:
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((today + timedelta(days=offset)).timestamp())


def txn(txn_id, kind, net, *, source=None, status="available", available_on=None, created=None):
    return {
        "id": txn_id,
        "object": "balance_transaction",
        "type": kind,
        "amount": net,
        "fee": 0,
        "net": net,
        "currency": "usd",
        "status": status,
        "available_on": _day(-1) if available_on is None else available_on,
        "created": created or NOW - 3_600,
        "balance_type": "payments",
        "source": source,
    }


def payment(txn_id, transfer, net, *, livemode=False, **kwargs):
    charge = {
        "id": "py_" + txn_id[4:],
        "object": "charge",
        "livemode": livemode,
        "source_transfer": transfer,
    }
    return txn(txn_id, "payment", net, source=charge, **kwargs)


def refund_of(txn_id, payment_txn_id, net, **kwargs):
    refund = {"id": "pyr_" + txn_id[4:], "object": "refund", "charge": "py_" + payment_txn_id[4:]}
    return txn(txn_id, "payment_refund", net, source=refund, **kwargs)


def returned(txn_id, payout_id, net, **kwargs):
    payout = {"id": payout_id, "object": "payout", "livemode": False}
    return txn(txn_id, "payout_failure", net, source=payout, **kwargs)


class FakeConnectStripe:
    """Connected-account Balance and BalanceTransaction reads, per account."""

    def __init__(self) -> None:
        self.livemode = False
        self.balances: dict[str, tuple[int, int]] = {}
        self.history: dict[str, list[dict]] = {}
        self.payouts: dict[str, list[dict]] = {}
        self.calls: list[tuple[str, dict]] = []
        self.error: Exception | None = None
        outer = self

        class Balance:
            @staticmethod
            def retrieve(**kwargs):
                outer.calls.append(("balance", kwargs))
                if outer.error is not None:
                    raise outer.error
                available, pending = outer.balances[kwargs["stripe_account"]]
                return {
                    "object": "balance",
                    "livemode": outer.livemode,
                    "available": [
                        {"amount": available, "currency": "usd"},
                        {"amount": 777, "currency": "eur"},
                    ],
                    "pending": [{"amount": pending, "currency": "usd"}],
                }

        class BalanceTransaction:
            @staticmethod
            def list(**kwargs):
                outer.calls.append(("list", kwargs))
                if outer.error is not None:
                    raise outer.error
                if "payout" in kwargs:
                    rows = outer.payouts.get(kwargs["payout"], [])
                else:
                    rows = outer.history.get(kwargs["stripe_account"], [])
                if "starting_after" in kwargs:
                    ids = [row["id"] for row in rows]
                    rows = rows[ids.index(kwargs["starting_after"]) + 1 :]
                limit = kwargs["limit"]
                return {"object": "list", "data": rows[:limit], "has_more": len(rows) > limit}

        self.Balance, self.BalanceTransaction = Balance, BalanceTransaction

    def provider_calls(self, account: str | None = None) -> list[tuple[str, dict]]:
        return [
            call for call in self.calls if account is None or call[1]["stripe_account"] == account
        ]


@pytest.fixture
def ledger(connector_postgres_url, monkeypatch):
    for name in ("ENVIRONMENT", "HUSHH_DEPLOY_ENV", "HUSSH_DEPLOY_ENV", "STRIPE_CONNECT_MODE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("STRIPE_CONNECT_SECRET_KEY", raising=False)
    monkeypatch.setenv("STRIPE_MODE", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", TEST_KEY)
    notices: list[tuple[str, list[str]]] = []
    original_notify = balances.notify_payout_changed

    def record(connection, user_id, kinds, request_id=None):
        notices.append((user_id, sorted(kinds)))
        original_notify(connection, user_id, kinds, request_id)

    monkeypatch.setattr(balances, "notify_payout_changed", record)
    schema = "connect_balances_" + uuid4().hex
    admin = create_engine(connector_postgres_url)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url, connect_args={"options": f"-csearch_path={schema},public"}
    )
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(PREREQUISITES)
        _execute_file(engine, "292_drive_request_owner_payouts.sql")
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "ALTER TABLE drive_request_owner_payouts ADD COLUMN stripe_mode TEXT DEFAULT 'live'"
            )
        _execute_file(engine, "299_hashcoin_wallet.sql")
        _execute_file(engine, "303_hashcoin_live_redemption.sql")
        _execute_file(engine, "294_drive_request_bank_payout_events.sql")
        with engine.begin() as connection:
            connection.exec_driver_sql(ACCOUNTS)
            # 316 owns these columns; add them here whether or not it has landed.
            connection.exec_driver_sql(
                "ALTER TABLE stripe_connect_bank_payouts "
                "ADD COLUMN IF NOT EXISTS automatic BOOLEAN, "
                "ADD COLUMN IF NOT EXISTS reconciliation_status TEXT"
            )
        _execute_file(engine, MIGRATION)
        _execute_file(engine, MIGRATION)  # every deploy replays it
        with engine.begin() as connection:
            connection.exec_driver_sql(SEED)
        fake = FakeConnectStripe()
        fake.balances = {"acct_owner": (500, 330), "acct_other": (70, 0), "acct_third": (5, 0)}
        service = StripeConnectBalances(db=SimpleNamespace(engine=engine), stripe_api=fake)
        yield SimpleNamespace(engine=engine, fake=fake, service=service, notices=notices)
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


def _rows(engine, sql: str, **params) -> list[dict]:
    with engine.begin() as connection:
        return [dict(row) for row in connection.execute(text(sql), params).mappings()]


def _snapshot(engine, account: str = "acct_owner") -> dict | None:
    rows = _rows(
        engine,
        "SELECT * FROM stripe_connect_balance_snapshots WHERE stripe_account_id=:account",
        account=account,
    )
    return rows[0] if rows else None


def _payout(engine, payout_id, account, amount, *, status="paid", automatic=None, recon=None):
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_connect_bank_payouts
              (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,status,
               status_rank,automatic,reconciliation_status)
              VALUES (:id,:account,FALSE,:amount,'usd',:status,
                CASE :status WHEN 'paid' THEN 2 WHEN 'failed' THEN 4 ELSE 0 END,
                :automatic,:recon)"""),
            {
                "id": payout_id,
                "account": account,
                "amount": amount,
                "status": status,
                "automatic": automatic,
                "recon": recon,
            },
        )


def _indexes(engine) -> set[str]:
    return {
        row["indexname"]
        for row in _rows(
            engine,
            """SELECT indexname FROM pg_indexes
            WHERE schemaname=current_schema() AND tablename='stripe_connect_bank_payouts'""",
        )
    }


def test_migration_308_replays_and_rollback_keeps_balance_evidence(ledger):
    engine = ledger.engine
    _execute_file(engine, MIGRATION)
    assert "stripe_connect_bank_payouts_reconcile_recent" in _indexes(engine)
    # Every deploy replays 317 under a lock timeout: with a deposit write in
    # flight, the replay must not wait on the deposit table.
    with engine.connect() as writer:
        writer.execute(text("UPDATE stripe_connect_bank_payouts SET updated_at=updated_at"))
        with engine.connect() as deploy:
            deploy = deploy.execution_options(isolation_level="AUTOCOMMIT")
            deploy.exec_driver_sql("SET lock_timeout='1s'")
            deploy.exec_driver_sql(
                (MIGRATIONS / MIGRATION).read_text(), execution_options={"no_parameters": True}
            )
            deploy.exec_driver_sql("RESET lock_timeout")
        writer.rollback()
    columns = {
        table: [
            row["column_name"]
            for row in _rows(
                engine,
                """SELECT column_name FROM information_schema.columns
                WHERE table_schema=current_schema() AND table_name=:table
                ORDER BY ordinal_position""",
                table=table,
            )
        ]
        for table in (
            "stripe_connect_balance_snapshots",
            "stripe_connect_balance_transactions",
            "stripe_connect_payout_reconciliations",
        )
    }
    assert columns["stripe_connect_payout_reconciliations"] == [
        "stripe_payout_id",
        "stripe_account_id",
        "status",
        "cursor",
        "scan_started_at",
        "completed_at",
        "updated_at",
    ]
    assert "user_id" not in str(columns)
    for sql in (
        "INSERT INTO stripe_connect_balance_snapshots(stripe_account_id,livemode) VALUES ('ba_x',FALSE)",
        """INSERT INTO stripe_connect_balance_transactions(stripe_balance_transaction_id,
          stripe_account_id,livemode,txn_type,amount_cents,net_cents,status)
          VALUES ('txn_bad','acct_owner',FALSE,'payment',1,1,'settled')""",
        """INSERT INTO stripe_connect_payout_reconciliations(stripe_payout_id,stripe_account_id)
          VALUES ('po_missing','acct_owner')""",
    ):
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(text(sql))
    _payout(engine, "po_kept", "acct_owner", 10)
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO stripe_connect_balance_transactions(stripe_balance_transaction_id,
              stripe_account_id,livemode,txn_type,amount_cents,net_cents,status)
              VALUES ('txn_kept','acct_owner',FALSE,'payment',10,10,'available')""")
        )
        enqueue_payout_reconciliation(
            connection, stripe_payout_id="po_kept", stripe_account_id="acct_owner"
        )
        with pytest.raises(IntegrityError), connection.begin_nested():
            connection.execute(
                text("UPDATE stripe_connect_payout_reconciliations SET cursor='po_kept'")
            )

    def tables() -> set[str]:
        return {
            row["table_name"]
            for row in _rows(
                engine,
                """SELECT table_name FROM information_schema.tables
                WHERE table_schema=current_schema() AND table_name LIKE 'stripe_connect_%'""",
            )
        }

    _execute_file(engine, ROLLBACK)
    assert "stripe_connect_balance_transactions" in tables()  # settlement evidence stays
    assert "stripe_connect_bank_payouts_reconcile_recent" not in _indexes(engine)
    assert {"stripe_connect_balance_snapshots", "stripe_connect_payout_reconciliations"}.isdisjoint(
        tables()
    )
    _execute_file(engine, MIGRATION)  # re-apply after rollback
    with engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM stripe_connect_balance_transactions")
    _execute_file(engine, ROLLBACK)
    _execute_file(engine, ROLLBACK)
    assert {
        "stripe_connect_balance_snapshots",
        "stripe_connect_balance_transactions",
        "stripe_connect_payout_reconciliations",
    }.isdisjoint(tables())
    _execute_file(engine, MIGRATION)
    assert "stripe_connect_balance_snapshots" in tables()
    assert "stripe_connect_bank_payouts_reconcile_recent" in _indexes(engine)


async def test_refresh_computes_available_pending_and_next_available(ledger):
    engine, fake, service = ledger.engine, ledger.fake, ledger.service
    fake.history["acct_owner"] = [
        payment("txn_p3", "tr_x3", 200, status="pending", available_on=_day(3)),
        payment("txn_p2", "tr_x2", 50, status="pending", available_on=_day(2)),
        # The earliest pending date nets negative, so it is not "next available".
        refund_of("txn_r0", "txn_zz", -20, status="pending", available_on=_day(1)),
        payment("txn_p1", "tr_cash", 100, status="pending", available_on=_day(2)),
        payment("txn_old", "tr_old", 70),
        {**payment("txn_eur", "tr_eur", 9), "currency": "eur"},
    ]

    assert await service.refresh_account(account_id="acct_owner") == "changed"

    snapshot = _snapshot(engine)
    assert (snapshot["available_cents"], snapshot["pending_cents"]) == (500, 330)
    assert snapshot["next_available_on"] == datetime.fromtimestamp(_day(2), UTC)
    assert snapshot["next_available_cents"] == 150
    assert snapshot["fetched_at"] is not None and snapshot["refresh_started_at"] is None
    stored = {
        row["stripe_balance_transaction_id"]: row
        for row in _rows(engine, "SELECT * FROM stripe_connect_balance_transactions")
    }
    assert set(stored) == {"txn_p3", "txn_p2", "txn_r0", "txn_p1", "txn_old"}
    assert stored["txn_p1"]["source_transfer_id"] == "tr_cash"
    assert stored["txn_r0"]["source_charge_id"] == "py_zz"
    assert {row["stripe_payout_id"] for row in stored.values()} == {None}
    [balance_call, list_call] = sorted(fake.calls, key=lambda call: call[0])
    for _, options in (balance_call, list_call):
        assert options["stripe_account"] == "acct_owner"
        assert options["api_key"] == TEST_KEY
        assert options["max_network_retries"] == 0
    assert list_call[1]["limit"] == 100
    assert list_call[1]["expand"] == ["data.source"]
    assert abs(list_call[1]["created"]["gte"] - (time.time() - 35 * 86_400)) < 60
    assert ledger.notices == [("owner", ["balance"])]

    # The same provider state is not a change: no doorbell.
    assert await service.refresh_account(account_id="acct_owner") == "unchanged"
    assert ledger.notices == [("owner", ["balance"])]


@pytest.mark.parametrize("mismatch", ["balance", "source"])
async def test_mode_mismatch_is_refused_and_keeps_the_snapshot(ledger, mismatch):
    engine, fake, service = ledger.engine, ledger.fake, ledger.service
    fake.history["acct_owner"] = [payment("txn_p1", "tr_cash", 100)]
    assert await service.refresh_account(account_id="acct_owner") == "changed"
    before = _snapshot(engine)

    fake.balances["acct_owner"] = (999, 999)
    if mismatch == "balance":
        fake.livemode = True  # a live Balance answering the sandbox key
    else:
        fake.history["acct_owner"] = [payment("txn_live", "tr_live", 999, livemode=True)]
    with pytest.raises(ConnectBalanceError, match="provider_mismatch"):
        await service.refresh_account(account_id="acct_owner")

    after = _snapshot(engine)
    assert (after["available_cents"], after["fetched_at"]) == (500, before["fetched_at"])
    assert [
        row["stripe_balance_transaction_id"]
        for row in _rows(
            engine, "SELECT stripe_balance_transaction_id FROM stripe_connect_balance_transactions"
        )
    ] == ["txn_p1"]
    assert ledger.notices == [("owner", ["balance"])]


async def test_provider_failure_keeps_old_snapshot_and_backs_off(ledger):
    engine, fake, service = ledger.engine, ledger.fake, ledger.service
    assert await service.refresh_account(account_id="acct_owner") == "changed"
    before = _snapshot(engine)
    fake.error = stripe.APIConnectionError("private provider detail")

    with pytest.raises(ConnectBalanceError, match="provider_unavailable") as raised:
        await service.refresh_account(account_id="acct_owner")
    assert "private" not in str(raised.value)
    after = _snapshot(engine)
    assert (after["available_cents"], after["fetched_at"]) == (500, before["fetched_at"])
    # Single flight: the held lease backs off a retry without a provider call.
    calls = len(fake.calls)
    fake.error = None
    assert await service.refresh_account(account_id="acct_owner") == "busy"
    assert len(fake.calls) == calls

    # Without a snapshot to serve, a failure frees the lease for the next reader.
    fake.error = stripe.APIConnectionError("private provider detail")
    with pytest.raises(ConnectBalanceError):
        await service.refresh_account(account_id="acct_other")
    fake.error = None
    assert await service.refresh_account(account_id="acct_other") == "changed"
    assert await service.refresh_account(account_id="acct_unmapped") == "busy"
    assert _snapshot(engine, "acct_unmapped") is None


async def test_reconciliation_itemises_deposit_and_resumes_from_its_cursor(ledger):
    engine, fake, service = ledger.engine, ledger.fake, ledger.service
    filler = [txn(f"txn_fill{index:03d}", "adjustment", 1) for index in range(300)]
    items = [
        payment("txn_cash", "tr_cash", 155, created=NOW - 50),
        payment("txn_legacy", "tr_legacy", 800, created=NOW - 40),
        refund_of("txn_refund", "txn_cash", -55, created=NOW - 30),
        returned("txn_back", "po_failed", 300, created=NOW - 20),
        # A transfer whose cash-out belongs to another connected account.
        payment("txn_foreign", "tr_foreign", 40, created=NOW - 10),
    ]
    total = sum(row["net"] for row in filler + items)
    deposit = txn("txn_deposit", "payout", -total, source={"id": "po_new", "object": "payout"})
    fake.payouts["po_new"] = filler[:150] + items + filler[150:] + [deposit]
    _payout(engine, "po_new", "acct_owner", total, automatic=True, recon="completed")
    _payout(engine, "po_failed", "acct_owner", 300, status="failed")
    with engine.begin() as connection:
        queued = enqueue_payout_reconciliation(
            connection, stripe_payout_id="po_new", stripe_account_id="acct_owner"
        )
        again = enqueue_payout_reconciliation(
            connection, stripe_payout_id="po_new", stripe_account_id="acct_owner"
        )
        early = payout_contents(
            connection, stripe_account_id="acct_owner", stripe_payout_id="po_new"
        )
    assert (queued, again) == (True, False)
    assert early == {"status": "pending", "items": [], "otherCents": 0}

    first = await service.run_due(max_refreshes=0, max_reconciliations=1)
    assert first == {"payout_reconciliations_checked": 1}
    pages = [call for _, call in fake.calls if call.get("payout") == "po_new"]
    assert len(pages) == 3 and all(page["limit"] == 100 for page in pages)
    assert all(
        page["expand"] == ["data.source"]
        and page["max_network_retries"] == 0
        and page["stripe_account"] == "acct_owner"
        for page in pages
    )
    [job] = _rows(engine, "SELECT * FROM stripe_connect_payout_reconciliations")
    assert job["status"] == "in_progress" and job["scan_started_at"] is None
    assert job["cursor"] == fake.payouts["po_new"][299]["id"]
    with engine.begin() as connection:
        assert (
            payout_contents(connection, stripe_account_id="acct_owner", stripe_payout_id="po_new")[
                "status"
            ]
            == "pending"
        )
    assert ledger.notices == []

    second = await service.run_due(max_refreshes=0, max_reconciliations=1)
    assert second == {"payout_reconciliations_completed": 1}
    resumed = [call for _, call in fake.calls if call.get("payout") == "po_new"][3:]
    assert [call.get("starting_after") for call in resumed] == [job["cursor"]]
    with engine.begin() as connection:
        contents = payout_contents(
            connection, stripe_account_id="acct_owner", stripe_payout_id="po_new"
        )
    assert contents["status"] == "complete"
    assert contents["items"] == [
        {
            "transferId": "tr_cash",
            "kind": "cash_out",
            "amountCents": 155,
            "redemptionId": CASH_OUT,
            "requestId": None,
            "returnedPayoutId": None,
        },
        {
            "transferId": "tr_legacy",
            "kind": "document_transfer",
            "amountCents": 800,
            "redemptionId": None,
            "requestId": LEGACY_REQUEST,
            "returnedPayoutId": None,
        },
        {
            "transferId": "tr_cash",
            "kind": "refund",
            "amountCents": -55,
            "redemptionId": CASH_OUT,
            "requestId": None,
            "returnedPayoutId": None,
        },
        {
            "transferId": None,
            "kind": "returned_deposit",
            "amountCents": 300,
            "redemptionId": None,
            "requestId": None,
            "returnedPayoutId": "po_failed",
        },
    ]
    # Fees, adjustments and the foreign transfer are never attributed here.
    assert contents["otherCents"] == 300 + 40
    assert sum(item["amountCents"] for item in contents["items"]) + contents["otherCents"] == total
    assert ledger.notices == [("owner", ["bank_payouts"])]
    assert await service.run_due(max_refreshes=0, max_reconciliations=1) == {}


def test_attribution_never_crosses_connected_accounts(ledger):
    engine = ledger.engine
    _payout(engine, "po_new", "acct_owner", 195, automatic=True, recon="completed")
    _payout(engine, "po_unqueued", "acct_owner", 5, automatic=True, recon="completed")
    with engine.begin() as connection:
        for txn_id, transfer, net in (
            ("txn_cash", "tr_cash", 155),
            ("txn_foreign", "tr_foreign", 40),
        ):
            connection.execute(
                text("""INSERT INTO stripe_connect_balance_transactions
                  (stripe_balance_transaction_id,stripe_account_id,livemode,txn_type,
                   amount_cents,net_cents,status,source_id,source_transfer_id,stripe_payout_id,
                   provider_created_at)
                  VALUES (:id,'acct_owner',FALSE,'payment',:net,:net,'available',:source,
                   :transfer,'po_new',clock_timestamp())"""),
                {"id": txn_id, "net": net, "source": "py_" + txn_id, "transfer": transfer},
            )
        connection.execute(
            text("""INSERT INTO stripe_connect_payout_reconciliations
              (stripe_payout_id,stripe_account_id,status) VALUES ('po_new','acct_owner','complete')""")
        )
        owner_view = payout_contents(
            connection, stripe_account_id="acct_owner", stripe_payout_id="po_new"
        )
        other_view = payout_contents(
            connection, stripe_account_id="acct_other", stripe_payout_id="po_new"
        )
        owner_funds = funds_for_transfers(
            connection, stripe_account_id="acct_owner", transfer_ids=["tr_cash", "bogus"]
        )
        other_funds = funds_for_transfers(
            connection, stripe_account_id="acct_other", transfer_ids=["tr_cash", "tr_foreign"]
        )
        # Another account cannot queue (and so itemise) this owner's deposit.
        assert not enqueue_payout_reconciliation(
            connection, stripe_payout_id="po_unqueued", stripe_account_id="acct_other"
        )
        queued = connection.execute(
            text("SELECT stripe_payout_id FROM stripe_connect_payout_reconciliations")
        ).scalars()
        assert sorted(queued) == ["po_new"]
    # tr_foreign's cash-out was sent to acct_other: never an owner cash-out here.
    assert [item["transferId"] for item in owner_view["items"]] == ["tr_cash"]
    assert owner_view["otherCents"] == 40
    assert other_view == {"status": "pending", "items": [], "otherCents": 0}
    assert owner_funds == {
        "tr_cash": {
            "status": "paid_out",
            "stripePayoutId": "po_new",
            "returnedPayoutId": None,
            "availableOn": None,
        }
    }
    assert other_funds == {}


def test_funds_follow_a_returned_deposit_to_the_one_that_resent_it(ledger):
    engine = ledger.engine

    def add(txn_id, kind, net, *, source, transfer=None, payout=None, status="available"):
        with engine.begin() as connection:
            connection.execute(
                text("""INSERT INTO stripe_connect_balance_transactions
                  (stripe_balance_transaction_id,stripe_account_id,livemode,txn_type,
                   amount_cents,net_cents,status,available_on,source_id,source_transfer_id,
                   stripe_payout_id,provider_created_at)
                  VALUES (:id,'acct_owner',FALSE,:kind,:net,:net,:status,
                   '2026-10-14T00:00:00+00:00',:source,:transfer,:payout,clock_timestamp())"""),
                {
                    "id": txn_id,
                    "kind": kind,
                    "net": net,
                    "status": status,
                    "source": source,
                    "transfer": transfer,
                    "payout": payout,
                },
            )

    def funds():
        with engine.begin() as connection:
            return funds_for_transfers(
                connection, stripe_account_id="acct_owner", transfer_ids=["tr_cash", "tr_new"]
            )

    add("txn_cash", "payment", 155, source="py_cash", transfer="tr_cash", payout="po_failed")
    add("txn_new", "payment", 20, source="py_new", transfer="tr_new", status="pending")
    add("txn_back", "payout_failure", 155, source="po_failed", status="pending")
    first = funds()
    assert first["tr_new"] == {
        "status": "pending",
        "stripePayoutId": None,
        "returnedPayoutId": None,
        "availableOn": "2026-10-14T00:00:00+00:00",
    }
    # The deposit failed: the money is back in the balance, never "paid out".
    assert first["tr_cash"] == {
        "status": "pending",
        "stripePayoutId": None,
        "returnedPayoutId": "po_failed",
        "availableOn": "2026-10-14T00:00:00+00:00",
    }
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE stripe_connect_balance_transactions SET stripe_payout_id='po_resent'
              WHERE stripe_balance_transaction_id='txn_back'""")
        )
    assert funds()["tr_cash"] == {
        "status": "paid_out",
        "stripePayoutId": "po_resent",
        "returnedPayoutId": "po_failed",
        "availableOn": "2026-10-14T00:00:00+00:00",
    }


async def test_worker_tick_is_bounded_and_discovers_completed_payouts(ledger):
    engine, fake, service = ledger.engine, ledger.fake, ledger.service
    with engine.begin() as connection:
        for account in ("acct_owner", "acct_other", "acct_third"):
            mark_balance_refresh_due(connection, stripe_account_id=account, livemode=False)
        mark_balance_refresh_due(connection, stripe_account_id="acct_owner", livemode=False)
    _payout(engine, "po_auto", "acct_owner", 5, automatic=True, recon="completed")
    _payout(engine, "po_manual", "acct_other", 7, automatic=False, recon="not_applicable")
    _payout(engine, "po_running", "acct_owner", 9, automatic=True, recon="in_progress")
    fake.payouts["po_auto"] = [txn("txn_auto", "adjustment", 5)]

    outcomes = await service.run_due()

    assert outcomes == {
        "balance_accounts_checked": 2,
        "balance_snapshots_changed": 2,
        "payout_reconciliations_queued": 2,
        "payout_reconciliations_completed": 1,
    }
    assert set(outcomes) <= balances.WORKER_OUTCOMES  # the drain allowlists these
    due = _rows(
        engine,
        """SELECT stripe_account_id FROM stripe_connect_balance_snapshots
        WHERE refresh_due_at IS NOT NULL""",
    )
    assert len(due) == 1
    jobs = {
        row["stripe_payout_id"]: row["status"]
        for row in _rows(engine, "SELECT * FROM stripe_connect_payout_reconciliations")
    }
    assert jobs == {"po_auto": "complete", "po_manual": "not_applicable"}
    with engine.begin() as connection:
        manual = payout_contents(
            connection, stripe_account_id="acct_other", stripe_payout_id="po_manual"
        )
    assert manual == {"status": "not_applicable", "items": [], "otherCents": 0}
    assert ("other", ["bank_payouts"]) in ledger.notices
    with pytest.raises(ValueError, match="invalid connect balance bounds"):
        await service.run_due(max_refreshes=3)


def _index_conditions(plan: dict) -> list[tuple[str, str]]:
    found = [(plan["Index Name"], plan.get("Index Cond", ""))] if "Index Name" in plan else []
    for child in plan.get("Plans", []):
        found += _index_conditions(child)
    return found


def test_discovery_reads_only_recent_deposit_changes_on_its_index(ledger):
    """The per-tick backstop must not re-read every deposit ever made."""
    engine, service = ledger.engine, ledger.service
    _payout(engine, "po_settled_long_ago", "acct_owner", 5, automatic=True, recon="completed")
    _payout(engine, "po_manual_long_ago", "acct_other", 6, automatic=False)
    _payout(engine, "po_read_late", "acct_owner", 7, automatic=True, recon="completed")
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE stripe_connect_bank_payouts
              SET created_at=now()-interval '400 days',updated_at=now()-interval '8 days'
              WHERE stripe_payout_id IN ('po_settled_long_ago','po_manual_long_ago')""")
        )
        # An old deposit whose completion was only just stored is still found.
        connection.execute(
            text("""UPDATE stripe_connect_bank_payouts SET created_at=now()-interval '400 days'
              WHERE stripe_payout_id='po_read_late'""")
        )
    with engine.begin() as connection:
        assert service._discover(connection) == 1
    jobs = _rows(
        engine, "SELECT stripe_payout_id,status FROM stripe_connect_payout_reconciliations"
    )
    assert jobs == [{"stripe_payout_id": "po_read_late", "status": "pending"}]

    # The read is a bounded range on the partial index, never a full pass.
    with engine.connect() as connection:
        connection.exec_driver_sql("SET enable_seqscan=off")
        plan = connection.execute(
            text("EXPLAIN (FORMAT JSON) " + balances._DISCOVER_RECONCILIATIONS),
            {"mode": "test", "livemode": False},
        ).scalar_one()[0]["Plan"]
        connection.rollback()
    conditions = dict(_index_conditions(plan))
    assert "updated_at >=" in conditions.get("stripe_connect_bank_payouts_reconcile_recent", "")


def test_balance_route_is_owner_scoped_cached_and_refreshes_when_stale(ledger, monkeypatch):
    engine, fake, service = ledger.engine, ledger.fake, ledger.service
    monkeypatch.setattr(balance_routes, "_balances", lambda: service)
    fake.history["acct_owner"] = [
        payment("txn_p1", "tr_cash", 120, status="pending", available_on=_day(2))
    ]
    app = FastAPI()
    app.include_router(balance_routes.router)
    client = TestClient(app)
    path = "/api/one/payouts/account/balance"
    # Auth failures are private too: no shared cache may keep a 401 or 403.
    unauthenticated = client.get(path)
    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["Cache-Control"] == "private, no-store"
    assert unauthenticated.headers["WWW-Authenticate"] == "Bearer"

    def forbidden():
        raise HTTPException(status_code=403, detail="Insufficient scope")

    app.dependency_overrides[require_vault_owner_token] = forbidden
    refused = client.get(path)
    assert (refused.status_code, refused.headers.get("Cache-Control")) == (
        403,
        "private, no-store",
    )
    assert fake.calls == []

    def get(owner, query=""):
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": owner}
        response = client.get(path + query)
        assert response.headers["Cache-Control"] == "private, no-store"
        return response

    first = get("owner", "?user_id=other")
    assert first.status_code == 200
    body = first.json()
    assert body == {
        "stripeMode": "test",
        "currency": "USD",
        "accountLinked": True,
        "inStripeCents": 830,
        "availableCents": 500,
        "pendingCents": 330,
        "nextAvailableOn": datetime.fromtimestamp(_day(2), UTC).isoformat(),
        "nextAvailableCents": 120,
        "asOf": body["asOf"],
        "stale": False,
    }
    assert "acct_" not in first.text and "tr_" not in first.text
    calls = len(fake.calls)
    assert get("owner").json() == body  # fresh snapshot: served from cache
    assert len(fake.calls) == calls

    other = get("other").json()
    assert (other["availableCents"], other["accountLinked"]) == (70, True)
    assert {options["stripe_account"] for _, options in fake.calls[calls:]} == {"acct_other"}
    stranger = get("stranger").json()
    assert stranger["accountLinked"] is False and stranger["inStripeCents"] == 0

    # Hourly provider re-checks touch redemption rows; that alone moves no money.
    with engine.begin() as connection:
        connection.execute(text("UPDATE hashcoin_redemptions SET updated_at=clock_timestamp()"))
    calls = len(fake.provider_calls("acct_owner"))
    assert get("owner").json() == body
    assert len(fake.provider_calls("acct_owner")) == calls

    # A cash-out completed after the snapshot makes it stale: refresh inline.
    with engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO hashcoin_ledger_entries
              (entry_id,wallet_id,entry_kind,source_ref,amount_coins)
              VALUES (gen_random_uuid(),:wallet,'redemption',:redemption,-155)"""),
            {"wallet": OWNER_WALLET, "redemption": CASH_OUT},
        )
    fake.balances["acct_owner"] = (450, 330)
    assert get("owner").json()["availableCents"] == 450
    assert len(fake.provider_calls("acct_owner")) == calls + 2

    # An old snapshot with Stripe down is served, marked stale.
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE stripe_connect_balance_snapshots
              SET fetched_at=fetched_at-interval '11 minutes'
              WHERE stripe_account_id='acct_owner'""")
        )
    fake.error = stripe.APIConnectionError("private provider detail")
    stale = get("owner").json()
    assert (stale["availableCents"], stale["stale"]) == (450, True)

    # No snapshot and no provider: the closed 503, never provider text.
    failed = get("third")
    assert failed.status_code == 503
    assert failed.json() == {
        "detail": {
            "code": "BALANCE_UNAVAILABLE",
            "message": "Stripe balance is unavailable. Try again.",
        }
    }


async def test_a_slow_provider_is_cut_at_the_inline_budget(ledger):
    engine, fake, service = ledger.engine, ledger.fake, ledger.service
    assert await service.refresh_account(account_id="acct_owner") == "changed"
    with engine.begin() as connection:
        connection.execute(
            text("""UPDATE stripe_connect_balance_snapshots
              SET fetched_at=fetched_at-interval '11 minutes'""")
        )
    original = fake.Balance.retrieve

    def hung(**kwargs):
        time.sleep(4)
        return original(**kwargs)

    fake.Balance.retrieve = staticmethod(hung)
    fake.balances["acct_owner"] = (1, 1)
    started = time.monotonic()
    served = await service.owner_balance(user_id="owner")
    # The GET never waits on Stripe past its budget; it serves the old figure.
    assert time.monotonic() - started < 3.2
    assert (served["availableCents"], served["stale"]) == (500, True)
