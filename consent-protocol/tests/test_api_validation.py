"""Canonical field-level validation tests for POST /api/consent/pending/approve.

Verifies the granular agent_id / X-Client-Id identity check injected
directly into the approve_consent handler:

  • Mismatched agent_id (payload) vs X-Client-Id (header)  → HTTP 403
    with error_code AGENT_ID_CLIENT_ID_MISMATCH
  • Matching values                                         → HTTP 404
    (constraint passed; route reaches DB lookup which returns None)
  • Either value absent                                     → HTTP 404
    (check is skipped; only fires when BOTH are present)
  • Invalid payload fields                                  → HTTP 422

No DB, no network, no LLM.
Auth dependency is overridden; ConsentDBService is mocked where needed.

Integrated by Abdul Gaffar — canonical field-level validation logic.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.consent import ConsentApprovalPayload

_VALID_USER = "user-api-validation-001"
_VALID_REQUEST = "req-api-validation-abc"
_AGENT_A = "agent:firm-alpha-001"
_AGENT_B = "agent:firm-beta-999"


# ---------------------------------------------------------------------------
# Helpers
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


def _mock_db():
    svc = MagicMock()
    svc.get_pending_by_request_id = AsyncMock(return_value=None)
    svc.find_covering_active_token = AsyncMock(return_value=None)
    return svc


def _valid_body(**extra) -> dict:
    body = {"userId": _VALID_USER, "requestId": _VALID_REQUEST}
    body.update(extra)
    return body


# ---------------------------------------------------------------------------
# agent_id / X-Client-Id mismatch → 403
# ---------------------------------------------------------------------------


class TestAgentIdClientIdMismatch:
    """When payload.agent_id != X-Client-Id header the route returns 403."""

    def test_mismatched_ids_returns_403(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        response = client.post(
            "/api/consent/pending/approve",
            json=_valid_body(agent_id=_AGENT_A),
            headers={"X-Client-Id": _AGENT_B},
        )
        assert response.status_code == 403

    def test_mismatched_ids_error_code(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        response = client.post(
            "/api/consent/pending/approve",
            json=_valid_body(agent_id=_AGENT_A),
            headers={"X-Client-Id": _AGENT_B},
        )
        body = response.json()
        assert body["detail"]["error_code"] == "AGENT_ID_CLIENT_ID_MISMATCH"

    def test_mismatched_ids_message_present(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        response = client.post(
            "/api/consent/pending/approve",
            json=_valid_body(agent_id=_AGENT_A),
            headers={"X-Client-Id": _AGENT_B},
        )
        body = response.json()
        assert "message" in body["detail"]
        assert "agent_id" in body["detail"]["message"].lower()

    def test_partial_match_still_rejected(self):
        """Prefix match is not a valid match — full equality required."""
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        response = client.post(
            "/api/consent/pending/approve",
            json=_valid_body(agent_id="agent:firm-alpha"),
            headers={"X-Client-Id": "agent:firm-alpha-001"},
        )
        assert response.status_code == 403

    def test_case_sensitive_mismatch_rejected(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        response = client.post(
            "/api/consent/pending/approve",
            json=_valid_body(agent_id="Agent:Alpha"),
            headers={"X-Client-Id": "agent:alpha"},
        )
        assert response.status_code == 403


# ---------------------------------------------------------------------------
# Matching agent_id and X-Client-Id → check passes → reaches DB lookup (404)
# ---------------------------------------------------------------------------


class TestAgentIdClientIdMatch:
    """When agent_id == X-Client-Id the check passes and the route continues."""

    def test_matching_ids_not_403(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        with patch("api.routes.consent.ConsentDBService", return_value=_mock_db()):
            response = client.post(
                "/api/consent/pending/approve",
                json=_valid_body(agent_id=_AGENT_A),
                headers={"X-Client-Id": _AGENT_A},
            )
        assert response.status_code != 403

    def test_matching_ids_reaches_db_lookup_404(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        with patch("api.routes.consent.ConsentDBService", return_value=_mock_db()):
            response = client.post(
                "/api/consent/pending/approve",
                json=_valid_body(agent_id=_AGENT_A),
                headers={"X-Client-Id": _AGENT_A},
            )
        # 404 = field check passed, user-id check passed, DB returned None
        assert response.status_code == 404

    def test_exact_same_value_passes(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        with patch("api.routes.consent.ConsentDBService", return_value=_mock_db()):
            response = client.post(
                "/api/consent/pending/approve",
                json=_valid_body(agent_id="ria:firm-001"),
                headers={"X-Client-Id": "ria:firm-001"},
            )
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Check is skipped when either value is absent
# ---------------------------------------------------------------------------


class TestAgentIdCheckSkippedWhenAbsent:
    """The identity check only fires when BOTH values are present."""

    def test_no_agent_id_in_payload_skips_check(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        with patch("api.routes.consent.ConsentDBService", return_value=_mock_db()):
            response = client.post(
                "/api/consent/pending/approve",
                json=_valid_body(),
                headers={"X-Client-Id": _AGENT_A},
            )
        # No agent_id in body → check skipped → 404
        assert response.status_code == 404

    def test_no_header_skips_check(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        with patch("api.routes.consent.ConsentDBService", return_value=_mock_db()):
            response = client.post(
                "/api/consent/pending/approve",
                json=_valid_body(agent_id=_AGENT_A),
            )
        # No X-Client-Id header → check skipped → 404
        assert response.status_code == 404

    def test_neither_present_skips_check(self):
        client = TestClient(_make_test_app(), raise_server_exceptions=False)
        with patch("api.routes.consent.ConsentDBService", return_value=_mock_db()):
            response = client.post(
                "/api/consent/pending/approve",
                json=_valid_body(),
            )
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# ConsentApprovalPayload — agent_id field unit tests
# ---------------------------------------------------------------------------


class TestConsentApprovalPayloadAgentId:
    def test_agent_id_defaults_to_none(self):
        p = ConsentApprovalPayload.model_validate(
            {"userId": _VALID_USER, "requestId": _VALID_REQUEST}
        )
        assert p.agent_id is None

    def test_valid_agent_id_accepted(self):
        p = ConsentApprovalPayload.model_validate(
            {"userId": _VALID_USER, "requestId": _VALID_REQUEST, "agent_id": _AGENT_A}
        )
        assert p.agent_id == _AGENT_A

    def test_empty_agent_id_rejected(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError) as exc_info:
            ConsentApprovalPayload.model_validate(
                {"userId": _VALID_USER, "requestId": _VALID_REQUEST, "agent_id": ""}
            )
        errors = exc_info.value.errors()
        assert any(e["loc"] == ("agent_id",) for e in errors)

    def test_whitespace_only_agent_id_rejected(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError) as exc_info:
            ConsentApprovalPayload.model_validate(
                {"userId": _VALID_USER, "requestId": _VALID_REQUEST, "agent_id": " "}
            )
        errors = exc_info.value.errors()
        assert any(e["loc"] == ("agent_id",) for e in errors)

    def test_ria_prefixed_agent_id_accepted(self):
        p = ConsentApprovalPayload.model_validate(
            {"userId": _VALID_USER, "requestId": _VALID_REQUEST, "agent_id": "ria:firm-001"}
        )
        assert p.agent_id == "ria:firm-001"
