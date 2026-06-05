# tests/test_one_email_user_id_bounds.py
"""
Canonical attach-point proof for the max_length=128 constraint on
WorkflowUserRequest.user_id.

Canonical attach point
----------------------
api.routes.one.email.WorkflowUserRequest.user_id
  -> Field(min_length=1, max_length=128)
  -> FastAPI returns HTTP 422 when user_id exceeds 128 characters

WorkflowUserRequest is the base model for all one-email KYC workflow
requests.  Before the fix only min_length=1 was set, allowing arbitrarily
long strings through Pydantic validation.  All subclasses
(ClientConnectorRequest, ApprovedReplyRequest, etc.) inherit the bound
automatically.

The canonical callers exercised are:
  POST /api/one/kyc/workflows/{workflow_id}/refresh
    -> one_kyc_refresh_workflow(payload: WorkflowUserRequest)
  POST /api/one/kyc/workflows/{workflow_id}/approve-draft
    -> one_kyc_approve_draft(payload: WorkflowUserRequest)

Using a real TestClient confirms the validation fires at the framework
layer, before any service I/O.

Tests prove:
1. user_id at exactly 128 characters is accepted (boundary).
2. user_id at 129 characters is rejected with HTTP 422 (over bound).
3. Empty user_id is rejected with HTTP 422 (min_length=1 guard).
4. A typical Firebase UID passes validation.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import email as email_module


def _vault_owner_override():
    return {"user_id": "test-uid", "token": "fake", "scope": "vault.owner"}


def _client() -> TestClient:
    """Minimal FastAPI app with only the one-email router."""
    app = FastAPI()
    app.include_router(email_module.router)
    app.dependency_overrides[require_vault_owner_token] = _vault_owner_override
    return TestClient(app, raise_server_exceptions=False)


# Route that accepts WorkflowUserRequest directly as request body
_REFRESH_URL = "/api/one/kyc/workflows/wf-test-123/refresh"
_APPROVE_URL = "/api/one/kyc/workflows/wf-test-123/approve-draft"


# ---------------------------------------------------------------------------
# Canonical attach-point proof:
# api.routes.one.email.WorkflowUserRequest.user_id  (max_length=128)
# ---------------------------------------------------------------------------


class TestWorkflowUserRequestUserIdBounds:
    """
    WorkflowUserRequest is the canonical base model whose user_id field
    governs validation for all one-email KYC workflow routes.

    Proves that max_length=128 is enforced at the framework layer for
    POST /api/one/kyc/workflows/{id}/refresh and /approve-draft, which
    accept WorkflowUserRequest directly as their request body.
    """

    def test_user_id_at_max_length_is_accepted(self):
        """user_id of exactly 128 characters must pass Pydantic validation."""
        resp = _client().post(_REFRESH_URL, json={"user_id": "a" * 128})
        assert resp.status_code != 422, (
            f"user_id of length 128 was rejected (max_length too tight): {resp.json()}"
        )

    def test_user_id_over_max_length_is_rejected(self):
        """user_id of 129 characters must be rejected with HTTP 422."""
        resp = _client().post(_REFRESH_URL, json={"user_id": "a" * 129})
        assert resp.status_code == 422, (
            "user_id longer than 128 characters must be rejected by WorkflowUserRequest"
        )

    def test_empty_user_id_is_rejected(self):
        """Empty user_id must be rejected with HTTP 422 (min_length=1)."""
        resp = _client().post(_REFRESH_URL, json={"user_id": ""})
        assert resp.status_code == 422

    def test_typical_firebase_uid_is_accepted(self):
        """A typical Firebase UID (28 chars) must pass validation."""
        resp = _client().post(_REFRESH_URL, json={"user_id": "firebase-uid-abc123def456ghi7"})
        assert resp.status_code != 422

    def test_approve_draft_also_enforces_max_length(self):
        """
        Subclass ApprovedReplyRequest inherits the bound.
        POST /approve-draft must also reject a 129-character user_id.
        """
        resp = _client().post(
            _APPROVE_URL,
            json={
                "user_id": "a" * 129,
                "approved_body": "body text here",
                "pkm_writeback_artifact_hash": "a" * 64,
            },
        )
        assert resp.status_code == 422
