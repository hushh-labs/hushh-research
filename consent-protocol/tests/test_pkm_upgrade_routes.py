from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import pkm_routes_shared


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(pkm_routes_shared.router)
    app.dependency_overrides[pkm_routes_shared.require_vault_owner_token] = lambda: {
        "user_id": "user_123"
    }
    return app


def test_store_domain_forwards_upgrade_context(monkeypatch):
    captured: dict[str, object] = {}

    class _FakePkmService:
        async def store_domain_data(self, **kwargs):
            captured.update(kwargs)
            return {
                "success": True,
                "data_version": 4,
                "updated_at": "2026-03-24T12:00:00Z",
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: _FakePkmService())

    client = TestClient(_build_app())
    response = client.post(
        "/api/pkm/store-domain",
        json={
            "user_id": "user_123",
            "domain": "financial",
            "encrypted_blob": {
                "ciphertext": "cipher",
                "iv": "iv",
                "tag": "tag",
                "algorithm": "aes-256-gcm",
            },
            "summary": {"holdings_count": 2},
            "upgrade_context": {
                "run_id": "pkm_upgrade_demo",
                "prior_domain_contract_version": 1,
                "new_domain_contract_version": 2,
                "prior_readable_summary_version": 0,
                "new_readable_summary_version": 1,
                "retry_count": 0,
            },
        },
    )

    assert response.status_code == 200
    assert captured["upgrade_context"] == {
        "run_id": "pkm_upgrade_demo",
        "prior_domain_contract_version": 1,
        "new_domain_contract_version": 2,
        "prior_readable_summary_version": 0,
        "new_readable_summary_version": 1,
        "retry_count": 0,
    }


def test_upgrade_status_route_serializes_run_and_steps(monkeypatch):
    class _FakeUpgradeService:
        async def build_status(self, user_id: str):
            assert user_id == "user_123"
            return {
                "user_id": "user_123",
                "model_version": 2,
                "target_model_version": 3,
                "upgrade_status": "running",
                "last_upgraded_at": "2026-03-20T12:00:00Z",
                "upgradable_domains": [
                    {
                        "domain": "financial",
                        "current_domain_contract_version": 1,
                        "target_domain_contract_version": 2,
                        "current_readable_summary_version": 0,
                        "target_readable_summary_version": 1,
                        "upgraded_at": None,
                        "needs_upgrade": True,
                    }
                ],
                "run": {
                    "run_id": "pkm_upgrade_demo",
                    "user_id": "user_123",
                    "status": "running",
                    "from_model_version": 2,
                    "to_model_version": 3,
                    "current_domain": "financial",
                    "initiated_by": "unlock_warm",
                    "resume_count": 0,
                    "started_at": "2026-03-24T12:00:00Z",
                    "last_checkpoint_at": "2026-03-24T12:05:00Z",
                    "completed_at": None,
                    "last_error": None,
                    "created_at": "2026-03-24T12:00:00Z",
                    "updated_at": "2026-03-24T12:05:00Z",
                    "steps": [
                        {
                            "run_id": "pkm_upgrade_demo",
                            "domain": "financial",
                            "status": "running",
                            "from_domain_contract_version": 1,
                            "to_domain_contract_version": 2,
                            "from_readable_summary_version": 0,
                            "to_readable_summary_version": 1,
                            "attempt_count": 1,
                            "last_completed_content_revision": None,
                            "last_completed_manifest_version": None,
                            "checkpoint_payload": {"stage": "loading_domain"},
                            "created_at": "2026-03-24T12:00:00Z",
                            "updated_at": "2026-03-24T12:05:00Z",
                        }
                    ],
                },
            }

    monkeypatch.setattr(pkm_routes_shared, "get_pkm_upgrade_service", lambda: _FakeUpgradeService())

    client = TestClient(_build_app())
    response = client.get("/api/pkm/upgrade/status/user_123")

    assert response.status_code == 200
    payload = response.json()
    assert payload["model_version"] == 2
    assert payload["target_model_version"] == 3
    assert payload["upgrade_status"] == "running"
    assert payload["upgradable_domains"][0]["domain"] == "financial"
    assert payload["run"]["run_id"] == "pkm_upgrade_demo"
    assert payload["run"]["steps"][0]["checkpoint_payload"]["stage"] == "loading_domain"
