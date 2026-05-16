from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middlewares.request_logging import RequestLoggingMiddleware


def test_request_logging_middleware_runtime():
    app = FastAPI()

    app.add_middleware(RequestLoggingMiddleware)

    @app.get("/health")
    async def health():
        return {"ok": True}

    client = TestClient(app)

    response = client.get(
        "/health",
        headers={
            "Authorization": "secret-token",
        },
    )

    assert response.status_code == 200  # noqa: S101