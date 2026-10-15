import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.wallet_card_access import router

ROOT = "/api/one/wallet/card-access/artwork"


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
