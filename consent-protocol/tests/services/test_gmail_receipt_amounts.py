"""Receipt total candidates keep every digit of Indian and Western grouped amounts."""

from __future__ import annotations

from hushh_mcp.services.gmail_receipt_amounts import SUFFIX_TOTAL, TOTAL, receipt_currency


def _total(text: str) -> tuple[str, str | None]:
    match = TOTAL.search(text)
    assert match is not None
    return match.group(4), receipt_currency(match.group(2), match.group(3), match.group(5))


def test_indian_grouped_and_rs_totals_keep_every_digit():
    # Regression: "₹1,23,456.00" used to be captured as ₹1 and "Rs." was dropped.
    assert _total("Grand total: ₹1,23,456.00") == ("1,23,456.00", "INR")
    assert _total("Order total: Rs. 2,50,000") == ("2,50,000", "INR")
    assert _total("Total paid: INR 1,00,00,000") == ("1,00,00,000", "INR")
    assert _total("Order total: USD 1,234,567.89") == ("1,234,567.89", "USD")
    suffix = SUFFIX_TOTAL.search("Rs. 1,49,999 Paid")
    assert suffix is not None and suffix.group(3) == "1,49,999"
    assert receipt_currency(suffix.group(1), suffix.group(2), suffix.group(4)) == "INR"


def test_unresolved_or_conflicting_currency_stays_unknown():
    # Negative controls: a bare dollar keeps "$", and a symbol that contradicts
    # an explicit code is refused rather than guessed.
    assert _total("Total: $1,234.50") == ("1,234.50", "$")
    assert _total("Order total: USD ₹500") == ("500", None)
