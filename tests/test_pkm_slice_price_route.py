# consent-protocol/tests/test_pkm_slice_price_route.py
"""Route test for POST /api/pkm/slice-price (imports the production router)."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import pkm


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[pkm.require_pkm_metadata_access] = lambda: {
        "user_id": "user_123",
        "auth_type": "firebase",
    }
    return app


def test_slice_price_route_returns_floored_price_and_breakdown():
    client = TestClient(_build_app())
    response = client.post(
        "/api/pkm/slice-price",
        json={
            "category": "demographics_lifestyle",
            "attribute_count": 3,
            "power": "affluent",
            "mood": "affinity",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["currency"] == "USD"
    assert body["floor_cents"] == 10
    assert 55 <= body["suggested_price_cents"] <= 65
    assert body["breakdown"]["multiplier_b"] == 4.0


def test_slice_price_route_rejects_unknown_band():
    client = TestClient(_build_app())
    response = client.post(
        "/api/pkm/slice-price",
        json={"category": "demographics_lifestyle", "attribute_count": 1, "power": "galactic"},
    )
    assert response.status_code == 422


def test_slice_price_route_uses_defaults_for_minimal_body():
    client = TestClient(_build_app())
    response = client.post("/api/pkm/slice-price", json={"attribute_count": 1})
    assert response.status_code == 200
    assert response.json()["suggested_price_cents"] >= 10
