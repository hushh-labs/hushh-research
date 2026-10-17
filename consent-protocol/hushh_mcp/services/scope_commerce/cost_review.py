"""Exact owner acknowledgement of known negative financial terms."""

import json
from typing import Any

from .domain import MICRO_PER_CENT, CommerceError, fingerprint


def negative_net_review(
    purchase: dict[str, Any], allocations: list[list[Any]]
) -> dict[str, Any] | None:
    gross = purchase["price_cents"] * MICRO_PER_CENT
    fee = purchase["fee_micro_usd"]
    if fee <= gross:
        return None
    binding = fingerprint(
        [
            1,
            str(purchase["purchase_id"]),
            str(purchase["quote_id"]),
            purchase["owner_user_id"],
            purchase["price_cents"],
            fee,
            purchase["duration_seconds"],
            purchase["recipient_key_fingerprint"],
            json.loads(purchase["fee_policy"])
            if isinstance(purchase["fee_policy"], str)
            else purchase["fee_policy"],
            allocations,
        ]
    )
    return {
        "version": 1,
        "binding": binding,
        "gross_cents": purchase["price_cents"],
        "processing_fee_micro_usd": fee,
        "net_earnings_micro_usd": gross - fee,
    }


async def read_negative_net_review(conn: Any, purchase: dict[str, Any]) -> dict[str, Any] | None:
    if purchase["fee_micro_usd"] <= purchase["price_cents"] * MICRO_PER_CENT:
        return None
    rows = await conn.fetch(
        "SELECT lot_id,gross_micro_usd,fee_micro_usd FROM scope_commerce_allocations WHERE purchase_id=$1 ORDER BY lot_id",
        purchase["purchase_id"],
    )
    if (
        sum(row["gross_micro_usd"] for row in rows) != purchase["price_cents"] * MICRO_PER_CENT
        or sum(row["fee_micro_usd"] for row in rows) != purchase["fee_micro_usd"]
    ):
        raise CommerceError("negative_net_acknowledgement_required")
    allocations = [
        [str(row["lot_id"]), row["gross_micro_usd"], row["fee_micro_usd"]] for row in rows
    ]
    return negative_net_review(purchase, allocations)


async def require_negative_net_acknowledgement(
    conn: Any, purchase: dict[str, Any], acknowledgement: dict[str, Any] | None
) -> None:
    review = await read_negative_net_review(conn, purchase)
    if review is None:
        return
    if (
        not isinstance(acknowledgement, dict)
        or set(acknowledgement) != {"version", "binding", "acknowledged"}
        or type(acknowledgement.get("version")) is not int
        or acknowledgement["version"] != 1
        or acknowledgement.get("acknowledged") is not True
        or acknowledgement.get("binding") != review["binding"]
    ):
        raise CommerceError("negative_net_acknowledgement_required")
