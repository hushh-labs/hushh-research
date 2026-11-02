"""Exact currency totals and explicit transaction deduplication contracts."""

from decimal import localcontext

import pytest
from pydantic import ValidationError

from hushh_mcp.services.email_oss.accounting import (
    ReceiptAmount,
    sum_receipt_amounts,
    validate_receipt_amount_evidence,
)


def row(amount="0.10", currency="USD", source_ref="message:m1", **extra):
    return {"amount": amount, "currency": currency, "source_ref": source_ref, **extra}


def test_decimal_totals_preserve_precision_refunds_and_independent_currencies():
    with localcontext() as context:
        context.prec = 4  # Caller precision must not silently round receipts.
        result = sum_receipt_amounts(
            [
                row("999999999999999999.123456"),
                row("0.000001", source_ref="message:m2/attachment:a1"),
                row("-0.10", source_ref="message:m3"),
                row("250", "JPY", "message:m4"),
            ]
        )
    assert result == {
        "currency_totals": {"JPY": "250", "USD": "999999999999999999.023457"},
        "source_count": 4,
    }
    assert sum_receipt_amounts([row("0.10"), row("0.20")])["currency_totals"] == {"USD": "0.30"}


def test_only_explicit_transaction_keys_deduplicate_without_semantic_inference():
    keyed = [
        row("1.00", transaction_key="tx1"),
        row("1.0", source_ref="message:m2", transaction_key="tx1"),
    ]
    assert sum_receipt_amounts(keyed) == {"currency_totals": {"USD": "1.00"}, "source_count": 1}
    assert sum_receipt_amounts([row("1.00"), row("1.00")]) == {
        "currency_totals": {"USD": "2.00"},
        "source_count": 1,
    }


@pytest.mark.parametrize(
    "conflict", [row("2.00", transaction_key="tx1"), row("1.00", "EUR", transaction_key="tx1")]
)
def test_conflicting_transaction_keys_fail_closed(conflict):
    with pytest.raises(ValueError, match="Conflicting duplicate"):
        sum_receipt_amounts([row("1.00", transaction_key="tx1"), conflict])


@pytest.mark.parametrize(
    "invalid", [0.1, None, "NaN", "Infinity", "1e3", "1.0000001", "1000000000000000000", " 1.00"]
)
def test_amounts_reject_floats_missing_values_and_unbounded_or_lossy_formats(invalid):
    with pytest.raises(ValidationError):
        ReceiptAmount.model_validate(row(invalid))


@pytest.mark.parametrize(
    "invalid",
    [
        row(currency="usd"),
        row(currency="ZZZ"),
        row(source_ref="name@example.test"),
        row(source_ref=""),
        row(unexpected=True),
    ],
)
def test_currency_source_and_schema_reject_untrusted_shapes(invalid):
    with pytest.raises(ValidationError):
        ReceiptAmount.model_validate(invalid)


def test_row_limit_and_empty_result_are_explicit():
    assert sum_receipt_amounts([]) == {"currency_totals": {}, "source_count": 0}
    assert sum_receipt_amounts([ReceiptAmount(**row())] * 50)["currency_totals"] == {"USD": "5.00"}
    with pytest.raises(ValueError, match="At most 50"):
        sum_receipt_amounts([row()] * 51)


@pytest.mark.parametrize("quote", ["Amount is unavailable.", "Invoice attached.", "Amount 100.10."])
def test_missing_amount_cannot_become_zero_even_with_a_real_source_quote(quote):
    receipt = ReceiptAmount(**row("0", evidence_quote=quote))
    assert not validate_receipt_amount_evidence(receipt, f"Source: {quote}")


@pytest.mark.parametrize(
    "amount,quote",
    [
        ("0", "Amount: $0.00."),
        ("1000.10", "Total: USD 1,000.10."),
        ("-1000.10", "Refund: -1,000.10"),
        ("0.000001", "Amount: 0.000001"),
    ],
)
def test_explicit_numeric_evidence_accepts_exact_values_without_quantization(amount, quote):
    receipt = ReceiptAmount(**row(amount, evidence_quote=quote))
    assert validate_receipt_amount_evidence(receipt, f"Source: {quote}")
    assert not validate_receipt_amount_evidence(receipt, "A different source contains no amount.")


@pytest.mark.parametrize(
    "amount,quote",
    [
        ("100.10", "Amount: 100,10"),
        ("1000.10", "Amount: 1,00.10"),
        ("1000", "Amount: 1e3"),
        ("1", "Amount: 1.0000001"),
        ("100.10", "Refund: -100.10"),
        ("0", "Amount: 100"),
    ],
)
def test_malformed_localized_scientific_or_partial_number_evidence_is_rejected(amount, quote):
    assert not validate_receipt_amount_evidence(
        ReceiptAmount(**row(amount, evidence_quote=quote)), quote
    )


def test_verified_receipt_rows_sum_100_10_plus_0_2_exactly():
    rows = [
        ReceiptAmount(**row("100.10", evidence_quote="Total $100.10.")),
        ReceiptAmount(**row("0.2", source_ref="message:m2", evidence_quote="Total $0.2.")),
    ]
    assert all(validate_receipt_amount_evidence(item, item.evidence_quote) for item in rows)
    assert sum_receipt_amounts(rows)["currency_totals"] == {"USD": "100.30"}
