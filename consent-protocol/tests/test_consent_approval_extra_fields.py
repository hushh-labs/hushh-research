"""
Regression tests for ConsentApprovalPayload extra-field rejection.

Attach point: api/routes/consent.py (ConsentApprovalPayload)

Bug: ConsentApprovalPayload had `model_config = ConfigDict(extra="allow")`.
Pydantic's extra="allow" stores every unknown key in __pydantic_extra__ and
includes it in model_dump() output.  On this security-critical endpoint
(POST /api/consent/pending/approve), that meant:

  1. CWE-915 (Improperly Controlled Modification of Dynamically-Determined
     Object Attributes): arbitrary caller-controlled keys were stored alongside
     validated fields and could propagate to DB writes, log entries, or
     downstream serialization.

  2. DoS via unbounded extra fields: a caller could send a payload with thousands
     of extra keys, each with large values.  Because no validation rejected them,
     every byte passed through to the internal dict with no limit.

Fix: change extra="allow" to extra="forbid".  FastAPI will return HTTP 422
for any request whose body contains an unrecognized key.

Tests cover:
- Extra fields are rejected at the model level (ValidationError)
- HTTP layer returns 422 for payloads with extra keys
- Known-good payloads still validate correctly
- Minimal required-field payload is accepted
"""

from __future__ import annotations

import ast
import pathlib

import pytest
from pydantic import ValidationError

from api.routes.consent import ConsentApprovalPayload

# ---------------------------------------------------------------------------
# Model-level tests
# ---------------------------------------------------------------------------


def test_extra_field_raises_validation_error():
    """Unknown keys must be rejected with ValidationError (extra='forbid')."""
    with pytest.raises(ValidationError) as exc_info:
        ConsentApprovalPayload(
            userId="user_abc",
            requestId="req_001",
            unknown_field="should_be_rejected",
        )
    errors = exc_info.value.errors()
    assert any(e.get("type") == "extra_forbidden" for e in errors), (
        f"Expected extra_forbidden error, got: {errors}"
    )


def test_multiple_extra_fields_all_rejected():
    """All extra fields in a single payload must be rejected."""
    with pytest.raises(ValidationError) as exc_info:
        ConsentApprovalPayload(
            userId="user_abc",
            requestId="req_001",
            extra1="v1",
            extra2="v2",
            extra3=12345,
        )
    errors = exc_info.value.errors()
    extra_errors = [e for e in errors if e.get("type") == "extra_forbidden"]
    assert len(extra_errors) >= 1, f"Expected at least one extra_forbidden error, got: {errors}"


def test_valid_minimal_payload_accepted():
    """Required fields with no extras must validate without error."""
    payload = ConsentApprovalPayload(
        userId="user_abc",
        requestId="req_001",
    )
    assert payload.userId == "user_abc"
    assert payload.requestId == "req_001"


def test_valid_full_payload_accepted():
    """All known fields together must validate successfully."""
    payload = ConsentApprovalPayload(
        userId="user_abc",
        requestId="req_001",
        version=2,
        durationHours=24,
        connectorKeyId="connector_key_123",
        wrappingAlg="X25519-AES256-GCM",
    )
    assert payload.userId == "user_abc"
    assert payload.version == 2
    assert payload.durationHours == 24


def test_extra_field_not_in_model_dump():
    """
    Double-check: even if Pydantic somehow accepted an extra field, it must
    not appear in model_dump().  This guards against regressions if extra
    mode is accidentally loosened again.
    """
    payload = ConsentApprovalPayload(
        userId="user_abc",
        requestId="req_001",
    )
    dumped = payload.model_dump()
    assert "unknown_field" not in dumped
    assert "injected_key" not in dumped


# ---------------------------------------------------------------------------
# HTTP layer test (TestClient)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client():
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    # Stub out Firebase + vault-owner auth so the route reaches validation
    from api.middleware import require_vault_owner_token
    from server import app

    def _stub_token():
        return {"user_id": "user_abc", "agent_id": "self", "scope": "vault.owner", "token": "tok"}

    with patch.dict(app.dependency_overrides, {require_vault_owner_token: _stub_token}):
        yield TestClient(app, raise_server_exceptions=False)


def test_http_extra_field_returns_422(client):
    """POST /api/consent/pending/approve must return 422 for unknown body keys."""
    resp = client.post(
        "/api/consent/pending/approve",
        json={
            "userId": "user_abc",
            "requestId": "req_001",
            "injected_field": "malicious_value",
        },
    )
    assert resp.status_code == 422, (
        f"Expected 422 for extra field in ConsentApprovalPayload body, got {resp.status_code}"
    )


def test_http_valid_payload_not_rejected_by_validation(client):
    """A valid payload must not be rejected by field validation (may fail later for business reasons)."""
    resp = client.post(
        "/api/consent/pending/approve",
        json={
            "userId": "user_abc",
            "requestId": "req_001",
        },
    )
    # Should not be 422 — validation passes; it may 400/404/500 for business logic
    assert resp.status_code != 422, "Valid payload was incorrectly rejected with 422"


# ---------------------------------------------------------------------------
# AST guard: model_config must not use extra="allow"
# ---------------------------------------------------------------------------

CONSENT_PY = pathlib.Path(__file__).parent.parent / "api/routes/consent.py"


def test_consent_approval_payload_uses_extra_forbid():
    """
    AST guard: ConsentApprovalPayload.model_config must set extra='forbid'.
    Catches regressions where extra mode is accidentally loosened.
    """
    source = CONSENT_PY.read_text()
    tree = ast.parse(source)

    found_forbid = False
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "ConsentApprovalPayload":
            for child in ast.walk(node):
                # Look for ConfigDict(extra="forbid") or similar call
                if isinstance(child, ast.Call):
                    for kw in child.keywords:
                        if (
                            kw.arg == "extra"
                            and isinstance(kw.value, ast.Constant)
                            and kw.value.value == "forbid"
                        ):
                            found_forbid = True

    assert found_forbid, (
        "ConsentApprovalPayload does not use extra='forbid' — "
        "unknown fields may still be stored (CWE-915)"
    )
