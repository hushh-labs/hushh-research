"""Plaid Link product selection, read from the PLAID_*_PRODUCTS environment.

Moved verbatim from the retired server-custody portfolio service so the
zero-knowledge pass-through (api/routes/kai/plaid_vault.py) keeps the same
product sets.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_PLAID_PRIMARY_PRODUCT_ALLOWLIST = {
    "assets",
    "auth",
    "identity",
    "investments",
    "liabilities",
    "signal",
    "transactions",
    "transfer",
}
_PLAID_REQUIRED_IF_SUPPORTED_ALLOWLIST = {
    "auth",
    "identity",
    "investments",
    "liabilities",
    "signal",
    "transactions",
}
_PLAID_ADDITIONAL_CONSENTED_ALLOWLIST = {
    "auth",
    "balance_plus",
    "identity",
    "investments",
    "investments_auth",
    "liabilities",
    "signal",
    "transactions",
}
_PLAID_DEFAULT_PRIMARY_PRODUCTS = ("transactions",)
_PLAID_DEFAULT_REQUIRED_IF_SUPPORTED_PRODUCTS = ("investments",)
_PLAID_DEFAULT_ADDITIONAL_CONSENTED_PRODUCTS = ("identity",)
_PLAID_NEVER_REQUIRED_PRODUCTS = {"investments", "liabilities"}


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    if not text:
        return default
    return text


def _csv_products(
    env_name: str,
    *,
    default: tuple[str, ...],
    allowlist: set[str],
) -> list[str]:
    raw = _clean_text(os.getenv(env_name))
    requested = raw.split(",") if raw else list(default)
    accepted: list[str] = []
    rejected: list[str] = []
    for product in requested:
        normalized = _clean_text(product).lower()
        if not normalized:
            continue
        if normalized in allowlist:
            accepted.append(normalized)
        else:
            rejected.append(normalized)
    if rejected:
        logger.warning("plaid.products_ignored env=%s products=%s", env_name, rejected)
    unique = list(dict.fromkeys(accepted))
    return unique or list(default)


def _link_token_product_sets() -> tuple[list[str], list[str], list[str]]:
    primary_products = _csv_products(
        "PLAID_PRIMARY_PRODUCTS",
        default=_PLAID_DEFAULT_PRIMARY_PRODUCTS,
        allowlist=_PLAID_PRIMARY_PRODUCT_ALLOWLIST,
    )
    forced_if_supported = [
        product for product in primary_products if product in _PLAID_NEVER_REQUIRED_PRODUCTS
    ]
    primary_products = [
        product for product in primary_products if product not in _PLAID_NEVER_REQUIRED_PRODUCTS
    ]
    if not primary_products:
        primary_products = list(_PLAID_DEFAULT_PRIMARY_PRODUCTS)

    required_if_supported = _csv_products(
        "PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS",
        default=_PLAID_DEFAULT_REQUIRED_IF_SUPPORTED_PRODUCTS,
        allowlist=_PLAID_REQUIRED_IF_SUPPORTED_ALLOWLIST,
    )
    required_if_supported = [
        product
        for product in [*required_if_supported, *forced_if_supported]
        if product not in primary_products
    ]
    required_if_supported = list(dict.fromkeys(required_if_supported))

    additional_consented = _csv_products(
        "PLAID_ADDITIONAL_CONSENTED_PRODUCTS",
        default=_PLAID_DEFAULT_ADDITIONAL_CONSENTED_PRODUCTS,
        allowlist=_PLAID_ADDITIONAL_CONSENTED_ALLOWLIST,
    )
    additional_consented = [
        product
        for product in additional_consented
        if product not in primary_products and product not in required_if_supported
    ]
    additional_consented = list(dict.fromkeys(additional_consented))
    return primary_products, required_if_supported, additional_consented
