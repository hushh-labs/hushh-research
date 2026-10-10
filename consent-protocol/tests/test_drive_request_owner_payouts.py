"""Financial boundaries for newly enrolled Drive request owner earnings."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixture

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

import hushh_mcp.services.drive_request_owner_payout_service as payout_module
from hushh_mcp.services.drive_request_owner_payout_service import (
    DriveRequestOwnerPayoutService,
    PayoutTransientError,
    _erased_settlement_valid,
    delivery_amounts,
    fee_amounts,
)
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

REQUEST = "bd309adf-d639-4be5-ac20-9dfcb29f05df"


@pytest.mark.asyncio
async def test_earnings_history_paginates_and_never_crosses_owner_boundary(
    connector_postgres_url, monkeypatch
):
    from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher

    engine = create_engine(connector_postgres_url)
    monkeypatch.setattr(
        DriveSharingCipher,
        "open",
        lambda self, envelope, **kw: {"purpose": {"purpose": "October statements"}},
    )
    owner_ids = [str(uuid4()) for _ in range(21)]
    other_id = str(uuid4())
    with engine.begin() as c:
        c.execute(
            text(
                "CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY,user_id TEXT,request_envelope JSONB)"
            )
        )
        c.execute(
            text(
                "CREATE TABLE drive_request_payment_orders(request_id UUID PRIMARY KEY,stripe_payment_intent_id TEXT)"
            )
        )
        c.execute(
            text("""CREATE TABLE drive_request_owner_payouts(
          request_id UUID PRIMARY KEY,status TEXT,gross_amount_cents INT,
          refund_amount_cents INT,platform_fee_cents INT,allocated_processing_fee_cents INT,
          owner_earning_cents INT,reversal_amount_cents INT,created_at TIMESTAMPTZ,
          transferred_at TIMESTAMPTZ,expected_files INT,confirmed_files INT,erased_at TIMESTAMPTZ,
          stripe_mode TEXT DEFAULT 'test')""")
        )
        for i, request_id in enumerate([*owner_ids, other_id]):
            c.execute(
                text("INSERT INTO drive_share_requests VALUES (:id,:owner,'{}')"),
                {"id": request_id, "owner": "other" if request_id == other_id else "owner"},
            )
            c.execute(
                text("INSERT INTO drive_request_payment_orders VALUES (:id,'pi_test')"),
                {"id": request_id},
            )
            c.execute(
                text("""INSERT INTO drive_request_owner_payouts VALUES
              (:id,'transferred',1000,0,30,59,911,NULL,:created,:created,1,1,NULL,'test')"""),
                {
                    "id": request_id,
                    "created": datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=i),
                },
            )
    service = DriveRequestOwnerPayoutService(db=SimpleNamespace(engine=engine), stripe_api=Mock())
    first = await service.owner_history(user_id="owner")
    assert len(first["transactions"]) == 20 and first["nextCursor"] is not None
    assert other_id not in {x["requestId"] for x in first["transactions"]}
    assert first["transactions"][0]["description"] == "October statements"
    assert first["transactions"][0]["netAmountCents"] == 911
    assert not {"stripe_account_id", "stripe_transfer_id", "request_envelope"}.intersection(
        first["transactions"][0]
    )
    second = await service.owner_history(user_id="owner", cursor=first["nextCursor"])
    assert len(second["transactions"]) == 1 and second["nextCursor"] is None
    assert {x["requestId"] for x in first["transactions"] + second["transactions"]} == set(
        owner_ids
    )
    assert (await service.owner_history(user_id="owner", cursor=other_id))["transactions"] == []
    assert (await service.owner_history(user_id="unknown"))["transactions"] == []
    engine.dispose()


def test_readiness_migration_replay_notifications_and_rollback(connector_postgres_url):
    """Execute both directions without touching another test's public schema."""
    migrations = Path(__file__).resolve().parents[1] / "db/migrations"
    forward = (migrations / "297_document_commerce_readiness.sql").read_text()
    rollback = (migrations / "rollback/297_document_commerce_readiness.rollback.sql").read_text()
    database = "payout_readiness_" + uuid4().hex
    admin = create_engine(connector_postgres_url, isolation_level="AUTOCOMMIT")
    engine = None
    listener = None
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
        engine = create_engine(make_url(connector_postgres_url).set(database=database))
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE TABLE pkm_owner_payout_accounts(user_id TEXT PRIMARY KEY,payouts_enabled BOOLEAN)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY,user_id TEXT)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE drive_request_owner_payouts(request_id UUID PRIMARY KEY,status TEXT,owner_earning_cents INT)"
            )
            connection.exec_driver_sql(
                "INSERT INTO pkm_owner_payout_accounts VALUES ('owner',TRUE)"
            )
            connection.execute(
                text("INSERT INTO drive_share_requests VALUES (:id,'owner')"), {"id": REQUEST}
            )
            connection.execute(
                text("INSERT INTO drive_request_owner_payouts VALUES (:id,'due',911)"),
                {"id": REQUEST},
            )
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            connection.exec_driver_sql(forward, execution_options={"no_parameters": True})
            assert (
                connection.exec_driver_sql(
                    "SELECT account_ready FROM pkm_owner_payout_accounts WHERE user_id='owner'"
                ).scalar_one()
                is False
            )
            connection.exec_driver_sql("UPDATE pkm_owner_payout_accounts SET account_ready=TRUE")
            connection.exec_driver_sql(forward, execution_options={"no_parameters": True})
            assert (
                connection.exec_driver_sql(
                    "SELECT account_ready FROM pkm_owner_payout_accounts WHERE user_id='owner'"
                ).scalar_one()
                is True
            )
            assert (
                connection.exec_driver_sql(
                    "SELECT count(*) FROM pg_trigger WHERE tgname='drive_owner_earning_feed_wake'"
                ).scalar_one()
                == 1
            )
            assert (
                connection.exec_driver_sql(
                    "SELECT prosecdef FROM pg_proc WHERE oid='public.notify_document_owner_earning_changed()'::regprocedure"
                ).scalar_one()
                is True
            )
            assert (
                connection.exec_driver_sql(
                    """SELECT count(*) FROM pg_proc,
                  LATERAL aclexplode(coalesce(proacl,acldefault('f',proowner))) acl
                  WHERE oid='public.notify_document_owner_earning_changed()'::regprocedure
                    AND acl.grantee=0 AND acl.privilege_type='EXECUTE'"""
                ).scalar_one()
                == 0
            )

        listener = engine.raw_connection()
        driver = listener.driver_connection
        driver.autocommit = True
        cursor = driver.cursor()
        cursor.execute("LISTEN one_user_state_changed")
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_request_owner_payouts SET status='transferred' WHERE request_id=:id"
                ),
                {"id": REQUEST},
            )
        # A round trip drains notifications without timing-dependent sleeps.
        cursor.execute("SELECT 1")
        assert len(driver.notifies) == 1
        assert json.loads(driver.notifies.pop().payload) == {
            "type": "bank_payout_changed",
            "user_id": "owner",
        }
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_request_owner_payouts SET status='transferred',owner_earning_cents=911 WHERE request_id=:id"
                ),
                {"id": REQUEST},
            )
        cursor.execute("SELECT 1")
        assert driver.notifies == []
        listener.close()
        listener = None

        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            connection.exec_driver_sql(rollback)
            connection.exec_driver_sql(rollback)
            assert (
                connection.exec_driver_sql(
                    "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='pkm_owner_payout_accounts' AND column_name='account_ready'"
                ).scalar_one()
                == 0
            )
            assert (
                connection.exec_driver_sql(
                    "SELECT to_regprocedure('public.notify_document_owner_earning_changed()')"
                ).scalar_one()
                is None
            )
            assert connection.exec_driver_sql(
                "SELECT status,owner_earning_cents FROM drive_request_owner_payouts"
            ).one() == ("transferred", 911)
            connection.exec_driver_sql(forward, execution_options={"no_parameters": True})
            assert (
                connection.exec_driver_sql(
                    "SELECT account_ready FROM pkm_owner_payout_accounts WHERE user_id='owner'"
                ).scalar_one()
                is False
            )
    finally:
        if listener is not None:
            listener.close()
        if engine is not None:
            engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        admin.dispose()


