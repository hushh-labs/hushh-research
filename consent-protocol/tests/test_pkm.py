from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import pkm, pkm_routes_shared


def test_store_domain_suppresses_exception_detail(monkeypatch):
    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[pkm.require_vault_owner_token] = lambda: {
        "user_id": "user_store_error"
    }

    class FailingPkmService:
        async def store_domain_data(self, **_kwargs):
            raise RuntimeError("store failed for decrypted pkm payload fragment")

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: FailingPkmService())

    client = TestClient(app, raise_server_exceptions=False)
    response = client.post(
        "/api/pkm/store-domain",
        json={
            "user_id": "user_store_error",
            "domain": "financial",
            "encrypted_blob": {
                "ciphertext": "cipher",
                "iv": "iv",
                "tag": "tag",
                "algorithm": "aes-256-gcm",
            },
            "summary": {"holdings_count": 1},
        },
    )

    assert response.status_code == 500
    assert "decrypted pkm payload fragment" not in response.text
    assert "store failed" not in response.text
