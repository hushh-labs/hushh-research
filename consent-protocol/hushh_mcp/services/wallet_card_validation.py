"""Server-side validation for the reserved ``wallet`` PKM domain.

BYOK means the server never sees a PAN, CVV, or PIN in plaintext - full card
validation (Luhn, brand detection from the number) is client-side only.  What
the server CAN and MUST validate is the non-secret summary envelope that
accompanies a ``wallet`` store-domain write: issuing region, brand,
last four digits, and expiry shape, plus the region barrier (a region-locked
scheme never claims an issuing region outside its home market).

The region rule is deliberately one-directional: regional schemes are locked
to their regions, while global schemes are valid everywhere.  Rejecting a
global brand for any region would refuse legitimately issued cards.
"""

from __future__ import annotations

import re
from typing import Any

from hushh_mcp.services.user_identifier_service import normalize_country_hint

MAX_CARDS_PER_OWNER = 100

CARD_BRANDS = frozenset(
    {
        "visa",
        "mastercard",
        "amex",
        "discover",
        "diners",
        "jcb",
        "unionpay",
        "rupay",
        "mir",
        "elo",
        "verve",
        "other",
    }
)

# Region-locked schemes: brand -> ISO-3166 alpha-2 regions where it is issued.
# Global schemes are absent on purpose - they validate for every region.
REGION_LOCKED_BRANDS: dict[str, frozenset[str]] = {
    "rupay": frozenset({"IN"}),
    "mir": frozenset({"RU", "AM", "BY", "KZ", "KG", "TJ", "UZ"}),
    "elo": frozenset({"BR"}),
    "verve": frozenset({"NG", "GH"}),
}

_CARD_ID_PATTERN = re.compile(
    r"^card_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_LAST4_PATTERN = re.compile(r"^\d{4}$")


def validate_card_summary_entry(entry: Any) -> None:
    """Validate one non-secret card summary. Raises ``ValueError`` on refusal."""

    if not isinstance(entry, dict):
        raise ValueError("card_summary_entry_must_be_object")

    card_id = str(entry.get("card_id") or "")
    if not _CARD_ID_PATTERN.match(card_id):
        raise ValueError("card_id_invalid")

    brand = str(entry.get("brand") or "").strip().lower()
    if brand not in CARD_BRANDS:
        raise ValueError(f"card_brand_unknown:{brand or 'missing'}")

    last4 = str(entry.get("last4") or "")
    if not _LAST4_PATTERN.match(last4):
        raise ValueError("card_last4_invalid")

    month = entry.get("expiry_month")
    year = entry.get("expiry_year")
    if not isinstance(month, int) or not 1 <= month <= 12:
        raise ValueError("card_expiry_month_invalid")
    if not isinstance(year, int) or not 2000 <= year <= 2100:
        raise ValueError("card_expiry_year_invalid")

    raw_region = str(entry.get("issuing_region") or "").strip()
    region = normalize_country_hint(raw_region)
    if not region:
        raise ValueError(f"card_issuing_region_invalid:{raw_region or 'missing'}")

    locked_regions = REGION_LOCKED_BRANDS.get(brand)
    if locked_regions is not None and region not in locked_regions:
        raise ValueError(f"card_brand_region_mismatch:{brand}:{region}")


def validate_wallet_card_envelope(summary: Any) -> None:
    """Validate the plaintext summary of a ``wallet`` domain write.

    Expected shape: ``{"card_count": int, "cards": [<summary entry>, ...]}``.
    Secrets never appear here; any recognizable secret-shaped key is refused
    outright so a buggy client cannot smuggle plaintext into the index.
    """

    if not isinstance(summary, dict):
        raise ValueError("wallet_summary_must_be_object")

    forbidden = {"pan", "cvv", "cvc", "pin", "card_number", "number", "secrets"}

    def _refuse_secret_keys(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if str(key).strip().lower() in forbidden:
                    raise ValueError(f"wallet_summary_contains_secret_key:{key}")
                _refuse_secret_keys(value)
        elif isinstance(node, list):
            for value in node:
                _refuse_secret_keys(value)

    _refuse_secret_keys(summary)

    cards = summary.get("cards")
    if cards is None:
        cards = []
    if not isinstance(cards, list):
        raise ValueError("wallet_summary_cards_must_be_list")
    if len(cards) > MAX_CARDS_PER_OWNER:
        raise ValueError("wallet_too_many_cards")

    card_count = summary.get("card_count")
    if card_count is not None and card_count != len(cards):
        raise ValueError("wallet_count_mismatch")

    seen_ids: set[str] = set()
    for entry in cards:
        validate_card_summary_entry(entry)
        card_id = str(entry["card_id"])
        if card_id in seen_ids:
            raise ValueError(f"wallet_duplicate_card_id:{card_id}")
        seen_ids.add(card_id)