def test_owner_payout_schema_and_rollback_are_in_release_lanes():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "db/release_migration_manifest.json").read_text())
    name = "292_drive_request_owner_payouts.sql"
    assert name in manifest["ordered_migrations"]
    assert (root / "db/migrations" / name).is_file()
    assert (root / "db/migrations" / manifest["rollback_migrations"][name]).is_file()
    readiness = "297_document_commerce_readiness.sql"
    assert readiness in manifest["ordered_migrations"]
    assert (root / "db/migrations" / manifest["rollback_migrations"][readiness]).is_file()
    for lane in ("dev_minimum_schema", "uat_integrated_schema", "prod_core_schema"):
        contract = json.loads((root / f"db/contracts/{lane}.json").read_text())
        assert "eligible_at_erasure" in contract["required_tables"]["drive_request_owner_payouts"]
        assert "account_ready" in contract["required_tables"]["pkm_owner_payout_accounts"]
        assert "notify_document_owner_earning_changed" in contract["required_functions"]


@pytest.mark.parametrize(
    "flag,enabled",
    [("true", True), ("TRUE", True), ("1", False), ("yes", False), ("on", False), ("", False)],
)
def test_payout_enrollment_flag_uses_exact_true(monkeypatch, flag, enabled):
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", flag)
    assert payout_module.payout_enabled() is enabled


