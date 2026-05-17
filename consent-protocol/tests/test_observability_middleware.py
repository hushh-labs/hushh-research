from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middlewares.observability import (
    REQUEST_ID_HEADER,
    TRACE_ID_HEADER,
    _status_bucket,
    get_request_id,
    get_request_trace_metadata,
    observability_middleware,
)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.middleware("http")(observability_middleware)

    @app.get("/ok")
    async def ok_route():
        return {"ok": True}

    @app.get("/metadata")
    async def metadata_route():
        metadata = get_request_trace_metadata()
        return {
            "request_id": get_request_id(),
            "trace_id": metadata.trace_id if metadata else None,
            "method": metadata.method if metadata else None,
            "route_template": metadata.route_template if metadata else None,
        }

    @app.get("/boom")
    async def boom_route():
        raise RuntimeError("boom")

    return app


def test_request_id_generated_when_missing():
    client = TestClient(_build_app())

    response = client.get("/ok")

    assert response.status_code == 200
    request_id = response.headers.get(REQUEST_ID_HEADER)
    assert isinstance(request_id, str)
    assert len(request_id) >= 8


def test_request_id_preserved_when_provided():
    client = TestClient(_build_app())

    response = client.get("/ok", headers={REQUEST_ID_HEADER: "req_test_12345678"})

    assert response.status_code == 200
    assert response.headers.get(REQUEST_ID_HEADER) == "req_test_12345678"
    assert response.headers.get(TRACE_ID_HEADER) == "req_test_12345678"


def test_trace_metadata_reused_inside_request_flow():
    client = TestClient(_build_app())

    response = client.get(
        "/metadata",
        headers={
            REQUEST_ID_HEADER: "req_test_12345678",
            TRACE_ID_HEADER: "trace_test_12345678",
        },
    )

    assert response.status_code == 200
    assert response.headers.get(REQUEST_ID_HEADER) == "req_test_12345678"
    assert response.headers.get(TRACE_ID_HEADER) == "trace_test_12345678"
    assert response.json() == {
        "request_id": "req_test_12345678",
        "trace_id": "trace_test_12345678",
        "method": "GET",
        "route_template": "/metadata",
    }
    assert get_request_trace_metadata() is None


def test_traceparent_header_reuses_distributed_trace_id():
    client = TestClient(_build_app())
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

    response = client.get(
        "/metadata",
        headers={
            REQUEST_ID_HEADER: "req_test_abcdefgh",
            "traceparent": f"00-{trace_id}-00f067aa0ba902b7-01",
        },
    )

    assert response.status_code == 200
    assert response.headers.get(TRACE_ID_HEADER) == trace_id
    assert response.json()["trace_id"] == trace_id


def test_unhandled_exception_returns_request_id_header():
    client = TestClient(_build_app())

    response = client.get("/boom")

    assert response.status_code == 500
    assert response.headers.get(REQUEST_ID_HEADER)
    assert response.headers.get(TRACE_ID_HEADER)


def test_expected_status_bucket_classification():
    assert _status_bucket("POST", "/api/kai/analyze/run/start", 409) == "4xx_expected"
    assert _status_bucket("GET", "/api/kai/analyze/run/active", 404) == "4xx_expected"
    assert _status_bucket("GET", "/api/kai/analyze/run/active", 401) == "4xx_unexpected"
    assert _status_bucket("GET", "/health", 200) == "2xx"
