"""Closed receipt function contract: unavailable variants, list attention and ISO list days."""

from __future__ import annotations

import os
import re
from pathlib import Path

os.environ.setdefault("TESTING", "true")
os.environ.setdefault("DB_OFFLINE", "1")
os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

import pytest
from ag_ui.core import Tool

from hushh_mcp.one_adk.receipt_client_tools import (
    receipt_tool_declaration,
    validate_request,
    validate_result,
)
from hushh_mcp.one_adk.receipt_result_contract import (
    RECEIPT_UNAVAILABLE_LIMITATIONS,
    receipt_parameters,
    unavailable_receipt_result,
)
from hushh_mcp.one_adk.receipt_turn_admission import admit_receipt_tool

LIST = "list_recent_receipts"
REQUEST = {"from_date": "2026-10-01", "to_date": "2026-11-01", "timezone": "UTC", "limit": 10}
DEVICE_SOURCE = (
    Path(__file__).resolve().parents[2] / "hushh-webapp/lib/mail/receipt-availability.ts"
)


@pytest.mark.parametrize("code", sorted(RECEIPT_UNAVAILABLE_LIMITATIONS))
def test_unavailable_results_are_one_closed_code_with_its_exact_sentence(code):
    result = unavailable_receipt_result(LIST, REQUEST, code)
    assert validate_result(LIST, REQUEST, result) == result
    other = next(text for key, text in RECEIPT_UNAVAILABLE_LIMITATIONS.items() if key != code)
    for forged in ({**result, "code": "gmail_disconnected"}, {**result, "limitations": [other]}):
        with pytest.raises(ValueError):
            validate_result(LIST, REQUEST, forged)


def test_device_sends_the_same_unavailable_sentences():
    block = DEVICE_SOURCE.read_text().split("RECEIPT_UNAVAILABLE_LIMITATIONS = {", 1)[1]
    device = dict(re.findall(r'^\s+(\w+): "([^"]+)",$', block.split("}", 1)[0], re.MULTILINE))
    assert device == RECEIPT_UNAVAILABLE_LIMITATIONS


def test_attention_is_a_closed_list_filter_and_older_clients_stay_admitted():
    assert validate_request(LIST, {**REQUEST, "attention": "coming_up"})["attention"] == "coming_up"
    for name, value in (
        (LIST, {**REQUEST, "attention": "overdue"}),
        (LIST, {**REQUEST, "attention": None}),
        ("receipt_spending", {**REQUEST, "group_by": "merchant", "attention": "needs_attention"}),
    ):
        with pytest.raises(ValueError):
            validate_request(name, value)
    for parameters in (receipt_parameters(LIST), receipt_parameters(LIST, attention=False)):
        tool = Tool(name=LIST, description="client copy", parameters=parameters)
        assert admit_receipt_tool(tool)
        assert tool.description == receipt_tool_declaration(LIST)["description"]
    altered = receipt_parameters(LIST, attention=True)
    altered["properties"]["attention"]["enum"].append("overdue")
    with pytest.raises(ValueError):
        admit_receipt_tool(Tool(name=LIST, description="client copy", parameters=altered))
    with pytest.raises(ValueError):
        admit_receipt_tool(
            Tool(name="receipt_spending", description="x", parameters=receipt_parameters(LIST))
        )


def test_list_results_carry_iso_days_and_printed_dates_stay_refused():
    row = {
        "ref": "a" * 64,
        "merchant": "Synthetic shop",
        "category": "Bills",
        "status": "overdue",
        "transaction_date": "2026-10-09",
        "amount": "12.50",
        "currency": "USD",
        "identifiers": [{"kind": "invoice", "value": "INV-1"}],
    }
    result = {
        "schema": "receipt_analysis.v1",
        "operation": LIST,
        "status": "ok",
        "requested_range": {
            "from": "2026-10-01",
            "to": "2026-11-01",
            "end_exclusive": True,
            "timezone": "UTC",
        },
        "source_freshness": "2026-10-20T00:00:00.000Z",
        "snapshot_revision": 1,
        "canonical_transaction_count": 1,
        "matched_count": 1,
        "included_count": 1,
        "coverage": {
            "partial": False,
            "truncated": False,
            "source_count": 1,
            "window_from": "2025-10-20T00:00:00+00:00",
            "window_to": None,
            "source": "gmail_live",
            "undated_count": 0,
            "excluded_from_paid_count": 1,
        },
        "truncated": False,
        "dedupe_policy": "Mail canonical groups",
        "refund_handling": {"record_count": 0, "amount": None, "net": None, "policy": "Separate."},
        "cancellation_handling": "Unpaid records excluded.",
        "limitations": ["Receipts only go back to 2025-10-20; earlier purchases are not included."],
        "results": [row],
    }
    assert validate_result(LIST, REQUEST, result) == result
    # Negative control: the printed date the device used to send is refused.
    row["transaction_date"] = "October 9, 2026"
    with pytest.raises(ValueError):
        validate_result(LIST, REQUEST, result)