@pytest.mark.asyncio
async def test_flag_off_does_not_block_existing_due_earnings(monkeypatch):
    monkeypatch.delenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", raising=False)
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    connection = Mock()
    connection.execute.return_value.all.return_value = []

    async def transaction(operation):
        return operation(connection)

    service._transaction = transaction
    assert (await service.transfer_due(max_orders=1))["claimed"] == 0
    assert connection.execute.call_args.args[1]["allow_new"] is True


def test_partial_refund_and_actual_stripe_fee_are_distinct_from_commission():
    assert delivery_amounts(gross_cents=1000, confirmed=1, expected=1)["platform_fee_cents"] == 30
    assert (
        fee_amounts(
            gross_cents=1000,
            retained_cents=1000,
            platform_fee_cents=30,
            actual_processing_fee_cents=59,
        )["owner_earning_cents"]
        == 911
    )
    amounts = delivery_amounts(gross_cents=1000, confirmed=2, expected=3)
    assert amounts == {
        "retained_amount_cents": 667,
        "refund_amount_cents": 333,
        "platform_fee_cents": 20,
    }
    assert fee_amounts(
        gross_cents=1000,
        retained_cents=667,
        platform_fee_cents=20,
        actual_processing_fee_cents=59,
    ) == {
        "actual_processing_fee_cents": 59,
        "allocated_processing_fee_cents": 59,
        "owner_earning_cents": 588,
    }
    assert (
        fee_amounts(
            gross_cents=1000,
            retained_cents=10,
            platform_fee_cents=0,
            actual_processing_fee_cents=59,
        )["owner_earning_cents"]
        == 0
    )


def test_paid_legacy_order_cannot_be_enrolled(monkeypatch):
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "true")
    order = {
        "user_id": "owner",
        "amount_cents": 1000,
        "status": "paid",
        "paid_at": datetime.now(UTC),
    }
    connection = Mock()
    connection.execute.return_value.mappings.return_value.first.return_value = order
    with pytest.raises(ValueError, match="payout_order_not_new"):
        DriveRequestOwnerPayoutService.record_order(
            connection, request_id=REQUEST, owner_user_id="owner", amount_cents=1000
        )
    assert connection.execute.call_count == 1


def _claim() -> dict:
    return {
        "request_id": REQUEST,
        "first_dispatch_at": datetime.now(UTC) - timedelta(minutes=5),
        "owner_earning_cents": 911,
        "gross_amount_cents": 1000,
        "refund_amount_cents": 0,
        "stripe_charge_id": "ch_123",
        "stripe_payment_intent_id": "pi_123",
        "stripe_balance_transaction_id": "txn_123",
        "destination_account_id": "acct_123",
        "create_allowed": True,
    }


def _transfer(**overrides) -> dict:
    return {
        "id": "tr_123",
        "amount": 911,
        "currency": "usd",
        "destination": "acct_123",
        "source_transaction": "ch_123",
        "transfer_group": f"drive-request-{REQUEST}",
        "livemode": False,
        "reversed": False,
        "amount_reversed": 0,
        **overrides,
    }


def _erased_earning(**overrides) -> tuple[dict, dict]:
    now = datetime.now(UTC)
    payout = {
        "stripe_mode": "test",
        "request_id": REQUEST,
        "status": "due",
        "erased_at": now,
        "eligible_at_erasure": True,
        "finalized_at": now,
        "expected_files": 3,
        "confirmed_files": 2,
        "gross_amount_cents": 1000,
        "retained_amount_cents": 667,
        "refund_amount_cents": 333,
        "platform_fee_cents": 20,
        "owner_earning_cents": 588,
        "stripe_payment_intent_id": "pi_123",
        "stripe_charge_id": "ch_123",
        "stripe_balance_transaction_id": "txn_123",
        "destination_account_id": "acct_123",
        "transfer_attempt_id": None,
        **overrides,
    }
    obligation = {
        "status": "paid",
        "erased_at": now,
        "reconciliation_required": False,
        "delivery_confirmed_at_erasure": True,
        "delivery_unsettled_at_erasure": False,
        "stripe_payment_intent_id": "pi_123",
    }
    return payout, obligation


def test_erased_earning_requires_finalized_known_delivery_and_paid_source():
    payout, obligation = _erased_earning()
    assert _erased_settlement_valid(payout, obligation)
    for change in (
        {"eligible_at_erasure": False},
        {"finalized_at": None},
        {"confirmed_files": 0},
        {"stripe_payment_intent_id": "pi_other"},
    ):
        assert not _erased_settlement_valid({**payout, **change}, obligation)
    for change in (
        {"status": "refunded"},
        {"reconciliation_required": True},
        {"delivery_unsettled_at_erasure": True},
        {"erased_at": None},
    ):
        assert not _erased_settlement_valid(payout, {**obligation, **change})


