"""Import-safe exact money and immutable quote rules. No provider or DB calls."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

MICRO_PER_CENT = 10_000
MAX_CENTS = 100_000
MAX_DURATION_SECONDS = 31_536_000


class CommerceError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def integer(value: int, minimum: int, maximum: int, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise CommerceError(code)
    return value


def half_up(numerator: int, denominator: int) -> int:
    if numerator < 0 or denominator <= 0:
        raise CommerceError("invalid_money_ratio")
    return (numerator * 2 + denominator) // (denominator * 2)


def prorated_cents(price_cents: int, base_seconds: int, term_seconds: int) -> int:
    integer(price_cents, 0, MAX_CENTS, "invalid_tariff")
    integer(base_seconds, 1, MAX_DURATION_SECONDS, "invalid_base_duration")
    integer(term_seconds, 1, MAX_DURATION_SECONDS, "invalid_duration")
    if price_cents == 0:
        return 0
    result = max(1, half_up(price_cents * term_seconds, base_seconds))
    return integer(result, 1, MAX_CENTS, "quote_exceeds_limit")


def allocated_fee(amount_micro: int, basis_remaining: int, fee_remaining: int) -> int:
    if amount_micro <= 0 or amount_micro > basis_remaining or fee_remaining < 0:
        raise CommerceError("invalid_fee_allocation")
    # Last allocation takes the remainder; every microUSD is conserved exactly.
    return half_up(fee_remaining * amount_micro, basis_remaining)


def proportional_shares(total: int, weights: list[tuple[str, int]]) -> dict[str, int]:
    if (
        total < 0
        or any(weight < 0 for _, weight in weights)
        or len({key for key, _ in weights}) != len(weights)
    ):
        raise CommerceError("invalid_proportional_allocation")
    basis = sum(weight for _, weight in weights)
    if not basis:
        if total:
            raise CommerceError("allocation_basis_required")
        return {key: 0 for key, _ in weights}
    remaining = total
    result = {}
    for key, weight in weights:
        part = half_up(remaining * weight, basis) if weight else 0
        result[key] = part
        remaining -= part
        basis -= weight
    if remaining:
        raise CommerceError("allocation_conservation_failure")
    return result


def unused_cents(price_cents: int, start: datetime, end: datetime, now: datetime) -> int:
    if end <= start:
        raise CommerceError("invalid_access_term")
    if now <= start:
        return price_cents
    if now >= end:
        return 0
    # Contract uses whole unused seconds, then nearest-cent half-up; never float.
    unused = max(0, int((end - now).total_seconds()))
    duration = int((end - start).total_seconds())
    return min(price_cents, half_up(price_cents * unused, duration))


def payout_terms(
    available_micro_usd: int,
    fixed_fee_micro_usd: int,
    fee_basis_points: int,
    minimum_net_cents: int,
) -> dict[str, int]:
    integer(available_micro_usd, 0, 10**18, "invalid_earnings_amount")
    integer(fixed_fee_micro_usd, 0, 10**18, "invalid_payout_fee")
    integer(fee_basis_points, 0, 10000, "invalid_payout_fee")
    minimum = max(50, integer(minimum_net_cents, 1, MAX_CENTS, "invalid_payout_floor"))
    net = max(
        0,
        (available_micro_usd - fixed_fee_micro_usd)
        * 10000
        // (10000 + fee_basis_points)
        // MICRO_PER_CENT,
    )
    fee = 0
    while net:
        variable = (net * MICRO_PER_CENT * fee_basis_points + 9999) // 10000
        fee = (
            (fixed_fee_micro_usd + variable + MICRO_PER_CENT - 1) // MICRO_PER_CENT
        ) * MICRO_PER_CENT
        if net * MICRO_PER_CENT + fee <= available_micro_usd:
            break
        net -= 1
    return {
        "net_cents": net,
        "fee_micro_usd": fee,
        "gross_micro_usd": net * MICRO_PER_CENT + fee if net else 0,
        "minimum_net_cents": minimum,
    }


def fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def utcnow() -> datetime:
    return datetime.now(UTC)


def account(kind: str, identity: Any = "platform") -> str:
    return f"{kind}:{identity}"


def public(row: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    # Raw tokens, encrypted packages, journal internals and hashes never appear
    # in generic HTTP projection. Explicit preparation returns separate fields.
    keys = {
        "purchase_id",
        "quote_id",
        "request_id",
        "scope_handle",
        "machine_scope",
        "buyer_app_id",
        "recipient_key_fingerprint",
        "status",
        "price_cents",
        "duration_seconds",
        "base_duration_seconds",
        "base_price_cents",
        "tariff_revision",
        "activation_at",
        "expires_at",
        "preparation_id",
        "fulfillment_deadline",
        "purpose",
        "refresh_policy",
        "scope_manifest_revision",
        "export_id",
        "export_revision",
        "refunded_cents",
        "earnings_settled_at",
        "revoked_at",
        "fee_policy",
        "request_deadline",
    }
    for key in keys:
        if key not in row:
            continue
        value = row[key]
        if key == "fee_policy" and isinstance(value, str):
            value = json.loads(value)
        if isinstance(value, datetime):
            value = value.isoformat()
        elif value is not None and key.endswith("_id"):
            value = str(value)
        camel = key.split("_")[0] + "".join(part.title() for part in key.split("_")[1:])
        result[camel] = value
    result["currency"] = "usd"
    if "purchase_id" in row and "fee_micro_usd" in row:
        charged = row["status"] == "staged" or row.get("earnings_settled_at") is not None
        held = row["status"] in {"reserved", "preparing"}
        result["processingFeeMicroUsd"] = row["fee_micro_usd"] if charged or held else 0
        result["netEarningsMicroUsd"] = (
            (row["price_cents"] - row["refunded_cents"]) * MICRO_PER_CENT - row["fee_micro_usd"]
            if charged or held
            else 0
        )
    if "status" in row and row["status"] == "staged":
        now = row.get("admission_now") or utcnow()
        result["status"] = (
            "armed"
            if now < row["activation_at"]
            else "active"
            if now < row["expires_at"]
            else "expired"
        )
    return result
