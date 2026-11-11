"""Deterministic total and currency candidates for live Gmail receipt evidence.

These patterns only propose labelled amount candidates. The receipt extractor
model decides which candidate is the receipt total; code never picks one.
"""

from __future__ import annotations

import re

# A rupee, euro, pound or dollar sign ("Rs" and "Rs." are rupees), then digits
# grouped as thousands (1,234,567) or Indian lakhs (1,23,456 and 1,00,00,000).
_MONEY = (
    r"([₹€£$]|Rs\.?)?\s*((?:[0-9]{1,3}(?:,[0-9]{3}){1,3}"
    r"|[0-9]{1,2}(?:,[0-9]{2}){1,4},[0-9]{3}|[0-9]{1,12})(?:\.[0-9]{1,2})?)"
)
TOTAL = re.compile(
    r"\b(grand\s+total|order\s+total|invoice\s+total|total\s+amount|"
    r"total\s+(?:paid|charged)|amount\s+(?:paid|charged|due)|payment\s+(?:total|received)|"
    r"total)\b\s*(?:is\s*)?[:=-]?\s*(?:(INR|USD|EUR|GBP)\s*)?"
    + _MONEY
    + r"(?![0-9])(?:\s*(INR|USD|EUR|GBP))?",
    re.I,
)
SUFFIX_TOTAL = re.compile(
    r"(?<![\w.,])(?:(INR|USD|EUR|GBP)\s*)?" + _MONEY + r"(?:\s*(INR|USD|EUR|GBP))?\s+(Paid|Due)\b",
    re.I,
)
_SYMBOL_CURRENCY = {"₹": "INR", "€": "EUR", "£": "GBP", "RS": "INR", "RS.": "INR"}


def receipt_currency(
    code_before: str | None, symbol: str | None, code_after: str | None
) -> str | None:
    explicit = (code_before or code_after or "").upper()
    symbol_currency = _SYMBOL_CURRENCY.get((symbol or "").upper(), "")
    if symbol == "$" and not explicit:
        # Preserve the source symbol without guessing a dollar jurisdiction.
        return "$"
    if explicit and symbol_currency and explicit != symbol_currency:
        return None
    return explicit or symbol_currency or None


__all__ = ["SUFFIX_TOTAL", "TOTAL", "receipt_currency"]