def test_erased_partial_earning_claims_from_opaque_ledger_after_exact_refund():
    payout, obligation = _erased_earning()
    refund = {"status": "succeeded", "amount_cents": 333}
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    updated = {**payout, "status": "dispatching", "transfer_attempt_id": "attempt"}
    service._row = Mock(side_effect=[None, None, obligation, refund, payout, updated])
    claim = service._claim_transfer(Mock(), REQUEST)
    assert claim is not None
    assert claim["create_allowed"] is True
    assert claim["force_manual_review"] is False
    assert claim["destination_account_id"] == "acct_123"
    assert service._row.call_count == 6  # no erased owner-account lookup


def test_erased_earning_holds_unknown_delivery_or_unverified_partial_refund():
    payout, obligation = _erased_earning()
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    service._row = Mock(
        side_effect=[
            None,
            None,
            {**obligation, "delivery_unsettled_at_erasure": True},
            {"status": "succeeded", "amount_cents": 333},
            payout,
        ]
    )
    assert service._claim_transfer(Mock(), REQUEST) is None
    service._row = Mock(
        side_effect=[
            None,
            None,
            obligation,
            {"status": "pending", "amount_cents": 333},
            payout,
        ]
    )
    assert service._claim_transfer(Mock(), REQUEST) is None


def test_erased_fee_resolution_uses_verified_opaque_source_and_actual_fee():
    payout, obligation = _erased_earning(status="awaiting_fee", owner_earning_cents=None)
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    service._row = Mock(
        side_effect=[
            None,
            obligation,
            {"status": "succeeded", "amount_cents": 333},
            payout,
        ]
    )
    connection = Mock()
    assert service._finish_fee(
        connection,
        {"request_id": REQUEST},
        {"id": "pi_123"},
        {"id": "ch_123", "amount": 1000},
        {"id": "txn_123", "fee": 59},
    )
    params = connection.execute.call_args.args[1]
    assert (params["status"], params["earning"], params["allocated"]) == ("due", 588, 59)


def test_erased_delivery_waits_for_exact_refund_then_advances_to_fee():
    payout, obligation = _erased_earning(status="awaiting_refund")
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    connection = Mock()
    service._row = Mock(
        side_effect=[
            None,
            None,
            obligation,
            {"status": "pending", "amount_cents": 333},
            payout,
        ]
    )
    assert service._advance_delivery(connection, REQUEST) == "held"
    connection.execute.assert_called_once()  # only the share lock; no state advance

    service._row = Mock(
        side_effect=[
            None,
            None,
            obligation,
            {"status": "succeeded", "amount_cents": 333},
            payout,
        ]
    )
    assert service._advance_delivery(connection, REQUEST) == "awaiting_fee"
    assert connection.execute.call_args.args[1]["status"] == "awaiting_fee"


def test_erased_transfer_still_checks_account_intent_and_partial_charge():
    payout, _ = _erased_earning()
    claim = {
        **_claim(),
        **payout,
        "create_allowed": True,
        "first_dispatch_at": datetime.now(UTC) - timedelta(minutes=1),
    }
    api = SimpleNamespace(
        Account=SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "acct_123",
                    "country": "US",
                    "details_submitted": True,
                    "payouts_enabled": True,
                    "capabilities": {"transfers": "active"},
                    "external_accounts": {
                        "data": [
                            {
                                "object": "bank_account",
                                "country": "US",
                                "currency": "usd",
                                "default_for_currency": True,
                                "status": "verified",
                                "last4": "6789",
                            }
                        ]
                    },
                    "livemode": False,
                }
            )
        ),
        PaymentIntent=SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "pi_123",
                    "status": "succeeded",
                    "latest_charge": "ch_123",
                    "livemode": False,
                }
            )
        ),
        Charge=SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "ch_123",
                    "payment_intent": "pi_123",
                    "amount": 1000,
                    "amount_refunded": 333,
                    "currency": "usd",
                    "paid": True,
                    "captured": True,
                    "disputed": False,
                    "livemode": False,
                    "balance_transaction": "txn_123",
                    "transfer_group": f"drive-request-{REQUEST}",
                }
            )
        ),
        Transfer=SimpleNamespace(
            list=Mock(return_value={"data": [], "has_more": False}),
            create=Mock(return_value=_transfer(amount=588)),
        ),
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    transfer, error = service._provider_transfer(claim, "sk_test_example")
    assert error is None and transfer["id"] == "tr_123"
    assert api.Transfer.create.call_args.kwargs["destination"] == "acct_123"
    assert api.Transfer.create.call_args.kwargs["amount"] == 588
    api.Charge.retrieve.return_value["amount_refunded"] = 300
    assert service._provider_transfer(claim, "sk_test_example") == (None, "charge_unavailable")
    assert api.Transfer.create.call_count == 1


