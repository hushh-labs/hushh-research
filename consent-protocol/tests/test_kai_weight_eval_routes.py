from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token


def _load_weight_eval_module():
    module_path = Path(__file__).resolve().parents[1] / "api" / "routes" / "kai" / "weight_eval.py"
    spec = importlib.util.spec_from_file_location("kai_weight_eval_route_module", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _FakeService:
    async def fetch_recent_weight_eval_artifacts(self, *, user_id: str, limit: int = 20):
        assert user_id == "user_123"
        assert limit == 5
        return {
            "user_id": user_id,
            "runs": [{"created_at": "2026-05-10T00:00:00Z", "run": {"run_id": "r1"}}],
            "promotions": [
                {
                    "created_at": "2026-05-10T00:01:00Z",
                    "decision": {"run_id": "r1", "approved": True},
                }
            ],
            "artifact_count": 2,
        }


def _build_app(token_payload: dict):
    weight_eval_module = _load_weight_eval_module()
    app = FastAPI()
    app.include_router(weight_eval_module.router, prefix="/api/kai")
    app.dependency_overrides[require_vault_owner_token] = lambda: token_payload
    return app, weight_eval_module


def test_get_weight_eval_artifacts_success(monkeypatch):
    app, weight_eval_module = _build_app({"user_id": "user_123", "token": "tok"})
    monkeypatch.setattr(weight_eval_module, "get_kai_weight_eval_service", lambda: _FakeService())
    client = TestClient(app)

    response = client.get(
        "/api/kai/weight-eval/artifacts", params={"user_id": "user_123", "limit": 5}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["user_id"] == "user_123"
    assert payload["artifact_count"] == 2
    assert len(payload["runs"]) == 1
    assert len(payload["promotions"]) == 1


def test_get_weight_eval_artifacts_rejects_user_mismatch(monkeypatch):
    app, weight_eval_module = _build_app({"user_id": "other_user", "token": "tok"})
    monkeypatch.setattr(weight_eval_module, "get_kai_weight_eval_service", lambda: _FakeService())
    client = TestClient(app)

    response = client.get(
        "/api/kai/weight-eval/artifacts", params={"user_id": "user_123", "limit": 5}
    )

    assert response.status_code == 403
    assert "does not match" in response.json()["detail"]
