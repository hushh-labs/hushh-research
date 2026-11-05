"""Stateless reads for the owner-authorized Plaid vault snapshot."""

import asyncio
import logging
import os
from typing import Any

from hushh_mcp.integrations.plaid import PlaidApiError, PlaidHttpClient

logger = logging.getLogger("api.routes.kai.plaid_vault")
_ITEM_ERROR_MESSAGE = "The linked connection needs attention."

# Transactions sync pages at most this many times per snapshot; the device
# resumes from the returned cursor on its next unlock.
TRANSACTIONS_SYNC_MAX_PAGES = 10
_TRANSACTIONS_SYNC_PAGE_SIZE = 500

# Plaid error codes that mean "this product is not available for this Item"
# rather than a failure. They come back as ``{"unavailable": code}``.
_PRODUCT_UNAVAILABLE_CODES = frozenset(
    {
        "ADDITIONAL_CONSENT_REQUIRED",
        "INVALID_PRODUCT",
        "ITEM_PRODUCT_NOT_READY",
        "NO_ACCOUNTS",
        "NO_INVESTMENT_ACCOUNTS",
        "NO_INVESTMENT_AUTH_ACCOUNTS",
        "PRODUCT_NOT_ENABLED",
        "PRODUCT_NOT_READY",
        "PRODUCT_NOT_SUPPORTED",
        "PRODUCTS_NOT_SUPPORTED",
    }
)
_PRODUCT_NOT_ON_ITEM = "PRODUCTS_NOT_SUPPORTED"
# A snapshot for one of these returns 200 with ``item.error`` (see vault_snapshot).
_DEAD_ACCESS_TOKEN_CODES = frozenset({"INVALID_ACCESS_TOKEN"})


def clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in (clean_string(entry) for entry in value) if item]


def _item_error(error: Any) -> dict[str, str | None] | None:
    if not isinstance(error, dict):
        return None
    code = clean_string(error.get("error_code"))
    if not code:
        return None
    return {
        "code": code,
        "message": clean_string(error.get("display_message")) or _ITEM_ERROR_MESSAGE,
    }


def _item_error_from_exception(error: PlaidApiError) -> dict[str, str | None]:
    return {
        "code": error.error_code or "ITEM_ERROR",
        "message": error.display_message or _ITEM_ERROR_MESSAGE,
    }


def _is_item_error(error: PlaidApiError) -> bool:
    return (error.error_type or "") == "ITEM_ERROR"


def _is_connection_state(error: PlaidApiError) -> bool:
    """A Plaid verdict on the sealed connection, not on the request's shape.

    The request already passed validation, so ``INVALID_ACCESS_TOKEN`` means
    this token cannot be used by this deployment's Plaid client (for example a
    token sealed against the Sandbox, read from UAT). Like an item error it is
    the connection's state, which the device must record rather than retry.
    """
    return _is_item_error(error) or (error.error_code or "") in _DEAD_ACCESS_TOKEN_CODES


def item_products(item: dict[str, Any]) -> list[str]:
    products = [*string_list(item.get("products")), *string_list(item.get("billed_products"))]
    return list(dict.fromkeys(products))


def log_plaid_failure(route: str, error: PlaidApiError, http_status: int | None = None) -> None:
    """Log a Plaid failure by code only. Never the message, payload or token."""
    logger.warning(
        "kai.plaid_vault.%s_failed code=%s type=%s status=%s",
        route,
        error.error_code or "PLAID_API_ERROR",
        error.error_type or "API_ERROR",
        http_status if http_status is not None else error.status_code,
    )


async def _fetch_investments(
    client: PlaidHttpClient, access_token: str
) -> tuple[dict[str, Any], dict[str, str | None] | None]:
    try:
        response = await client.post("/investments/holdings/get", {"access_token": access_token})
    except PlaidApiError as exc:
        if _is_item_error(exc) and (exc.error_code or "") not in _PRODUCT_UNAVAILABLE_CODES:
            return {"unavailable": exc.error_code or "ITEM_ERROR"}, _item_error_from_exception(exc)
        if (exc.error_code or "") in _PRODUCT_UNAVAILABLE_CODES:
            return {"unavailable": exc.error_code}, None
        raise
    holdings = response.get("holdings")
    securities = response.get("securities")
    if not isinstance(holdings, list):
        return {"unavailable": "INCOMPLETE_HOLDINGS"}, None
    return {
        "holdings": holdings,
        "securities": securities if isinstance(securities, list) else [],
    }, None