def test_erased_transfer_finishes_paid_or_reverses_after_full_refund():
    payout, obligation = _erased_earning(
        status="dispatching", transfer_attempt_id="attempt", reversal_amount_cents=None
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    connection = Mock()
    service._row = Mock(
        side_effect=[
            None,
            None,
            obligation,
            {"status": "succeeded", "amount_cents": 333},
            payout,
        ]
    )
    assert (
        service._finish_transfer(
            connection,
            {"request_id": REQUEST, "transfer_attempt_id": "attempt"},
            _transfer(amount=588),
            None,
        )
        == "transferred"
    )
    assert connection.execute.call_args.args[1]["status"] == "transferred"

    service._row = Mock(
        side_effect=[
            None,
            None,
            {**obligation, "status": "refunded"},
            {"status": "succeeded", "amount_cents": 333},
            payout,
        ]
    )
    assert (
        service._finish_transfer(
            connection,
            {"request_id": REQUEST, "transfer_attempt_id": "attempt"},
            _transfer(amount=588),
            None,
        )
        == "reversal_due"
    )
    assert connection.execute.call_args.args[1]["status"] == "reversal_due"


def test_uncertain_transfer_reconciles_existing_without_second_create():
    api = SimpleNamespace(
        Transfer=SimpleNamespace(
            list=Mock(return_value={"data": [_transfer()], "has_more": False}),
            create=Mock(side_effect=AssertionError("duplicate transfer")),
        )
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    transfer, error = service._provider_transfer(_claim(), "sk_test_example")
    assert error is None and transfer["id"] == "tr_123"
    api.Transfer.create.assert_not_called()


def test_mismatched_or_expired_transfer_is_never_recreated():
    api = SimpleNamespace(
        Transfer=SimpleNamespace(
            list=Mock(return_value={"data": [_transfer(amount=900)], "has_more": False}),
            create=Mock(side_effect=AssertionError("duplicate transfer")),
        )
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    assert service._provider_transfer(_claim(), "sk_test_example") == (None, "provider_mismatch")
    api.Transfer.list.return_value = {"data": [], "has_more": False}
    old = {**_claim(), "first_dispatch_at": datetime.now(UTC) - timedelta(hours=21)}
    assert service._provider_transfer(old, "sk_test_example") == (
        None,
        "idempotency_window_elapsed",
    )
    api.Transfer.create.assert_not_called()


def test_reversed_existing_transfer_is_not_treated_as_paid_or_recreated():
    api = SimpleNamespace(
        Transfer=SimpleNamespace(
            list=Mock(
                return_value={
                    "data": [_transfer(reversed=True, amount_reversed=911)],
                    "has_more": False,
                }
            ),
            create=Mock(side_effect=AssertionError("duplicate transfer")),
        )
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    assert service._provider_transfer(_claim(), "sk_test_example") == (None, "provider_mismatch")
    api.Transfer.create.assert_not_called()


def test_unknown_attempt_after_refund_hold_only_reconciles_provider():
    api = SimpleNamespace(
        Transfer=SimpleNamespace(
            list=Mock(return_value={"data": [], "has_more": False}),
            create=Mock(side_effect=AssertionError("transfer under refund hold")),
        )
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    request = {"user_id": "owner", "status": "partial"}
    order = {
        "status": "paid",
        "reconciliation_required": False,
        "stripe_payment_intent_id": "pi_123",
    }
    obligation = {
        "status": "paid",
        "reconciliation_required": False,
        "stripe_payment_intent_id": "pi_123",
    }
    refund = {"status": "pending", "amount_cents": 333}
    payout = {
        "stripe_mode": "test",
        "request_id": REQUEST,
        "status": "unknown",
        "erased_at": None,
        "owner_earning_cents": 588,
        "stripe_charge_id": "ch_123",
        "stripe_payment_intent_id": "pi_123",
        "refund_amount_cents": 333,
        "destination_account_id": "acct_123",
        "transfer_attempt_id": "d0e2312d-9cf6-4de2-89b3-998b9c27a9d0",
    }
    account = {"stripe_account_id": "acct_123", "details_submitted": True, "payouts_enabled": True}
    service._row = Mock(side_effect=[request, order, obligation, refund, payout, account, payout])
    claim = service._claim_transfer(Mock(), REQUEST)
    assert claim is not None and claim["create_allowed"] is False
    assert claim["force_manual_review"] is True
    assert service._provider_transfer(claim, "sk_test_example") == (None, "account_unavailable")
    api.Transfer.create.assert_not_called()


def test_missing_balance_transaction_is_retryable():
    api = SimpleNamespace(
        PaymentIntent=SimpleNamespace(
            retrieve=Mock(
                return_value={"id": "pi_123", "status": "succeeded", "latest_charge": "ch_123"}
            )
        ),
        Charge=SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "ch_123",
                    "payment_intent": "pi_123",
                    "amount": 1000,
                    "transfer_group": f"drive-request-{REQUEST}",
                    "currency": "usd",
                    "paid": True,
                    "captured": True,
                    "disputed": False,
                    "amount_refunded": 0,
                    "livemode": False,
                    "balance_transaction": None,
                }
            )
        ),
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    with pytest.raises(PayoutTransientError, match="missing balance transaction"):
        service._charge_and_fee(
            {
                "request_id": REQUEST,
                "stripe_payment_intent_id": "pi_123",
                "gross_amount_cents": 1000,
                "refund_amount_cents": 0,
            },
            "sk_test_example",
        )


@pytest.mark.asyncio
async def test_transient_fee_resolution_schedules_retry(monkeypatch):
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    monkeypatch.setattr(payout_module, "_config", lambda: ("sk_test_example", "whsec", "https://x"))
    service._charge_and_fee = Mock(side_effect=PayoutTransientError("missing balance transaction"))
    connection = Mock()
    transaction_count = 0

    async def transaction(operation):
        nonlocal transaction_count
        transaction_count += 1
        if transaction_count == 1:
            return [{"request_id": REQUEST}]
        return operation(connection)

    service._transaction = transaction
    assert await service.resolve_processing_fees(max_orders=1) == 0
    assert transaction_count == 2
    sql = str(connection.execute.call_args.args[0])
    assert "next_check_at=clock_timestamp()+interval '5 minutes'" in sql
    assert "status='awaiting_fee'" in sql


@pytest.mark.asyncio
async def test_daily_debit_scan_fetches_transfer_matching_fields(monkeypatch):
    claim = {
        "request_id": REQUEST,
        "status": "transferred",
        "gross_amount_cents": 1000,
        "refund_amount_cents": 0,
        "owner_earning_cents": 911,
        "destination_account_id": "acct_123",
        "stripe_transfer_id": "tr_123",
        "stripe_charge_id": "ch_123",
        "stripe_payment_intent_id": "pi_123",
    }

    class Result:
        def __init__(self, value):
            self.value = value

        def all(self):
            return self.value

        def mappings(self):
            return self

        def first(self):
            return self.value

    class Connection:
        def execute(self, statement, _params):
            sql = str(statement)
            if "SELECT request_id FROM drive_request_owner_payouts" in sql:
                return Result([(REQUEST,)])
            columns = sql.split("FROM drive_request_owner_payouts", 1)[0]
            columns = columns.split("SELECT ", 1)[1].replace("\n", "").replace(" ", "")
            return Result({name: claim[name] for name in columns.split(",")})

    api = SimpleNamespace(
        Charge=SimpleNamespace(
            retrieve=Mock(
                return_value={
                    "id": "ch_123",
                    "payment_intent": "pi_123",
                    "amount": 1000,
                    "currency": "usd",
                    "livemode": False,
                    "paid": True,
                    "disputed": False,
                    "amount_refunded": 0,
                }
            )
        ),
        PaymentIntent=SimpleNamespace(
            retrieve=Mock(return_value={"id": "pi_123", "livemode": False, "status": "succeeded"})
        ),
        Transfer=SimpleNamespace(retrieve=Mock(return_value=_transfer())),
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    monkeypatch.setattr(payout_module, "_config", lambda: ("sk_test_example", "whsec", "https://x"))
    connection = Connection()

    async def transaction(operation):
        return operation(connection)

    service._transaction = transaction
    service._finish_external_debit_check = Mock(return_value="unchanged")
    assert await service.reconcile_external_debits(max_orders=1) == {
        "checked": 1,
        "reversal_due": 0,
        "manual_review": 0,
    }
    assert service._finish_external_debit_check.call_args.args[2] == "clear"


def test_later_charge_debit_requires_reversal_but_unexpected_partial_is_held():
    claim = {
        "request_id": REQUEST,
        "stripe_charge_id": "ch_123",
        "stripe_payment_intent_id": "pi_123",
        "stripe_transfer_id": "tr_123",
        "destination_account_id": "acct_123",
        "owner_earning_cents": 588,
        "gross_amount_cents": 1000,
        "refund_amount_cents": 333,
    }
    charge = {
        "id": "ch_123",
        "payment_intent": "pi_123",
        "amount": 1000,
        "currency": "usd",
        "livemode": False,
        "paid": True,
        "disputed": False,
        "amount_refunded": 333,
    }
    intent = {"id": "pi_123", "livemode": False, "status": "succeeded"}
    outcome = DriveRequestOwnerPayoutService._external_debit_outcome
    transfer = _transfer(amount=588)
    assert outcome(claim, charge, intent, transfer, "sk_test_example") == "clear"
    assert (
        outcome(claim, {**charge, "amount_refunded": 1000}, intent, transfer, "sk_test_example")
        == "full_refund"
    )
    assert (
        outcome(claim, {**charge, "disputed": True}, intent, transfer, "sk_test_example")
        == "chargeback"
    )
    assert (
        outcome(claim, {**charge, "amount_refunded": 500}, intent, transfer, "sk_test_example")
        == "refund_mismatch"
    )
    assert (
        outcome(
            claim, charge, intent, _transfer(amount=588, amount_reversed=100), "sk_test_example"
        )
        == "external_reversal"
    )


def test_external_reversal_queues_reconciliation_without_double_create():
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    connection = Mock()
    service._row = Mock(return_value={"status": "transferred"})
    service.mark_reversal_due = Mock(return_value=True)
    assert service._finish_external_debit_check(connection, REQUEST, "external_reversal") == (
        "reversal_due"
    )
    service.mark_reversal_due.assert_called_once_with(
        connection, request_id=REQUEST, reason="external_reversal"
    )

    claim = {
        **_claim(),
        "stripe_transfer_id": "tr_123",
        "reversal_amount_cents": 911,
        "reversal_first_dispatch_at": datetime.now(UTC) - timedelta(minutes=5),
    }
    api = SimpleNamespace(
        Transfer=SimpleNamespace(
            retrieve=Mock(return_value=_transfer(reversed=True, amount_reversed=911)),
            list_reversals=Mock(
                return_value={
                    "data": [
                        {"id": "trr_123", "transfer": "tr_123", "amount": 911, "currency": "usd"}
                    ],
                    "has_more": False,
                }
            ),
            create_reversal=Mock(side_effect=AssertionError("duplicate reversal")),
        )
    )
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=api)
    reversal, error = service._provider_reversal(claim, "sk_test_example")
    assert error is None and reversal["id"] == "trr_123"
    api.Transfer.create_reversal.assert_not_called()


@pytest.mark.parametrize("first_attempt,expected_reset", [(True, True), (False, False)])
def test_bank_setup_only_resets_provably_unused_transfer_attempt(first_attempt, expected_reset):
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    paid = {
        "status": "paid",
        "reconciliation_required": False,
        "stripe_payment_intent_id": "pi_123",
    }
    payout = {
        "stripe_mode": "test",
        "status": "dispatching",
        "transfer_attempt_id": "attempt",
        "refund_amount_cents": 0,
        "erased_at": None,
        "stripe_payment_intent_id": "pi_123",
        "reversal_amount_cents": None,
        "first_dispatch_at": datetime.now(UTC),
    }
    service._row = Mock(side_effect=[{"status": "completed"}, paid, paid, None, payout])
    connection = Mock()
    result = service._finish_transfer(
        connection,
        {
            "request_id": REQUEST,
            "transfer_attempt_id": "attempt",
            "create_allowed": True,
            "first_transfer_attempt": first_attempt,
        },
        None,
        "account_unavailable",
    )
    assert result == "awaiting_account"
    assert connection.execute.call_args.args[1]["clear_attempt"] is expected_reset


def test_active_transfer_lease_cannot_be_claimed_by_second_worker():
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    payout, obligation = _erased_earning(lease_active=True)
    service._row = Mock(side_effect=[None, None, obligation, None, payout])
    connection = Mock()
    assert service._claim_transfer(connection, REQUEST) is None
    connection.execute.assert_not_called()


def test_old_transfer_completion_cannot_reset_newer_claim():
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    service._row = Mock(side_effect=[None, None, None, None, {"transfer_attempt_id": "new-lease"}])
    connection = Mock()
    assert (
        service._finish_transfer(
            connection,
            {
                "request_id": REQUEST,
                "transfer_attempt_id": "old-lease",
                "create_allowed": True,
                "first_transfer_attempt": True,
            },
            None,
            "account_unavailable",
        )
        == "manual_review"
    )
    connection.execute.assert_not_called()


def test_explicit_uat_live_mode_requires_matching_key_and_production_stays_live(monkeypatch):
    from hushh_mcp.services.stripe_mode import configured_stripe_mode, stripe_key_mode

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.delenv("HUSSH_DEPLOY_ENV", raising=False)
    monkeypatch.delenv("STRIPE_MODE", raising=False)
    assert configured_stripe_mode() == "test"
    with pytest.raises(ValueError):
        stripe_key_mode("sk_live_" + "x" * 30)
    monkeypatch.setenv("STRIPE_MODE", "live")
    assert stripe_key_mode("sk_live_" + "x" * 30) == "live"
    with pytest.raises(ValueError):
        stripe_key_mode("sk_test_" + "x" * 30)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    monkeypatch.setenv("STRIPE_MODE", "test")
    with pytest.raises(ValueError):
        configured_stripe_mode()


def test_old_test_or_unknown_earning_cannot_claim_a_live_transfer(monkeypatch):
    monkeypatch.setenv("STRIPE_MODE", "live")
    for mode in ("test", "legacy"):
        payout, obligation = _erased_earning(stripe_mode=mode)
        service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
        service._row = Mock(side_effect=[None, None, obligation, None, payout])
        assert service._claim_transfer(Mock(), REQUEST) is None
        service.stripe_api.Transfer.create.assert_not_called()


def test_stripe_mode_migration_preserves_unknown_history_and_replays(connector_postgres_url):
    migrations = Path(__file__).resolve().parents[1] / "db/migrations"
    forward = (migrations / "298_stripe_mode_isolation.sql").read_text()
    rollback = (migrations / "rollback/298_stripe_mode_isolation.rollback.sql").read_text()
    database = "stripe_modes_" + uuid4().hex
    admin = create_engine(connector_postgres_url, isolation_level="AUTOCOMMIT")
    engine = None
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
        engine = create_engine(make_url(connector_postgres_url).set(database=database))
        with engine.begin() as connection:
            for table in ("drive_request_payment_orders", "drive_request_payment_obligations"):
                connection.exec_driver_sql(
                    f"CREATE TABLE {table}(request_id UUID PRIMARY KEY,stripe_checkout_session_id TEXT)"
                )
            connection.exec_driver_sql(
                "CREATE TABLE drive_request_owner_payouts(request_id UUID PRIMARY KEY)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE pkm_packet_orders(stripe_checkout_session_id TEXT)"
            )
            connection.exec_driver_sql(
                "CREATE TABLE stripe_connect_bank_payout_events(event_type TEXT)"
            )
            connection.exec_driver_sql(
                "CREATE FUNCTION preserve_drive_request_owner_payout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$"
            )
            for _mode, session in (
                ("test", "cs_test_old"),
                ("live", "cs_live_old"),
                ("legacy", None),
            ):
                request_id = str(uuid4())
                for table in ("drive_request_payment_orders", "drive_request_payment_obligations"):
                    connection.execute(
                        text(f"INSERT INTO {table} VALUES (:request,:session)"),
                        {"request": request_id, "session": session},
                    )
                connection.execute(
                    text("INSERT INTO drive_request_owner_payouts VALUES (:request)"),
                    {"request": request_id},
                )
                connection.execute(
                    text("INSERT INTO pkm_packet_orders VALUES (:session)"), {"session": session}
                )
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            connection.exec_driver_sql(forward, execution_options={"no_parameters": True})
            connection.exec_driver_sql(forward, execution_options={"no_parameters": True})
            for table in (
                "drive_request_payment_orders",
                "drive_request_payment_obligations",
                "drive_request_owner_payouts",
                "pkm_packet_orders",
            ):
                assert set(
                    connection.exec_driver_sql(f"SELECT stripe_mode FROM {table}").scalars()
                ) == {"test", "live", "legacy"}
            connection.exec_driver_sql(
                "INSERT INTO stripe_owner_payout_accounts(user_id,stripe_mode,stripe_account_id) VALUES ('owner','test','acct_test'),('owner','live','acct_live')"
            )
            # An old replica can bind a provider session after migration.
            connection.exec_driver_sql(
                "INSERT INTO pkm_packet_orders(stripe_checkout_session_id) VALUES ('cs_live_rolling')"
            )
            assert (
                connection.exec_driver_sql(
                    "SELECT stripe_mode FROM pkm_packet_orders WHERE stripe_checkout_session_id='cs_live_rolling'"
                ).scalar_one()
                == "live"
            )
            with pytest.raises(Exception, match="Stripe mode is immutable"):
                connection.exec_driver_sql(
                    "UPDATE pkm_packet_orders SET stripe_mode='test' WHERE stripe_checkout_session_id='cs_live_rolling'"
                )
            connection.exec_driver_sql(rollback, execution_options={"no_parameters": True})
            assert (
                connection.exec_driver_sql(
                    "SELECT count(*) FROM stripe_owner_payout_accounts"
                ).scalar_one()
                == 2
            )
            assert (
                connection.exec_driver_sql(
                    "SELECT count(*) FROM drive_request_owner_payouts"
                ).scalar_one()
                == 3
            )
    finally:
        if engine:
            engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        admin.dispose()


@pytest.mark.asyncio
async def test_existing_production_earnings_adopt_legacy_bank_without_profile_visit(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
    from hushh_mcp.services.pkm_payout_service import PkmPayoutService

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    monkeypatch.delenv("HUSSH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("STRIPE_MODE", "live")
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    service._transaction = AsyncMock(return_value=["owner-retry", "owner-ready"])
    refresh = AsyncMock(side_effect=[PacketOrderError("PAYOUT_UNAVAILABLE", "Retry"), {}])
    monkeypatch.setattr(PkmPayoutService, "refresh_account", refresh)
    await service._adopt_production_transfer_accounts([REQUEST])
    assert refresh.await_count == 2
    assert refresh.await_args_list[1].args == ("owner-ready",)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    service._transaction.reset_mock()
    refresh.reset_mock()
    await service._adopt_production_transfer_accounts([REQUEST])
    service._transaction.assert_not_awaited()
    refresh.assert_not_awaited()
