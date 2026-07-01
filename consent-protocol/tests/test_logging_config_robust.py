import os
import sys

# Ensure root directory is in sys.path before importing services
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import hashlib
import json
import logging
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.logging_config import (
    JSONFormatter,
    RequestContextMiddleware,
    StructuredLogRecord,
    _request_context,
    hash_identity,
    sanitize_value,
)


def test_hash_identity():
    assert hash_identity(None) is None
    assert hash_identity("") is None

    uid = "test-user-uid-123"
    expected = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    assert hash_identity(uid) == expected


def test_sanitize_value():
    # Sensitive keys must be redacted
    assert sanitize_value("email", "test@test.com") == "[REDACTED]"
    assert sanitize_value("vault_key", "my-secret-key") == "[REDACTED]"
    assert sanitize_value("password", "123456") == "[REDACTED]"
    assert sanitize_value("token", "bearer-token") == "[REDACTED]"

    # user_id must be hashed, not fully redacted
    uid = "user-123"
    expected_hash = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    assert sanitize_value("user_id", uid) == expected_hash

    # Non-sensitive keys must remain unchanged (avoid using 'key' in name to prevent redaction)
    assert sanitize_value("name", "John Doe") == "John Doe"
    assert sanitize_value("limit", 10) == 10

    # Nested dictionaries and lists must be recursively sanitized
    nested = {
        "email": "nested@test.com",
        "nested_dict": {"password": "pass", "normal_field": "ok"},  # noqa: S105
        "list_val": ["normal", {"secret": "pii"}],  # noqa: S105
    }
    sanitized = sanitize_value("data", nested)
    assert sanitized["email"] == "[REDACTED]"
    assert sanitized["nested_dict"]["password"] == "[REDACTED]"  # noqa: S105
    assert sanitized["nested_dict"]["normal_field"] == "ok"
    assert sanitized["list_val"][0] == "normal"
    assert sanitized["list_val"][1]["secret"] == "[REDACTED]"  # noqa: S105


def test_json_formatter():
    formatter = JSONFormatter()
    # Instantiate StructuredLogRecord to have correlation fields, or set them directly
    record = StructuredLogRecord(
        name="test_logger",
        level=logging.INFO,
        pathname="test.py",
        lineno=10,
        msg="Hello World",
        args=(),
        exc_info=None,
    )

    # Set fields directly on the record
    record.correlation_id = "corr-123"
    record.user_id = "user-abc"
    record.vault_id = "vault-xyz"

    formatted = formatter.format(record)
    data = json.loads(formatted)

    assert data["message"] == "Hello World"
    assert data["level"] == "INFO"
    assert data["logger"] == "test_logger"
    assert data["correlation_id"] == "corr-123"
    assert data["user_id"] == hash_identity("user-abc")
    assert data["vault_id"] == "vault-xyz"

    # Verify extra parameters are sanitized
    record.__dict__["email"] = "sensitive@test.com"
    record.__dict__["safe_field"] = "hello"

    formatted_extra = formatter.format(record)
    data_extra = json.loads(formatted_extra)
    assert data_extra["email"] == "[REDACTED]"
    assert data_extra["safe_field"] == "hello"


@pytest.mark.asyncio
async def test_request_context_middleware_correlation_id():
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    @app.get("/")
    async def index():
        return {"status": "ok"}

    client = TestClient(app)

    # Test with custom correlation ID header
    response = client.get("/", headers={"x-correlation-id": "custom-id-999"})
    assert response.status_code == 200
    assert response.headers.get("x-correlation-id") == "custom-id-999"

    # Test auto-generated correlation ID header
    response_auto = client.get("/")
    assert response_auto.status_code == 200
    assert "x-correlation-id" in response_auto.headers
    assert len(response_auto.headers["x-correlation-id"]) > 10


@pytest.mark.asyncio
async def test_request_context_middleware_db_validation():
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)

    resolved_context = {}

    @app.get("/test-auth")
    async def test_auth():
        # Capture context during request execution
        resolved_context["user_id"] = _request_context.get("user_id")
        resolved_context["scope"] = _request_context.get("scope")
        return {"status": "ok"}

    client = TestClient(app)

    mock_token_obj = AsyncMock()
    mock_token_obj.user_id = "firebase-user-999"
    mock_token_obj.scope_str = "pkm.read"

    with patch(
        "hushh_mcp.consent.token.validate_token_with_db", new_callable=AsyncMock
    ) as mock_validate:
        mock_validate.return_value = (True, "Valid token", mock_token_obj)

        # Call with bearer consent token
        response = client.get("/test-auth", headers={"Authorization": "Bearer HCT:token_123"})
        assert response.status_code == 200

        assert resolved_context["user_id"] == "firebase-user-999"
        assert resolved_context["scope"] == "pkm.read"
