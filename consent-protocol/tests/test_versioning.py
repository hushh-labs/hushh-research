"""Canonical schema-versioning tests for ConsentApprovalPayload.

Verifies that v1 payloads (missing ``version`` key) are transparently
promoted to the current schema by the @model_validator, and that the
existing /api/consent/pending/approve route accepts them without error.

No DB, no network, no LLM.  Route integration tests mock ConsentDBService
so the 422-before-DB path and the DB-lookup path can both be exercised
without a live database.

Integrated by Abdul Gaffar — canonical schema versioning surface.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api.routes.consent import ConsentApprovalPayload

_VALID_USER = "user-schema-test-001"
_VALID_REQUEST = "req-schema-abc-001"


# ===========================================================================
# ConsentApprovalPayload — model-level unit tests (no route, no DB)
# ===========================================================================


class TestConsentApprovalPayloadV1Upgrade:
    """v1 payload: no version key → _upgrade_v1_payload stamps version=1."""

    def test_missing_version_defaults_to_1(self):
        payload = ConsentApprovalPayload.model_validate(
            {"userId": _VALID_USER, "requestId": _VALID_REQUEST}
        )
        assert payload.version == 1

    def test_v1_optional_fields_are_none(self):
        payload = ConsentApprovalPayload.model_validate(
            {"userId": _VALID_USER, "requestId": _VALID_REQUEST}
        )
        assert payload.encryptedData is None
        assert payload.wrappedExportKey is None
        assert payload.durationHours is None
        assert payload.wrappingAlg is None

    def test_v1_core_fields_preserved(self):
        payload = ConsentApprovalPayload.model_validate(
            {"userId": _VALID_USER, "requestId": _VALID_REQUEST}
        )
        assert payload.userId == _VALID_USER
        assert payload.requestId == _VALID_REQUEST

    def test_explicit_version_1_accepted(self):
        payload = ConsentApprovalPayload.model_validate(
            {"version": 1, "userId": _VALID_USER, "requestId": _VALID_REQUEST}
        )
        assert payload.version == 1

    def test_v1_does_not_raise(self):
        # Must not raise ValidationError even though encryption fields are absent.
        ConsentApprovalPayload.model_validate(
            {"userId": _VALID_USER, "requestId": _VALID_REQUEST}
        )


class TestConsentApprovalPayloadV2:
    """v2 payload: explicit version=2, full encrypted-export bundle present."""

    def _v2_body(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "version": 2,
            "userId": _VALID_USER,
            "requestId": _VALID_REQUEST,
            "encryptedData": "base64data==",
            "encryptedIv": "base64iv==",
            "encryptedTag": "base64tag==",
            "wrappedExportKey": "wrappedkey==",
            "wrappedKeyIv": "keyiv==",
            "wrappedKeyTag": "keytag==",
            "senderPublicKey": "pubkey==",
            "wrappingAlg": "X25519-AES256-GCM",
        }
        base.update(overrides)
        return base

    def test_v2_payload_accepted(self):
        payload = ConsentApprovalPayload.model_validate(self._v2_body())
        assert payload.version == 2
        assert payload.encryptedData == "base64data=="

    def test_v2_version_preserved(self):
        payload = ConsentApprovalPayload.model_validate(self._v2_body())
        assert payload.version == 2

    def test_v2_optional_duration_defaults_none(self):
        payload = ConsentApprovalPayload.model_validate(self._v2_body())
        assert payload.durationHours is None

    def test_v2_with_duration_preserved(self):
        payload = ConsentApprovalPayload.model_validate(self._v2_body(durationHours=12))
        assert payload.durationHours == 12

    def test_invalid_version_rejected(self):
        with pytest.raises(ValidationError):
            ConsentApprovalPayload.model_validate(
                {"version": 99, "userId": _VALID_USER, "requestId": _VALID_REQUEST}
            )


class TestConsentApprovalPayloadExtra:
    """Unknown fields from future versions are preserved (extra=allow)."""

    def test_future_field_not_rejected(self):
        payload = ConsentApprovalPayload.model_validate(
            {
                "userId": _VALID_USER,
                "requestId": _VALID_REQUEST,
                "futureField": "some-value",
            }
        )
        assert payload.model_extra.get("futureField") == "some-value"


# ===========================================================================
# Route integration — /api/consent/pending/approve accepts v1 payload
# ===========================================================================


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


class TestApproveRouteAcceptsV1Payload:
    """Hitting the real route with a v1 payload proves the schema upgrade path."""

    def _mock_db(self):
        mock_service = MagicMock()
        mock_service.get_pending_by_request_id = AsyncMock(return_value=None)
        mock_service.find_covering_active_token = AsyncMock(return_value=None)
        return mock_service

    def test_v1_payload_passes_schema_validation_reaches_db_lookup(self):
        """v1 payload (no version key) → Pydantic upgrade → route gets to DB lookup → 404."""
        app = _make_test_app()
        client = TestClient(app, raise_server_exceptions=False)

        with patch(
            "api.routes.consent.ConsentDBService",
            return_value=self._mock_db(),
        ):
            response = client.post(
                "/api/consent/pending/approve",
                json={"userId": _VALID_USER, "requestId": _VALID_REQUEST},
            )

        # 404 = schema validation passed, user-id check passed, DB lookup returned None.
        # 422 would mean Pydantic rejected the payload — proving upgrade is working.
        assert response.status_code == 404
        assert response.json().get("detail") == "Consent request not found"

    def test_v2_payload_also_accepted_by_route(self):
        """Explicit version=2 with encryption bundle is also accepted."""
        app = _make_test_app()
        client = TestClient(app, raise_server_exceptions=False)

        with patch(
            "api.routes.consent.ConsentDBService",
            return_value=self._mock_db(),
        ):
            response = client.post(
                "/api/consent/pending/approve",
                json={
                    "version": 2,
                    "userId": _VALID_USER,
                    "requestId": _VALID_REQUEST,
                    "encryptedData": "data==",
                    "encryptedIv": "iv==",
                    "encryptedTag": "tag==",
                    "wrappedExportKey": "key==",
                    "wrappedKeyIv": "keyiv==",
                    "wrappedKeyTag": "keytag==",
                    "senderPublicKey": "pub==",
                },
            )

        assert response.status_code == 404

    def test_wrong_user_gets_403_not_422(self):
        """User ID mismatch → 403, not 422 — proving schema still validated first."""
        app = _make_test_app()
        client = TestClient(app, raise_server_exceptions=False)

        response = client.post(
            "/api/consent/pending/approve",
            json={"userId": "other-user", "requestId": _VALID_REQUEST},
        )
        assert response.status_code == 403
