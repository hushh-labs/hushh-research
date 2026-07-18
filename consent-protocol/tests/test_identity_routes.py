from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.identity import router


def _build_app():
    app = FastAPI()
    app.include_router(router)
    return app


def test_status_route_is_deprecated():
    client = TestClient(_build_app())

    response = client.get("/api/identity/status")

    assert response.status_code == 410
    assert response.json()["detail"]["error_code"] == "IDENTITY_ROUTES_DEPRECATED"
