"""Financial boundaries for newly enrolled Drive request owner earnings."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import hushh_mcp.services.drive_request_owner_payout_service as payout_module
from hushh_mcp.services.drive_request_owner_payout_service import (
    DriveRequestOwnerPayoutService,
    PayoutTransientError,
    _erased_settlement_valid,
    delivery_amounts,
    fee_amounts,
)

REQUEST = "bd309adf-d639-4be5-ac20-9dfcb29f05df"


def test_owner_payout_schema_and_rollback_are_in_release_lanes():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "db/release_migration_manifest.json").read_text())
    name = "292_drive_request_owner_payouts.sql"
    assert name in manifest["ordered_migrations"]
    assert (root / "db/migrations" / name).is_file()
    assert (root / "db/migrations" / manifest["rollback_migrations"][name]).is_file()
    for lane in ("dev_minimum_schema", "uat_integrated_schema", "prod_core_schema"):
        contract = json.loads((root / f"db/contracts/{lane}.json").read_text())
        assert "eligible_at_erasure" in contract["required_tables"]["drive_request_owner_payouts"]


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
