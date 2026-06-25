from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import gmail


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(gmail.router)
    app.dependency_overrides[gmail.require_firebase_auth] = lambda: "user_123"
    app.dependency_overrides[gmail.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    return app


def test_receipt_memory_rejects_oversized_user_ids_before_service(monkeypatch):
    def _unexpected_receipt_memory_service():
        raise AssertionError("receipt-memory user_id validation should run before service dispatch")

    monkeypatch.setattr(gmail, "_receipt_memory_service", _unexpected_receipt_memory_service)

    client = TestClient(_build_app())
    oversized_user_id = "u" * 129

    preview = client.post(
        "/gmail/receipts-memory/preview",
        json={"user_id": oversized_user_id},
    )
    artifact = client.get(
        "/gmail/receipts-memory/artifacts/artifact_123",
        params={"user_id": oversized_user_id},
    )

    assert preview.status_code == 422
    assert artifact.status_code == 422
