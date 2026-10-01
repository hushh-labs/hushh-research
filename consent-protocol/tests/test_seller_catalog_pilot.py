"""The private Shopify pilot never becomes a buyer-facing catalog."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import seller_catalog_pilot as routes
from hushh_mcp.services.seller_catalog_pilot import (
    PilotConfigurationError,
    PilotSettings,
    fetch_shopify_pilot_preview,
)


def _settings() -> PilotSettings:
    return PilotSettings(
        owner_uid="pilot-owner",
        shop_domain="example-shop.myshopify.com",
        client_id="test-client",
        client_secret="test-secret",  # noqa: S106 - synthetic MockTransport fixture
        product_ids=("gid://shopify/Product/101", "gid://shopify/Product/102"),
    )


@pytest.mark.asyncio
async def test_shopify_preview_projects_only_configured_items_and_blocks_drafts():
    seen_ids = []

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "synthetic-token"})
        assert request.url.host == "example-shop.myshopify.com"
        assert request.headers["X-Shopify-Access-Token"] == "synthetic-token"
        seen_ids.extend(json.loads(request.content)["variables"]["ids"])
        return httpx.Response(
            200,
            json={
                "data": {
                    "nodes": [
                        {
                            "id": "gid://shopify/Product/101",
                            "title": "Pilot phone",
                            "handle": "pilot-phone",
                            "description": "Technical sample",
                            "productType": "Phone",
                            "vendor": "Sample",
                            "status": "ACTIVE",
                            "updatedAt": "2026-10-02T00:00:00Z",
                            "onlineStoreUrl": None,
                            "featuredMedia": None,
                            "priceRangeV2": {"minVariantPrice": {"currencyCode": "USD"}},
                            "variants": {
                                "nodes": [{"id": "gid://shopify/ProductVariant/201", "title": "Default Title", "sku": "T-1", "price": "10.00", "inventoryQuantity": 5}],
                                "pageInfo": {"hasNextPage": False},
                            },
                        },
                        {
                            "id": "gid://shopify/Product/102",
                            "title": "Draft tablet",
                            "status": "DRAFT",
                            "priceRangeV2": {"minVariantPrice": {"currencyCode": "USD"}},
                            "variants": {"nodes": [], "pageInfo": {"hasNextPage": False}},
                        },
                    ]
                }
            },
        )

    preview = await fetch_shopify_pilot_preview(
        _settings(), transport=httpx.MockTransport(respond)
    )
    assert seen_ids == list(_settings().product_ids)
    assert preview["mode"] == "technical_preview"
    assert preview["customerVisible"] is False
    assert preview["items"][0]["state"] == "needs_seller_review"
    assert preview["items"][0]["variants"][0]["label"] is None
    assert preview["items"][1]["state"] == "source_not_active"


def test_pilot_configuration_fails_closed(monkeypatch):
    monkeypatch.setenv("HUSHH_SELLER_PILOT_OWNER_UID", "pilot-owner")
    monkeypatch.setenv("HUSHH_SHOPIFY_PILOT_SHOP", "attacker.example")
    monkeypatch.setenv("HUSHH_SHOPIFY_PILOT_CLIENT_ID", "test-client")
    monkeypatch.setenv("HUSHH_SHOPIFY_PILOT_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("HUSHH_SHOPIFY_PILOT_PRODUCT_IDS", "gid://shopify/Product/101")
    with pytest.raises(PilotConfigurationError):
        PilotSettings.from_environment()


def test_preview_requires_exact_configured_owner(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "other-owner"}
    monkeypatch.setattr(routes.PilotSettings, "from_environment", _settings)
    with TestClient(app) as client:
        response = client.get("/api/one/seller-catalog/pilot/preview")
    assert response.status_code == 403

    app.dependency_overrides[require_vault_owner_token] = lambda: (_ for _ in ()).throw(
        HTTPException(status_code=401)
    )
    with TestClient(app) as client:
        response = client.get("/api/one/seller-catalog/pilot/preview")
    assert response.status_code == 401
