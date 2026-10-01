"""Read-only Shopify catalog projection for the internal seller pilot.

This is deliberately not the personal-information Marketplace or a customer
catalog. A configured One owner can inspect a bounded set of Shopify products;
every result remains a private technical preview until seller authority and
commercial review have separate contracts.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

_SHOP_DOMAIN = re.compile(r"^[a-z0-9][a-z0-9-]*\.myshopify\.com$")
_PRODUCT_GID = re.compile(r"^gid://shopify/Product/[1-9][0-9]*$")

_PRODUCTS_QUERY = """
query SellerCatalogPilot($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id
      title
      handle
      description
      productType
      vendor
      status
      updatedAt
      onlineStoreUrl
      featuredMedia {
        ... on MediaImage { image { url altText } }
      }
      priceRangeV2 { minVariantPrice { currencyCode } }
      variants(first: 20) {
        nodes { id title sku price inventoryQuantity }
        pageInfo { hasNextPage }
      }
    }
  }
}
"""


class PilotConfigurationError(Exception):
    """The internal pilot cannot run with its current server configuration."""


class ShopifyReadError(Exception):
    """Shopify did not provide a complete, trusted response."""


@dataclass(frozen=True, repr=False)
class PilotSettings:
    owner_uid: str
    shop_domain: str
    client_id: str
    client_secret: str
    product_ids: tuple[str, ...]

    @classmethod
    def from_environment(cls) -> PilotSettings:
        owner_uid = os.getenv("HUSHH_SELLER_PILOT_OWNER_UID", "").strip()
        shop_domain = os.getenv("HUSHH_SHOPIFY_PILOT_SHOP", "").strip().lower()
        client_id = os.getenv("HUSHH_SHOPIFY_PILOT_CLIENT_ID", "").strip()
        client_secret = os.getenv("HUSHH_SHOPIFY_PILOT_CLIENT_SECRET", "").strip()
        raw_ids = os.getenv("HUSHH_SHOPIFY_PILOT_PRODUCT_IDS", "")
        product_ids = tuple(item.strip() for item in raw_ids.split(",") if item.strip())
        if not all((owner_uid, shop_domain, client_id, client_secret, product_ids)):
            raise PilotConfigurationError("Seller catalog pilot is not configured.")
        if not _SHOP_DOMAIN.fullmatch(shop_domain):
            raise PilotConfigurationError("Seller catalog pilot shop is invalid.")
        if len(product_ids) > 10 or len(set(product_ids)) != len(product_ids):
            raise PilotConfigurationError("Seller catalog pilot product set is invalid.")
        if any(not _PRODUCT_GID.fullmatch(item) for item in product_ids):
            raise PilotConfigurationError("Seller catalog pilot product set is invalid.")
        return cls(owner_uid, shop_domain, client_id, client_secret, product_ids)


def _project_product(requested_id: str, node: Any) -> dict[str, Any]:
    if not isinstance(node, dict) or node.get("id") != requested_id:
        return {"sourceProductId": requested_id, "state": "source_missing"}
    variants = node.get("variants")
    if not isinstance(variants, dict):
        raise ShopifyReadError("Shopify variant projection is incomplete.")
    page_info = variants.get("pageInfo")
    if not isinstance(page_info, dict) or page_info.get("hasNextPage") is not False:
        raise ShopifyReadError("Shopify variant projection is incomplete.")
    variant_nodes = variants.get("nodes")
    if not isinstance(variant_nodes, list):
        raise ShopifyReadError("Shopify variant projection is incomplete.")
    price_range = node.get("priceRangeV2")
    min_price = price_range.get("minVariantPrice") if isinstance(price_range, dict) else None
    currency = min_price.get("currencyCode") if isinstance(min_price, dict) else None
    if not isinstance(currency, str) or not currency:
        raise ShopifyReadError("Shopify currency is unavailable.")
    projected_variants = []
    for variant in variant_nodes:
        if not isinstance(variant, dict) or not isinstance(variant.get("id"), str):
            raise ShopifyReadError("Shopify variant projection is invalid.")
        projected_variants.append(
            {
                "sourceVariantId": variant["id"],
                "label": None if variant.get("title") == "Default Title" else variant.get("title"),
                "sku": variant.get("sku"),
                "recordedPrice": str(variant.get("price", "")),
                "recordedInventory": variant.get("inventoryQuantity"),
            }
        )
    featured_media = node.get("featuredMedia")
    image = featured_media.get("image") if isinstance(featured_media, dict) else None
    if not isinstance(image, dict):
        image = {}
    status = str(node.get("status") or "UNKNOWN")
    return {
        "sourceProductId": requested_id,
        "sourceUpdatedAt": node.get("updatedAt"),
        "title": node.get("title"),
        "description": node.get("description"),
        "vendor": node.get("vendor"),
        "productType": node.get("productType"),
        "sourceStatus": status,
        "sourceHandle": node.get("handle"),
        "sourceUrl": node.get("onlineStoreUrl"),
        "imageUrl": image.get("url"),
        "imageAlt": image.get("altText"),
        "currency": currency,
        "variants": projected_variants,
        "state": "needs_seller_review" if status == "ACTIVE" else "source_not_active",
    }


async def fetch_shopify_pilot_preview(
    settings: PilotSettings, *, transport: httpx.AsyncBaseTransport | None = None
) -> dict[str, Any]:
    """Fetch only configured product IDs; never send prices to a buyer channel."""
    base = f"https://{settings.shop_domain}"
    try:
        async with httpx.AsyncClient(timeout=15, transport=transport) as client:
            token_response = await client.post(
                f"{base}/admin/oauth/access_token",
                data={
                    "client_id": settings.client_id,
                    "client_secret": settings.client_secret,
                    "grant_type": "client_credentials",
                },
            )
            token_response.raise_for_status()
            token_payload = token_response.json()
            access_token = token_payload.get("access_token") if isinstance(token_payload, dict) else None
            if not isinstance(access_token, str) or not access_token:
                raise ShopifyReadError("Shopify token response is invalid.")
            response = await client.post(
                f"{base}/admin/api/2026-10/graphql.json",
                headers={"X-Shopify-Access-Token": access_token},
                json={"query": _PRODUCTS_QUERY, "variables": {"ids": settings.product_ids}},
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ShopifyReadError("Shopify catalog read failed.") from exc
    if not isinstance(payload, dict) or payload.get("errors"):
        raise ShopifyReadError("Shopify catalog read failed.")
    data = payload.get("data")
    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, list) or len(nodes) != len(settings.product_ids):
        raise ShopifyReadError("Shopify catalog response is incomplete.")
    return {
        "mode": "technical_preview",
        "source": "shopify",
        "shopDomain": settings.shop_domain,
        "customerVisible": False,
        "items": [
            _project_product(product_id, node)
            for product_id, node in zip(settings.product_ids, nodes, strict=True)
        ],
    }
