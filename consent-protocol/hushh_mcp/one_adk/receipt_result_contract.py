"""Closed receipt function contract shared by hub validation and tool admission.

The owner's device declares these functions and runs them over its own
encrypted snapshot. The hub admits only the exact declared parameter schemas,
serves its own descriptions to the model, and accepts only the closed
unavailable variants the device sends. Keep in step with
hushh-webapp/lib/mail/receipt-analysis.ts and receipt-availability.ts.
"""

from __future__ import annotations

from typing import Any, Final

# Mirrors the snapshot's attention_state: overdue, failed or suspended payments,
# or renewals due. One chooses the filter; host code never infers it.
RECEIPT_ATTENTION: Final = ("needs_attention", "coming_up")
_GROUPED: Final = frozenset({"receipt_spending", "highest_receipt_spend"})
_RANGE_RULE: Final = (
    "from_date is inclusive and to_date exclusive (YYYY-MM-DD). "
    "Pass timezone exactly as the instruction gives it."
)
RECEIPT_FUNCTION_DESCRIPTIONS: Final = {
    "list_recent_receipts": (
        "List synced receipts, newest first, each with its status such as paid, overdue or "
        f"payment_failed. {_RANGE_RULE} Each date is the receipt's date when readable, "
        "otherwise the email's date."
    ),
    "receipt_spending": (
        "Spending totals, computed on device from synced receipts and grouped by merchant "
        f"or category. {_RANGE_RULE} currency_totals gives one exact total per currency; "
        "never add currencies together. group_by product is unsupported."
    ),
    "highest_receipt_spend": (
        "Rank merchants or categories by spending within each currency, computed on device "
        f"from synced receipts. {_RANGE_RULE} group_by product is unsupported."
    ),
    "most_frequently_purchased_products": (
        f"Product purchase counts are not available yet; this returns unsupported. {_RANGE_RULE}"
    ),
}
# The device classifies a failed snapshot read; each code carries one sentence.
RECEIPT_UNAVAILABLE_LIMITATIONS: Final = {
    "gmail_not_connected": "Gmail isn't connected. Connect Gmail so One can read your receipts.",
    "receipts_not_synced": (
        "Receipts haven't synced to this device yet. Open Mail receipts to sync, then ask again."
    ),
    "receipt_snapshot_unavailable": (
        "The owner receipt snapshot could not be read. Sync Mail Receipts and ask again."
    ),
}


def receipt_parameters(name: str, *, attention: bool = False) -> dict:
    """The exact parameter schema the device declares for ``name``.

    Expand phase: the hub admits the ``attention`` list filter, but clients keep
    declaring the pre-attention schema until every hub and owner pod accepts it;
    an owner pod on older code refuses any schema it does not know.
    """
    grouped = name in _GROUPED
    properties: dict[str, Any] = {
        "from_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
        "to_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
        "timezone": {"type": "string", "maxLength": 80},
        "limit": {"type": "integer", "minimum": 1, "maximum": 25},
    }
    if grouped:
        properties["group_by"] = {"type": "string", "enum": ["merchant", "category", "product"]}
    if attention and name == "list_recent_receipts":
        properties["attention"] = {"type": "string", "enum": list(RECEIPT_ATTENTION)}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["from_date", "to_date", "timezone"] + (["group_by"] if grouped else []),
        "properties": properties,
    }


def admitted_receipt_parameters(name: str) -> tuple[dict, ...]:
    """The declared schema, plus the attention list schema a later client will send."""
    declared, filtered = receipt_parameters(name), receipt_parameters(name, attention=True)
    return (declared,) if declared == filtered else (declared, filtered)


def unavailable_receipt_result(name: str, request: dict, code: str) -> dict:
    """The exact result the device sends when its snapshot read fails with ``code``."""
    return {
        "schema": "receipt_analysis.v1",
        "operation": name,
        "status": "unavailable",
        "code": code,
        "requested_range": {
            "from": request["from_date"],
            "to": request["to_date"],
            "end_exclusive": True,
            "timezone": request["timezone"],
        },
        "source_freshness": None,
        "snapshot_revision": None,
        "canonical_transaction_count": None,
        "matched_count": None,
        "included_count": None,
        "coverage": None,
        "truncated": False,
        "dedupe_policy": "Mail canonical groups; one transaction per saved group",
        "refund_handling": {
            "record_count": None,
            "amount": None,
            "net": None,
            "policy": "Refund evidence unavailable.",
        },
        "cancellation_handling": "Unpaid, failed, cancelled and trial records are excluded from paid totals.",
        "limitations": [RECEIPT_UNAVAILABLE_LIMITATIONS[code]],
        "results": [],
    }


def is_unavailable_receipt_result(name: str, request: dict, value: Any) -> bool:
    """True only for one closed code paired with its exact sentence and empty evidence."""
    code = value.get("code") if isinstance(value, dict) else None
    return (
        isinstance(code, str)
        and code in RECEIPT_UNAVAILABLE_LIMITATIONS
        and value == unavailable_receipt_result(name, request, code)
    )
