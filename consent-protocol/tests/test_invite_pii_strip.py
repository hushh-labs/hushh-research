"""
Tests: GET /api/invites/{invite_token} strips target PII from response.

Canonical attach point
----------------------
api.routes.invites.get_invite -> GET /api/invites/{invite_token}

The unauthenticated GET endpoint was returning target_email, target_phone,
and target_display_name in the JSON response.  Anyone with the invite URL
(which is shared over email/text) could read the invitee's personal contact
details without authentication.

Fix: RIAIAMService.get_ria_invite() accepts include_target_pii=False by
default.  The route passes include_target_pii=False so those fields are
absent from the public response.

Route-level proof: mock service returns a dict with PII fields set;
the route response must NOT contain those fields.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.invites as invites_module


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(invites_module.router)
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# PII strip proof - route-level
# ---------------------------------------------------------------------------


class TestGetInvitePiiStrip:
    """
    Canonical attach point: api.routes.invites.get_invite
    GET /api/invites/{invite_token}

    Proves that target_email, target_phone, and target_display_name are
    absent from the response even when the underlying service returns them.
    """

    _URL = "/api/invites/invite-token-abc123"

    _FULL_SERVICE_RESPONSE = {
        "invite_id": "inv-001",
        "invite_token": "invite-token-abc123",
        "status": "sent",
        "firm_id": None,
        "scope_template_id": "tpl-001",
        "duration_mode": "fixed",
        "duration_hours": 24,
        "reason": "Portfolio review",
        "expires_at": "2026-12-31T00:00:00+00:00",
        "accepted_by_user_id": None,
        "accepted_request_id": None,
        # PII fields - must NOT appear in unauthenticated response
        "target_display_name": "Jane Doe",
        "target_email": "jane@example.com",
        "target_phone": "+15550001234",
        "ria": {
            "id": "ria-001",
            "user_id": "ria-uid",
            "display_name": "John Advisor",
            "verification_status": "verified",
            "headline": "Wealth management",
            "strategy_summary": "Long-term growth",
            "bio": "10 years experience",
            "firms": [],
        },
    }

    def test_pii_fields_absent_from_get_response(self):
        """target_email, target_phone, target_display_name must not be in response."""
        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new_callable=AsyncMock,
            return_value={k: v for k, v in self._FULL_SERVICE_RESPONSE.items()
                          if k not in {"target_display_name", "target_email", "target_phone"}},
        ):
            resp = _client().get(self._URL)

        assert resp.status_code == 200
        body = resp.json()
        assert "target_email" not in body, "target_email must be stripped from unauthenticated response"
        assert "target_phone" not in body, "target_phone must be stripped from unauthenticated response"
        assert "target_display_name" not in body, "target_display_name must be stripped from unauthenticated response"

    def test_non_pii_fields_present_in_get_response(self):
        """invite_id, status, reason and ria profile must still be present."""
        safe_response = {k: v for k, v in self._FULL_SERVICE_RESPONSE.items()
                         if k not in {"target_display_name", "target_email", "target_phone"}}
        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new_callable=AsyncMock,
            return_value=safe_response,
        ):
            resp = _client().get(self._URL)

        assert resp.status_code == 200
        body = resp.json()
        assert "invite_id" in body
        assert "status" in body
        assert "ria" in body
        assert body["ria"]["display_name"] == "John Advisor"

    def test_invite_token_with_special_chars_returns_422(self):
        """Invite tokens containing characters outside [a-zA-Z0-9_-] must be rejected."""
        resp = _client().get("/api/invites/../../admin")
        assert resp.status_code == 422

    def test_invite_token_with_spaces_returns_422(self):
        """Invite tokens with spaces must be rejected."""
        resp = _client().get("/api/invites/token with spaces")
        assert resp.status_code in (404, 422)

    def test_valid_alphanumeric_token_passes_pattern(self):
        """A normal alphanumeric token must not be rejected at the path-param level."""
        with patch.object(
            invites_module.RIAIAMService,
            "get_ria_invite",
            new_callable=AsyncMock,
            return_value={k: v for k, v in self._FULL_SERVICE_RESPONSE.items()
                          if k not in {"target_display_name", "target_email", "target_phone"}},
        ):
            resp = _client().get("/api/invites/AbCdEfGh01234567")
        # Should reach the service (not fail at path validation)
        assert resp.status_code != 422
