"""Compatibility removal boundary for obsolete local model-pack clients."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import local_runtime


def test_retired_capability_never_returns_a_model_download():
    app = FastAPI()
    app.include_router(local_runtime.router)
    response = TestClient(app).get("/local-runtime/capability")
    assert response.status_code == 410
    assert response.json()["detail"]["code"] == "ONE_LOCAL_VOICE_RETIRED"
    assert "artifact_url" not in response.text
