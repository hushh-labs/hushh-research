"""Exact refund and terminal-request payout state regression families."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest

from hushh_mcp.services.drive_request_owner_payout_service import DriveRequestOwnerPayoutService
from tests.test_drive_request_owner_payouts import REQUEST

_PAST = datetime.now(UTC) - timedelta(minutes=1)
_FUTURE = datetime.now(UTC) + timedelta(days=1)


@pytest.mark.parametrize(
    ("changed_row", "changes", "expected"),
    [
        pytest.param(None, {}, "void", id="verified-full-refund"),
        pytest.param("refund", None, "held", id="missing-refund"),
        pytest.param("refund", {"status": "pending"}, "held", id="pending-refund"),
        pytest.param("refund", {"status": "failed"}, "held", id="failed-refund"),
        pytest.param("refund", {"stripe_refund_id": None}, "held", id="missing-provider-id"),
        pytest.param("refund", {"stripe_refund_id": ""}, "held", id="empty-provider-id"),
        pytest.param("refund", {"amount_cents": 999}, "held", id="wrong-refund-amount"),
        pytest.param("refund", {"amount_cents": None}, "held", id="unknown-refund-amount"),
        pytest.param("order", {"status": "paid"}, "held", id="order-still-paid"),
        pytest.param("obligation", {"status": "paid"}, "held", id="obligation-still-paid"),
        pytest.param("order", {"stripe_payment_intent_id": ""}, "held", id="missing-intent"),
        pytest.param(
            "obligation", {"stripe_payment_intent_id": "pi_other"}, "held", id="wrong-intent"
        ),
        pytest.param(
            "payout", {"stripe_payment_intent_id": "pi_other"}, "held", id="wrong-payout-intent"
        ),
        pytest.param("order", {"stripe_mode": "live"}, "held", id="wrong-order-mode"),
        pytest.param("obligation", {"stripe_mode": "live"}, "held", id="wrong-obligation-mode"),
        pytest.param("payout", {"stripe_mode": "live"}, "held", id="wrong-payout-mode"),
        pytest.param("order", {"amount_cents": 999}, "held", id="wrong-order-gross"),
        pytest.param("obligation", {"amount_cents": 999}, "held", id="wrong-obligation-gross"),
        pytest.param("payout", {"gross_amount_cents": 999}, "held", id="wrong-payout-gross"),
        pytest.param(
            "payout",
            {"retained_amount_cents": 100, "refund_amount_cents": 900},
            "held",
            id="positive-retained-proceeds",
        ),
        pytest.param("request", {"status": "pending"}, "held", id="nonterminal-request"),
    ],
)
def test_full_refund_closes_only_verified_zero_earning_without_clearing_fences(
    changed_row, changes, expected, monkeypatch
):
    monkeypatch.setattr("hushh_mcp.services.document_delivery.store.has_contract", lambda *_: False)
    source = {
        "status": "refunded",
        "reconciliation_required": True,
        "stripe_payment_intent_id": "pi_123",
        "stripe_mode": "test",
        "amount_cents": 1000,
    }
    rows = {
        "request": {"status": "no_match"},
        "order": dict(source),
        "obligation": dict(source),
        "refund": {"status": "succeeded", "amount_cents": 1000, "stripe_refund_id": "re_123"},
        "payout": {
            "status": "awaiting_refund",
            "erased_at": None,
            "gross_amount_cents": 1000,
            "retained_amount_cents": 0,
            "refund_amount_cents": 1000,
            "stripe_payment_intent_id": None,
            "stripe_mode": "test",
        },
    }
    if changed_row is not None:
        rows[changed_row] = None if changes is None else {**rows[changed_row], **changes}
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    service._row = Mock(
        side_effect=[rows[key] for key in ("request", "order", "obligation", "refund", "payout")]
    )
    connection = Mock()

    assert service._advance_delivery(connection, REQUEST) == expected
    assert rows["order"]["reconciliation_required"] is True
    assert rows["obligation"]["reconciliation_required"] is True
    if expected == "held":
        connection.execute.assert_called_once()  # Only the share lock; no state change.
    else:
        assert connection.execute.call_count == 2
        statement, parameters = connection.execute.call_args.args
        assert "UPDATE drive_request_owner_payouts" in str(statement)
        assert "reconciliation_required" not in str(statement)
        assert parameters == {"request": REQUEST, "status": "void"}


@pytest.mark.parametrize(
    ("request_row", "order_status", "obligation_status", "expected"),
    [
        pytest.param({"status": "cancelled"}, "expired", "expired", "void", id="withdrawn-unpaid"),
        pytest.param(
            {"status": "declined"}, "checkout_open", "checkout_open", "void", id="declined-unpaid"
        ),
        pytest.param(
            {"status": "pending", "expires_at": _PAST},
            "awaiting_payment",
            "awaiting_payment",
            "void",
            id="lapsed",
        ),
        pytest.param(
            {"status": "cancelled"}, "refunded", "refunded", "void", id="withdrawn-refunded"
        ),
        pytest.param(
            {"status": "pending", "expires_at": _FUTURE, "access_stop_requested_at": _PAST},
            "checkout_open",
            "checkout_open",
            "void",
            id="stopped-unpaid",
        ),
        # A finished request can deliver nothing more either. Pay-at-Allow
        # creates the order and earning before the search, so a search that
        # finds nothing leaves an unpaid earning on a no_match request.
        pytest.param(
            {"status": "no_match"}, "checkout_open", "checkout_open", "void", id="no-match-unpaid"
        ),
        pytest.param(
            {"status": "partial"}, "expired", "expired", "void", id="finished-link-expired"
        ),
        # Negative controls: money still held, or the request is still open. A
        # finished request records its delivery counts before a full refund
        # voids it (this mock leaves one approved batch unresolved).
        pytest.param({"status": "partial"}, "refunded", "refunded", "held", id="finished-refunded"),
        pytest.param({"status": "no_match"}, "paid", "paid", "held", id="no-match-paid"),
        pytest.param({"status": "cancelled"}, "paid", "paid", "held", id="paid-awaiting-refund"),
        pytest.param({"status": "cancelled"}, "expired", "paid", "held", id="paid-obligation"),
        pytest.param(
            {"status": "pending", "expires_at": _FUTURE, "access_stop_requested_at": _PAST},
            "paid",
            "paid",
            "held",
            id="stopped-paid",
        ),
        pytest.param(
            {"status": "pending", "expires_at": _FUTURE},
            "awaiting_payment",
            "awaiting_payment",
            "held",
            id="open",
        ),
    ],
)
def test_closed_request_earning_is_void_only_when_unpaid_or_fully_refunded(
    request_row, order_status, obligation_status, expected, monkeypatch
):
    monkeypatch.setattr("hushh_mcp.services.document_delivery.store.has_contract", lambda *_: False)

    def money(status):
        paid = status in {"paid", "refunded"}
        return {
            "status": status,
            "paid_at": datetime.now(UTC) if paid else None,
            "reconciliation_required": status == "refunded",
            "stripe_payment_intent_id": "pi_123" if paid else None,
            "stripe_mode": "test",
            "amount_cents": 1000,
        }

    source, obligation = money(order_status), money(obligation_status)
    if obligation_status == "paid" and order_status != "paid":
        source["stripe_payment_intent_id"] = "pi_123"
    refund = (
        {"status": "succeeded", "amount_cents": 1000, "stripe_refund_id": "re_123"}
        if order_status == "refunded"
        else None
    )
    payout = {
        "status": "awaiting_delivery",
        "erased_at": None,
        "gross_amount_cents": 1000,
        "stripe_payment_intent_id": None,
        "stripe_mode": "test",
    }
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    service._row = Mock(side_effect=[request_row, source, obligation, refund, payout])
    connection = Mock()

    assert service._advance_delivery(connection, REQUEST) == expected
    if expected == "held":
        # Paid money is never voided: it settles on its delivered files once
        # every approved batch has finished (this mock leaves one unresolved).
        assert not any(
            "UPDATE drive_request_owner_payouts" in str(call.args[0])
            for call in connection.execute.call_args_list
        )
    else:
        statement, parameters = connection.execute.call_args.args
        assert "status='void'" in str(statement) and "status='awaiting_delivery'" in str(statement)
        assert parameters == {"request": REQUEST}


@pytest.mark.parametrize(
    ("order_status", "expected_files", "expected"),
    [
        # Every match was one A could not share: no approved file. Once B's
        # charge is back in full nothing is left to settle; before, the
        # earning stayed awaiting_delivery forever on a finished request.
        pytest.param("refunded", 0, "void", id="no-approved-file-refunded"),
        # Negative controls: the refund has not happened yet, or files were
        # approved and their counts are recorded before the refund voids it.
        pytest.param("paid", 0, "held", id="no-approved-file-paid"),
        pytest.param("refunded", 3, "awaiting_refund", id="approved-files-refunded"),
    ],
)
def test_finished_request_without_approved_files_voids_after_a_full_refund(
    order_status, expected_files, expected, monkeypatch
):
    monkeypatch.setattr("hushh_mcp.services.document_delivery.store.has_contract", lambda *_: False)
    paid_at = datetime.now(UTC)

    def money(status):
        return {
            "status": status,
            "paid_at": paid_at,
            "reconciliation_required": status == "refunded",
            "stripe_payment_intent_id": "pi_123",
            "stripe_mode": "test",
            "amount_cents": 1000,
        }

    refund = (
        {"status": "succeeded", "amount_cents": 1000, "stripe_refund_id": "re_123"}
        if order_status == "refunded"
        else None
    )
    payout = {
        "status": "awaiting_delivery",
        "erased_at": None,
        "gross_amount_cents": 1000,
        "commission_bps": 300,
        "stripe_payment_intent_id": None,
        "stripe_mode": "test",
    }
    request_row = {
        "status": "partial",
        "request_id": REQUEST,
        "recipient_user_id": "recipient",
        "request_envelope": None,
    }
    service = DriveRequestOwnerPayoutService(db=Mock(), stripe_api=Mock())
    service._row = Mock(
        side_effect=[request_row, money(order_status), money(order_status), refund, payout]
    )
    service._delivery_summary = Mock(
        return_value={"expected": expected_files, "confirmed": 0, "unsettled": 0}
    )
    connection = Mock()
    connection.execute.return_value.scalar_one.return_value = False  # No batch still sharing.

    assert service._advance_delivery(connection, REQUEST) == expected
    writes = [
        str(call.args[0])
        for call in connection.execute.call_args_list
        if "UPDATE drive_request_owner_payouts" in str(call.args[0])
    ]
    if expected == "void":
        assert len(writes) == 1 and "status='void'" in writes[0]
    elif expected == "held":
        assert writes == []
    else:
        assert len(writes) == 1 and "expected_files=:expected" in writes[0]
