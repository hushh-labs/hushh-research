from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middlewares.observability import (
    REQUEST_ID_HEADER,
    _outcome_class,
    _sanitize_request_id,
    _status_bucket,
    observability_middleware,
)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.middleware("http")(observability_middleware)

    @app.get("/ok")
    async def ok_route():
        return {"ok": True}

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


def test_unhandled_exception_returns_request_id_header():
    client = TestClient(_build_app())

    response = client.get("/boom")

    assert response.status_code == 500
    assert response.headers.get(REQUEST_ID_HEADER)


def test_expected_status_bucket_classification():
    assert _status_bucket("POST", "/api/kai/analyze/run/start", 409) == "4xx_expected"
    assert _status_bucket("GET", "/api/kai/analyze/run/active", 404) == "4xx_expected"
    assert _status_bucket("GET", "/api/kai/analyze/run/active", 401) == "4xx_unexpected"
    assert _status_bucket("GET", "/health", 200) == "2xx"


def test_status_bucket_covers_all_ranges():
    assert _status_bucket("GET", "/health", 201) == "2xx"
    assert _status_bucket("GET", "/health", 301) == "3xx"
    assert _status_bucket("GET", "/health", 302) == "3xx"
    assert _status_bucket("GET", "/health", 400) == "4xx_unexpected"
    assert _status_bucket("GET", "/health", 500) == "5xx"
    assert _status_bucket("GET", "/health", 503) == "5xx"


def test_status_bucket_vault_expected_routes():
    assert _status_bucket("POST", "/db/vault/get", 404) == "4xx_expected"
    assert _status_bucket("POST", "/db/vault/bootstrap-state", 404) == "4xx_expected"
    assert _status_bucket("GET", "/api/pkm/metadata/{user_id}", 404) == "4xx_expected"
    assert _status_bucket("GET", "/api/pkm/metadata/{user_id}", 401) == "4xx_expected"


def test_outcome_class_success_range():
    assert _outcome_class("GET", "/health", 200) == "success"
    assert _outcome_class("POST", "/api/consent/request", 201) == "success"
    assert _outcome_class("GET", "/health", 301) == "success"


def test_outcome_class_expected_error():
    assert _outcome_class("POST", "/api/kai/analyze/run/start", 409) == "expected_error"
    assert _outcome_class("GET", "/api/kai/analyze/run/active", 404) == "expected_error"


def test_outcome_class_client_error_unexpected():
    assert _outcome_class("GET", "/api/kai/analyze/run/active", 401) == "client_error"
    assert _outcome_class("GET", "/health", 403) == "client_error"


def test_outcome_class_server_error():
    assert _outcome_class("GET", "/health", 500) == "server_error"
    assert _outcome_class("POST", "/api/consent/request", 503) == "server_error"


def test_sanitize_request_id_accepts_valid_value():
    assert _sanitize_request_id("req_test_12345678") == "req_test_12345678"
    assert _sanitize_request_id("abc-123.xyz:456") == "abc-123.xyz:456"


def test_sanitize_request_id_rejects_none():
    assert _sanitize_request_id(None) is None


def test_sanitize_request_id_rejects_empty_string():
    assert _sanitize_request_id("") is None


def test_sanitize_request_id_rejects_whitespace_only():
    assert _sanitize_request_id("   ") is None


def test_sanitize_request_id_rejects_too_short():
    assert _sanitize_request_id("abc") is None


def test_sanitize_request_id_rejects_unsafe_characters():
    assert _sanitize_request_id("<script>alert(1)</script>") is None
    assert _sanitize_request_id("req id with spaces") is None
    assert _sanitize_request_id("req/id/with/slashes") is None


def test_sanitize_request_id_rejects_too_long():
    assert _sanitize_request_id("a" * 129) is None


def test_sanitize_request_id_accepts_boundary_length():
    assert _sanitize_request_id("a" * 8) is not None
    assert _sanitize_request_id("a" * 128) is not None


def test_unhandled_exception_response_body_is_valid_json():
    client = TestClient(_build_app(), raise_server_exceptions=False)

    response = client.get("/boom")

    assert response.status_code == 500
    body = response.json()
    assert "detail" in body


def test_request_id_header_present_on_all_success_status_codes():
    client = TestClient(_build_app())

    for _ in range(3):
        response = client.get("/ok")
        assert response.headers.get(REQUEST_ID_HEADER), (
            "x-request-id must be present on every successful response"
        )
        assert response.status_code == 200    


def test_unique_request_ids_generated_for_sequential_requests():
    client = TestClient(_build_app())

    ids = {client.get("/ok").headers.get(REQUEST_ID_HEADER) for _ in range(5)}

    assert len(ids) == 5, "Each request must receive a unique request-id"
