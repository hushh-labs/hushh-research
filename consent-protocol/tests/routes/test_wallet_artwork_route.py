import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.wallet_card_access import router

ROOT = "/api/one/wallet/card-access/artwork"


def test_bank_design_browse_is_owner_only_and_never_accepts_card_credentials():
    assert client("foreign").post(ROOT + "/banks", json={"network": "visa"}).status_code == 403
    response = client().post(ROOT + "/banks", json={"network": "mastercard", "country": "IN"})
    assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
    body = response.json()
    assert body["selectionBasis"] == "owner_selected_bank" and body["requiresConfirmation"]
    bank = next(row for row in body["banks"] if row["name"] == "HDFC Bank")
    designs = (
        client()
        .post(
            ROOT + "/banks",
            json={"network": "mastercard", "country": "IN", "bankKey": bank["bankKey"]},
        )
        .json()
    )
    assert len(designs["variants"]) == bank["designCount"] == 3 and "match" not in designs
    for field in ["pan", "iinPrefix", "cvv", "pin", "cardholderName", "photo", "vaultKey"]:
        denied = client().post(ROOT + "/banks", json={"network": "visa", field: "4242424242424242"})
        assert denied.status_code == 422 and "4242424242424242" not in denied.text


def client(owner="owner"):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": owner}
    return TestClient(app)


def test_lookup_is_private_and_has_honest_unconfigured_fallback(monkeypatch):
    monkeypatch.delenv("HUSHH_WALLET_ARTWORK_CATALOG_PATH", raising=False)
    response = client().post(ROOT + "/resolve", json={"iinPrefix": "42424200", "panLength": 16})
    assert response.status_code == 200 and response.json()["provider"] == "unconfigured"
    assert response.headers["cache-control"] == "private, no-store"
    assert "424242" not in response.text


@pytest.mark.parametrize("field", ["pan", "cardholderName", "photo", "expiry", "cvv", "pin"])
def test_details_and_photos_are_not_accepted_or_echoed(field):
    value = "4242424242424242"
    response = client().post(
        ROOT + "/resolve", json={"iinPrefix": "424242", "panLength": 16, field: value}
    )
    assert response.status_code == 422 and value not in response.text
    assert response.headers["cache-control"] == "private, no-store"


def test_full_number_prefix_and_foreign_owner_are_refused():
    response = client().post(
        ROOT + "/resolve", json={"iinPrefix": "4242424242424242", "panLength": 16}
    )
    assert response.status_code == 422 and "4242424242424242" not in response.text
    assert (
        client("foreign")
        .post(ROOT + "/resolve", json={"iinPrefix": "424242", "panLength": 16})
        .status_code
        == 403
    )
    assert client("foreign").get(ROOT + "/assets/" + "a" * 64).status_code == 403


def test_validation_batch_fits_the_private_body_cap_and_refuses_extra_rows(monkeypatch):
    import json

    monkeypatch.delenv("HUSHH_WALLET_ARTWORK_CATALOG_PATH", raising=False)
    row = {
        key: "a" * 100
        for key in ["assetId", "issuerId", "productId", "variantId", "catalogVersion"]
    }
    row["digest"] = "a" * 64
    body = {"selections": [row] * 24}
    assert len(json.dumps(body).encode()) < 16384
    response = client().post(ROOT + "/validate", json=body)
    assert response.status_code == 200 and len(response.json()["selections"]) == 24
    assert all(not item["approved"] for item in response.json()["selections"])
    assert response.headers["cache-control"] == "private, no-store"
    assert client().post(ROOT + "/validate", json={"selections": [row] * 25}).status_code in [
        413,
        422,
    ]
    assert client("foreign").post(ROOT + "/validate", json={"selections": [row]}).status_code == 403


def test_automatic_network_designs_are_private_paginated_and_match_only_that_network():
    from hushh_mcp.services.wallet_artwork_catalog import load_catalog

    catalog, _ = load_catalog()
    for network in ["visa", "mastercard", "amex", "discover", "rupay", "other"]:
        offered, offset = [], 0
        while offset is not None:
            response = client().post(
                ROOT + "/banks", json={"network": network, "automatic": True, "offset": offset}
            )
            assert response.status_code == 200
            assert response.headers["cache-control"] == "private, no-store"
            body = response.json()
            assert body["selectionBasis"] == "network_illustration"
            assert body["network"] == network and body["requiresConfirmation"] is False
            assert body["banks"] == [] and body["bankKey"] is None
            assert len(body["variants"]) <= 24
            offered.extend(body["variants"])
            offset = body["nextOffset"]
        expected = {
            row.asset_id
            for row in catalog.assets
            if row.selectable and row.network == network and network != "other"
        }
        assert {row["assetId"] for row in offered} == expected
        assert not {row["assetId"] for row in offered} & {
            row.asset_id for row in catalog.assets if not row.selectable
        }
        if offered:
            image = client().get(offered[0]["image"])
            assert image.status_code == 200 and image.headers["content-type"] == "image/webp"
            import hashlib

            assert hashlib.sha256(image.content).hexdigest() == offered[0]["digest"]
    for bad in [
        {"automatic": "true"},
        {"automatic": True, "bankKey": "a" * 32},
        {"automatic": True, "pan": "4242424242424242"},
    ]:
        response = client().post(ROOT + "/banks", json={"network": "visa", **bad})
        assert response.status_code == 422 and "4242424242424242" not in response.text
    assert (
        client("foreign")
        .post(ROOT + "/banks", json={"network": "visa", "automatic": True})
        .status_code
        == 403
    )
