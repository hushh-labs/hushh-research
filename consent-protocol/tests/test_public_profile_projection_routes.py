from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import pkm_routes_shared


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(pkm_routes_shared.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    return app


def test_owner_can_list_public_profile_status_without_projection_payload(monkeypatch) -> None:
    class _Service:
        async def list_public_profile_projections(self, *, user_id: str, domain: str):
            assert (user_id, domain) == ("user_123", "financial")
            return [
                {
                    "public_profile_handle": "profile_opaque_123",
                    "top_level_scope_path": "portfolio",
                    "projection_hash": "sha256:metadata-only",
                }
            ]

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _Service())
    response = TestClient(_app()).get(
        "/api/pkm/domains/financial/public-profile-projections?user_id=user_123"
    )
    assert response.status_code == 200
    assert response.json()["projections"][0]["public_profile_handle"] == "profile_opaque_123"
    assert "projection_payload" not in response.json()["projections"][0]


def test_public_profile_status_denies_other_owner(monkeypatch) -> None:
    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: object())
    response = TestClient(_app()).get(
        "/api/pkm/domains/financial/public-profile-projections?user_id=other_user"
    )
    assert response.status_code == 403


def test_owner_can_unpublish_exact_opaque_handle(monkeypatch) -> None:
    called: dict[str, str] = {}

    class _Service:
        async def revoke_public_profile_projection_handle(self, **kwargs):
            called.update(kwargs)
            return True

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _Service())
    response = TestClient(_app()).request(
        "DELETE",
        "/api/pkm/domains/financial/public-profile-projection",
        json={"user_id": "user_123", "public_profile_handle": "profile_opaque_123"},
    )
    assert response.status_code == 200
    assert called["public_profile_handle"] == "profile_opaque_123"
    assert called["domain"] == "financial"


def test_unpublish_missing_handle_fails_closed(monkeypatch) -> None:
    class _Service:
        async def revoke_public_profile_projection_handle(self, **kwargs):
            return False

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _Service())
    response = TestClient(_app()).request(
        "DELETE",
        "/api/pkm/domains/financial/public-profile-projection",
        json={"user_id": "user_123", "public_profile_handle": "profile_missing"},
    )
    assert response.status_code == 404
