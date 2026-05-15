"""
Tests for ConsentApprovalPayload.validate_contextual_rules and its
integration into POST /api/consent/pending/approve.

Integrated by Abdul Gaffar — canonical consent surface.

Proves that:
  1. The model self-validates age_gate without external helpers
  2. The model self-validates jurisdiction without external helpers
  3. A valid context produces zero violations
  4. The route returns HTTP 422 when contextual rules fail
  5. The route passes contextual validation when the context is clean
     (proceeds to later processing; no extra mocking needed for this proof)
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hushh_mcp.consent.approval import ConsentApprovalPayload

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_VALID_USER = "user_test_contextual"
_VALID_REQ = "req_contextual_001"


def _payload(**kwargs) -> ConsentApprovalPayload:
    defaults = {"user_id": _VALID_USER, "request_id": _VALID_REQ}
    defaults.update(kwargs)
    return ConsentApprovalPayload(**defaults)


# ---------------------------------------------------------------------------
# Model-level unit tests — no routing required
# ---------------------------------------------------------------------------


class TestValidateContextualRules:
    def test_empty_context_has_no_violations(self):
        payload = _payload()
        assert payload.validate_contextual_rules({}) == []

    def test_adult_age_passes(self):
        payload = _payload(requester_age=18)
        violations = payload.validate_contextual_rules({"age": 18})
        assert violations == []

    def test_age_17_fails_age_gate(self):
        payload = _payload(requester_age=17)
        violations = payload.validate_contextual_rules({"age": 17})
        assert len(violations) == 1
        assert "age_gate" in violations[0]
        assert "17" in violations[0]

    def test_age_0_fails_age_gate(self):
        violations = _payload().validate_contextual_rules({"age": 0})
        assert any("age_gate" in v for v in violations)

    def test_age_none_skipped(self):
        violations = _payload().validate_contextual_rules({"age": None})
        assert violations == []

    def test_age_missing_key_skipped(self):
        assert _payload().validate_contextual_rules({}) == []

    def test_blocked_jurisdiction_fails(self):
        violations = _payload().validate_contextual_rules(
            {"location": "OFAC_SANCTIONED"}
        )
        assert len(violations) == 1
        assert "jurisdiction" in violations[0]

    def test_blocked_jurisdiction_case_insensitive(self):
        violations = _payload().validate_contextual_rules(
            {"location": "ofac_sanctioned"}
        )
        assert any("jurisdiction" in v for v in violations)

    def test_allowed_jurisdiction_passes(self):
        violations = _payload().validate_contextual_rules({"location": "US"})
        assert violations == []

    def test_location_none_skipped(self):
        violations = _payload().validate_contextual_rules({"location": None})
        assert violations == []

    def test_multiple_violations_accumulated(self):
        violations = _payload().validate_contextual_rules(
            {"age": 15, "location": "EMBARGOED"}
        )
        assert len(violations) == 2
        assert any("age_gate" in v for v in violations)
        assert any("jurisdiction" in v for v in violations)

    def test_returns_list_not_generator(self):
        result = _payload().validate_contextual_rules({"age": 25})
        assert isinstance(result, list)

    def test_unknown_context_keys_ignored(self):
        violations = _payload().validate_contextual_rules(
            {"unknown_key": "ignored", "another": 999}
        )
        assert violations == []


# ---------------------------------------------------------------------------
# Route-level integration proof via TestClient
#
# Build a micro-app with the consent router and override require_vault_owner_token
# so we can exercise approve_consent without real auth infrastructure.
# The contextual validation fires BEFORE any DB call, so no DB mocks needed
# for the 422 path.
# ---------------------------------------------------------------------------


def _make_test_app() -> FastAPI:
    from api.middleware import require_vault_owner_token
    from api.routes import consent

    app = FastAPI()
    app.include_router(consent.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": _VALID_USER,
        "token": "test-vault-token",
    }
    return app


@pytest.fixture(scope="module")
def client():
    return TestClient(_make_test_app())


class TestApproveConsentContextualValidation:
    def test_underage_requester_returns_422(self, client: TestClient):
        """Route rejects underage requester before reaching the database."""
        response = client.post(
            "/api/consent/pending/approve",
            json={
                "userId": _VALID_USER,
                "requestId": _VALID_REQ,
                "requesterAge": 15,
                "requesterLocation": "US",
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["code"] == "CONTEXTUAL_RULE_VIOLATION"
        assert any("age_gate" in v for v in detail["violations"])

    def test_blocked_jurisdiction_returns_422(self, client: TestClient):
        """Route rejects blocked jurisdiction before reaching the database."""
        response = client.post(
            "/api/consent/pending/approve",
            json={
                "userId": _VALID_USER,
                "requestId": _VALID_REQ,
                "requesterAge": 25,
                "requesterLocation": "OFAC_SANCTIONED",
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("jurisdiction" in v for v in detail["violations"])

    def test_both_violations_in_one_response(self, client: TestClient):
        """Route accumulates all contextual violations in a single response."""
        response = client.post(
            "/api/consent/pending/approve",
            json={
                "userId": _VALID_USER,
                "requestId": _VALID_REQ,
                "requesterAge": 12,
                "requesterLocation": "EMBARGOED",
            },
        )
        assert response.status_code == 422
        violations = response.json()["detail"]["violations"]
        assert len(violations) == 2

    def test_clean_context_passes_to_next_stage(self, client: TestClient):
        """A contextually valid request is NOT rejected by contextual validation.

        It will fail later (404 — no pending request in test DB), proving
        the contextual guard passed and execution continued.
        """
        response = client.post(
            "/api/consent/pending/approve",
            json={
                "userId": _VALID_USER,
                "requestId": _VALID_REQ,
                "requesterAge": 25,
                "requesterLocation": "US",
            },
        )
        # 422 = contextual violation (BAD)
        # 404/500/other = contextual guard passed, failed later (GOOD for this test)
        assert response.status_code != 422

    def test_missing_contextual_fields_does_not_block(self, client: TestClient):
        """No requesterAge/requesterLocation → no contextual violations."""
        response = client.post(
            "/api/consent/pending/approve",
            json={"userId": _VALID_USER, "requestId": _VALID_REQ},
        )
        assert response.status_code != 422
