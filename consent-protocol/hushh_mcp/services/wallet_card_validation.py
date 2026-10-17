"""Server-side validation for the reserved ``wallet`` PKM domain.

BYOK means the server never sees a PAN, CVV, or PIN in plaintext - credential validation (Luhn and security-code shape) remains client-side.
Network classification uses only a transient six-digit issuer prefix and length,
never a full PAN or security code. Prefixes are not persisted or logged.  What
the server CAN and MUST validate is the non-secret summary envelope that
accompanies a ``wallet`` store-domain write: issuing region, brand,
last four digits, and expiry shape, plus the region barrier (a region-locked
scheme never claims an issuing region outside its home market).

Issuing region is optional. When supplied, the region rule is deliberately
one-directional: regional schemes are locked to their regions, while global
schemes are valid everywhere. Rejecting a global brand for any region would
refuse legitimately issued cards.
"""

from __future__ import annotations

import re
from typing import Any

from hushh_mcp.services.user_identifier_service import normalize_country_hint

MAX_CARDS_PER_OWNER = 100

NETWORK_ORDER = (
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
)
CARD_BRANDS = frozenset(NETWORK_ORDER)

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
    region = normalize_country_hint(raw_region) if raw_region else None
    if raw_region and not region:
        raise ValueError(f"card_issuing_region_invalid:{raw_region or 'missing'}")

    locked_regions = REGION_LOCKED_BRANDS.get(brand)
    if region and locked_regions is not None and region not in locked_regions:
        raise ValueError(f"card_brand_region_mismatch:{brand}:{region}")


def validate_wallet_card_envelope(summary: Any) -> None:
    """Validate the plaintext summary of a ``wallet`` domain write.

    Expected shape: ``{"card_count": int, "cards": [<summary entry>, ...]}``.
    Secrets never appear here; any recognizable secret-shaped key is refused
    outright so a buggy client cannot smuggle plaintext into the index.
    """

    if not isinstance(summary, dict):
        raise ValueError("wallet_summary_must_be_object")

    forbidden = {
        "pan",
        "cvv",
        "cvc",
        "pin",
        "card_number",
        "number",
        "secrets",
        "manual_cvv",
        "security_code",
        "securitycode",
    }

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


# One backend authority for the existing supported network rules. These patterns
# are classification hints, not a live issuer registry or verification of a card.
NETWORK_PREFIX_RANGES = (
    ("mir", 2200, 2204),
    ("elo", 401178, 401179),
    ("elo", 431274, 431274),
    ("elo", 438935, 438935),
    ("elo", 451416, 451416),
    ("elo", 457393, 457393),
    ("elo", 504175, 504175),
    ("elo", 506699, 506778),
    ("elo", 509000, 509999),
    ("elo", 627780, 627780),
    ("elo", 636297, 636297),
    ("elo", 636368, 636368),
    ("verve", 506099, 506198),
    ("verve", 650002, 650027),
    ("rupay", 6521, 6522),
    ("discover", 6011, 6011),
    ("discover", 622126, 622925),
    ("discover", 644, 649),
    ("discover", 65, 65),
    ("rupay", 508, 508),
    ("rupay", 353, 353),
    ("rupay", 356, 356),
    ("rupay", 60, 60),
    ("rupay", 81, 82),
    ("jcb", 3528, 3589),
    ("amex", 34, 34),
    ("amex", 37, 37),
    ("diners", 300, 305),
    ("diners", 36, 36),
    ("diners", 38, 39),
    ("unionpay", 62, 62),
    ("mastercard", 2221, 2720),
    ("mastercard", 51, 55),
    ("visa", 4, 4),
)
NETWORK_PAN_LENGTHS = {
    "visa": (13, 16, 19),
    "mastercard": (16,),
    "amex": (15,),
    "discover": (16, 19),
    "diners": (14, 16, 19),
    "jcb": (16, 17, 18, 19),
    "unionpay": (16, 17, 18, 19),
    "rupay": (16,),
    "mir": (16, 17, 18, 19),
    "elo": (16,),
    "verve": (16, 18, 19),
    "other": tuple(range(12, 20)),
}


def normalize_card_network(value: str | None) -> str:
    key = str(value or "").strip().lower()
    return key if key in CARD_BRANDS else "other"


def classify_card_network(
    iin_prefix: str, pan_length: int, selected_network: str | None = None
) -> dict:
    if not isinstance(iin_prefix, str) or re.fullmatch(r"[0-9]{6}", iin_prefix) is None:
        raise ValueError("card_network_request_invalid")
    if type(pan_length) is not int or not 12 <= pan_length <= 19:
        raise ValueError("card_network_request_invalid")
    if selected_network is not None:
        selected = normalize_card_network(selected_network)
        if selected == "other" and str(selected_network).strip().lower() != "other":
            raise ValueError("card_network_request_invalid")
        # Preserve the owner's explicit choice for newer and co-badged ranges.
        # As with prefix detection, keep the network at an invalid length so
        # local credential validation can explain the mismatch without losing it.
        return {"network": selected, "source": "owner_selected", "candidates": []}
    matches = []
    for network, low, high in NETWORK_PREFIX_RANGES:
        prefix = int(iin_prefix[: len(str(low))])
        # Keep recognized prefixes even at an invalid length. The local
        # credential validator must reject them using that network's rules;
        # falling back to Other here would silently broaden those rules.
        if low <= prefix <= high and network not in matches:
            matches.append(network)
    # These known overlapping ranges cannot establish the card's network alone.
    overlap = iin_prefix.startswith(("353", "356")) or 622126 <= int(iin_prefix) <= 622925
    if overlap and len(matches) > 1:
        eligible = [network for network in matches if pan_length in NETWORK_PAN_LENGTHS[network]]
        if len(eligible) > 1:
            return {"network": "other", "source": "ambiguous", "candidates": eligible}
        if eligible:
            matches = eligible
    return {
        "network": matches[0] if matches else "other",
        "source": "prefix" if matches else "unknown",
        "candidates": [],
    }