async def _sync_transactions(
    client: PlaidHttpClient, access_token: str, cursor: str | None, *, continuation: bool = False
) -> tuple[dict[str, Any], dict[str, str | None] | None]:
    restarted = False
    while True:
        added: list[Any] = []
        modified: list[Any] = []
        removed: list[Any] = []
        next_cursor = cursor
        pages = 0
        update_status = None
        has_more = True
        try:
            while has_more and pages < TRANSACTIONS_SYNC_MAX_PAGES:
                request: dict[str, Any] = {
                    "access_token": access_token,
                    "count": _TRANSACTIONS_SYNC_PAGE_SIZE,
                }
                if next_cursor:
                    request["cursor"] = next_cursor
                page = await client.post("/transactions/sync", request)
                pages += 1
                for bucket, key in ((added, "added"), (modified, "modified"), (removed, "removed")):
                    values = page.get(key)
                    if isinstance(values, list):
                        bucket.extend(values)
                next_cursor = clean_string(page.get("next_cursor")) or next_cursor
                has_more = bool(page.get("has_more"))
                update_status = (
                    clean_string(page.get("transactions_update_status")) or update_status
                )
        except PlaidApiError as exc:
            code = exc.error_code or ""
            if code == "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION":
                # Only the caller has the original cursor across snapshot requests.
                if continuation or restarted:
                    return {"unavailable": code}, None
                restarted = True
                continue
            if code in _PRODUCT_UNAVAILABLE_CODES:
                return {"unavailable": code}, None
            if _is_item_error(exc):
                return {"unavailable": code or "ITEM_ERROR"}, _item_error_from_exception(exc)
            raise
        return {
            "added": added,
            "modified": modified,
            "removed": removed,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "pages": pages,
            **({"transactions_update_status": update_status} if update_status else {}),
        }, None


async def _read_products(
    client: PlaidHttpClient,
    access_token: str,
    item: dict[str, Any],
    available_products: Any,
    cursor: str | None,
    continuation: bool,
) -> tuple[dict, dict, dict | None]:
    products = set(item["products"])
    liabilities_enabled = os.getenv("PLAID_NWS_LIABILITIES_ENABLED") == "true"
    if liabilities_enabled and isinstance(available_products, list):
        item["nws_debt_details_available"] = (
            "liabilities" in available_products or "liabilities" in products
        )
    if "investments" in products:
        item["nws_investments_available"] = True
    elif isinstance(available_products, list):
        item["nws_investments_available"] = "investments" in available_products

    async def investments_read():
        if "investments" in products:
            return await _fetch_investments(client, access_token)
        return {"unavailable": _PRODUCT_NOT_ON_ITEM}, None

    async def transactions_read():
        if "transactions" in products:
            return await _sync_transactions(
                client,
                access_token,
                cursor,
                continuation=continuation,
            )
        return {"unavailable": _PRODUCT_NOT_ON_ITEM}, None

    async def liability_read():
        if not liabilities_enabled or not (
            "liabilities" in products or "liabilities" in item["consented_products"]
        ):
            return None
        try:
            response = await client.post("/liabilities/get", {"access_token": access_token})
        except PlaidApiError as exc:
            log_plaid_failure("snapshot_liabilities", exc)
            return None
        liabilities = response.get("liabilities")
        if not isinstance(liabilities, dict):
            return None
        return {
            "credit": [
                {
                    "account_id": record.get("account_id"),
                    "aprs": [
                        {"apr_percentage": apr.get("apr_percentage")}
                        for apr in (record.get("aprs") or [])
                        if isinstance(apr, dict)
                    ],
                }
                for record in (liabilities.get("credit") or [])
                if isinstance(record, dict) and isinstance(record.get("account_id"), str)
            ],
        }

    (
        (investments, investments_error),
        (transactions, transactions_error),
        liabilities,
    ) = await asyncio.gather(investments_read(), transactions_read(), liability_read())
    item["error"] = investments_error or transactions_error
    return investments, transactions, liabilities


def _blocked_snapshot(item: dict[str, Any]) -> dict[str, Any]:
    blocked = {"unavailable": item["error"]["code"]}
    return {
        "item": item,
        "accounts": [],
        "investments": dict(blocked),
        "transactions": dict(blocked),
    }


async def read_vault_snapshot(
    client: PlaidHttpClient,
    access_token: str,
    cursor: str | None,
    *,
    continuation: bool = False,
) -> dict[str, Any]:
    try:
        item_response = await client.post("/item/get", {"access_token": access_token})
    except PlaidApiError as exc:
        if not _is_connection_state(exc):
            raise
        log_plaid_failure("snapshot_item", exc, 200)
        error = _item_error_from_exception(exc)
        return _blocked_snapshot(
            {
                "item_id": None,
                "institution_id": None,
                "products": [],
                "consented_products": [],
                "error": error,
            }
        )
    raw = item_response.get("item")
    item_raw = raw if isinstance(raw, dict) else {}
    item: dict[str, Any] = {
        "item_id": clean_string(item_raw.get("item_id")),
        "institution_id": clean_string(item_raw.get("institution_id")),
        "products": item_products(item_raw),
        "consented_products": string_list(item_raw.get("consented_products")),
        "error": _item_error(item_raw.get("error")),
    }

    if item["error"] is not None:
        return _blocked_snapshot(item)

    try:
        accounts_response = await client.post("/accounts/get", {"access_token": access_token})
    except PlaidApiError as exc:
        if not _is_item_error(exc):
            raise
        item["error"] = _item_error_from_exception(exc)
        return _blocked_snapshot(item)
    accounts = accounts_response.get("accounts")
    if not isinstance(accounts, list):
        raise PlaidApiError(
            message="Plaid returned an incomplete accounts response.",
            status_code=502,
            error_code="INCOMPLETE_ACCOUNTS",
        )

    investments, transactions, liabilities = await _read_products(
        client,
        access_token,
        item,
        item_raw.get("available_products"),
        cursor,
        continuation,
    )
    return {
        "item": item,
        "accounts": accounts,
        "investments": investments,
        "transactions": transactions,
        **({"liabilities": liabilities} if liabilities is not None else {}),
    }
