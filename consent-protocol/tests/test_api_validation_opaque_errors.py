"""Regression tests for opaque FastAPI request-validation responses."""

from __future__ import annotations

from fastapi.testclient import TestClient

from server import app

EXPECTED_VALIDATION_BODY = {
    "detail": {
        "error": "Validation error",
        "code": "VALIDATION_ERROR",
    }
}


def test_body_validation_failure_returns_consistent_opaque_payload() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    sentinel = "SENTINEL_INTERNAL_VALIDATION_VALUE_" + ("x" * 2100)

    response = client.post(
        "/api/validate-token",
        json={
            "token": sentinel,
        },
    )

    assert response.status_code == 422
    assert response.json() == EXPECTED_VALIDATION_BODY
    assert sentinel not in response.text
    assert "token" not in response.text


def test_query_validation_failure_returns_consistent_opaque_payload() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    sentinel = "SENTINEL_QUERY_VALUE_" + ("x" * 160)

    response = client.get(
        "/api/kai/analyze/stream",
        params={
            "ticker": "AAPL",
            "user_id": sentinel,
        },
        headers={"Authorization": "Bearer dummy-token"},
    )

    assert response.status_code == 422
    assert response.json() == EXPECTED_VALIDATION_BODY
    assert sentinel not in response.text
    assert "user_id" not in response.text
