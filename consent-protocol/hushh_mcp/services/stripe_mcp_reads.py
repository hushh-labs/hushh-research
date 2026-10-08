"""Closed Stripe account/balance reads; no payment or credential authority.

Only the explicit context/operation profile below is supported. A live provider
schema must accept every fixed argument; undocumented/default account routing
is never treated as proof. Other hosted profiles remain unavailable until reviewed.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from hushh_mcp.services.external_mcp_client import (
    ExternalMcpError,
    schema_is_valid,
)

ACCOUNT_TOOL = "get_stripe_account_info"
BALANCE_TOOL = "stripe_api_read"
ACCOUNT_TOOLS = frozenset({ACCOUNT_TOOL, BALANCE_TOOL})


def stripe_read_arguments(name: str, account_id: str) -> dict[str, Any]:
    if not account_id.startswith("acct_"):
        raise ExternalMcpError("Select the approved Sandbox.", code="MCP_STRIPE_PIN_REQUIRED")
    context: dict[str, Any] = {"stripe_context": account_id, "livemode": False}
    if name == BALANCE_TOOL:
        return {**context, "stripe_api_operation_id": "GetBalance", "parameters": {}}
    if name == ACCOUNT_TOOL:
        return context
    raise ExternalMcpError("Unsupported Stripe read.", code="MCP_STRIPE_READ_ONLY")


def closed_stripe_reads(
    catalog: list[dict[str, Any]], account_id: str
) -> dict[str, dict[str, Any]]:
    """Narrow original names, retaining independent provider-schema validation."""
    if not account_id.startswith("acct_"):
        return {}
    result = {}
    for descriptor in catalog:
        name = descriptor.get("name")
        if name not in ACCOUNT_TOOLS:
            continue
        hints = descriptor.get("annotations")
        schema = descriptor.get("inputSchema")
        arguments = stripe_read_arguments(name, account_id)
        if (
            not isinstance(hints, dict)
            or hints.get("readOnlyHint") is not True
            or hints.get("destructiveHint") is True
            or not isinstance(schema, dict)
            or not schema_is_valid(schema, arguments)
            or not isinstance(schema.get("properties"), dict)
            or not set(arguments).issubset(schema["properties"])
        ):
            continue
        narrowed = deepcopy(descriptor)
        narrowed["inputSchema"] = {
            "type": "object",
            "properties": {key: {"const": value} for key, value in arguments.items()},
            "required": list(arguments),
            "additionalProperties": False,
        }
        result[name] = narrowed
    return result if set(result) == ACCOUNT_TOOLS else {}


def stripe_account_projection(payload: dict[str, Any], account_id: str) -> dict[str, Any]:
    if (
        payload.get("object") != "account"
        or payload.get("id") != account_id
        or not isinstance(payload.get("country"), str)
        or not isinstance(payload.get("default_currency"), str)
        or len(payload["country"]) != 2
        or not payload["country"].isascii()
        or not payload["country"].isalpha()
        or payload["country"] != payload["country"].upper()
        or payload["default_currency"] != "usd"
        or type(payload.get("charges_enabled")) is not bool
        or type(payload.get("payouts_enabled")) is not bool
    ):
        raise ExternalMcpError(
            "Stripe account could not be verified.", code="MCP_STRIPE_ACCOUNT_MISMATCH"
        )
    return {
        "accountId": account_id,
        "country": payload["country"],
        "defaultCurrency": payload["default_currency"],
        "chargesEnabled": payload["charges_enabled"],
        "payoutsEnabled": payload["payouts_enabled"],
    }


def _usd_amount(rows: Any) -> int:
    if not isinstance(rows, list):
        raise ExternalMcpError("Stripe balance unavailable.", code="MCP_STRIPE_RECEIPT_INVALID")
    usd = [row for row in rows if isinstance(row, dict) and row.get("currency") == "usd"]
    if len(usd) != 1 or type(usd[0].get("amount")) is not int:
        raise ExternalMcpError("Stripe balance unavailable.", code="MCP_STRIPE_RECEIPT_INVALID")
    amount = usd[0]["amount"]
    if abs(amount) > 2**53 - 1:
        raise ExternalMcpError("Stripe balance unavailable.", code="MCP_STRIPE_RECEIPT_INVALID")
    return int(amount)


def stripe_balance_projection(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("object") != "balance" or payload.get("livemode") is not False:
        raise ExternalMcpError(
            "Select the approved Sandbox.", code="MCP_STRIPE_ENVIRONMENT_MISMATCH"
        )
    return {
        "currency": "usd",
        "livemode": False,
        "availableCents": _usd_amount(payload.get("available")),
        "pendingCents": _usd_amount(payload.get("pending")),
    }


def stripe_read_projection(name: str, payload: dict[str, Any], account_id: str) -> dict[str, Any]:
    if name == ACCOUNT_TOOL:
        return stripe_account_projection(payload, account_id)
    if name == BALANCE_TOOL:
        return stripe_balance_projection(payload)
    raise ExternalMcpError("Unsupported Stripe read.", code="MCP_STRIPE_READ_ONLY")
