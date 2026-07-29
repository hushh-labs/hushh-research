"""Route-level proof that the unauthenticated GET /api/invites/{token} response
strips all target contact PII and internal accepted-state identifiers.

Kushal's requirement: tests must inject PII-bearing service rows and verify
the route (not a pre-stripped mock) removes them before returning.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.invites import router

_PII_BEARING_INVITE = {
    "invite_id": "inv-123",
    "invite_token": "tok-abc",
    "status": "sent",
    "firm_id": None,
    "scope_template_id": "standard",
    "duration_mode": "preset",
    "duration_hours": None,
    "reason": "Portfolio review",
    "expires_at": "2099-01-01T00:00:00+00:00",
    # Target PII -- must NOT appear in the public response
    "target_display_name": "Alice Target",
    "target_email": "alice@example.com",
    "target_phone": "+15550001234",
    # Internal identifiers -- must NOT appear in the public response
    "accepted_by_user_id": "uid-accepted-internal",
    "accepted_request_id": "req-internal-456",
    "ria": {
        "id": "ria-1",
        "user_id": "ria-uid",
        "display_name": "Bob RIA",
        "verification_status": "verified",
        "headline": "Growth investing",
        "strategy_summary": "Long-term equity",
        "bio": "10 years in markets",
        "firms": [],
    },
}


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_public_get_strips_target_pii(client: TestClient) -> None:
    """PII-bearing service row must not expose target fields in public response."""
    with patch(
        "api.routes.invites.RIAIAMService.get_ria_invite",
        new_callable=AsyncMock,
        return_value=_PII_BEARING_INVITE,
    ):
        resp = client.get("/api/invites/tok-abc")

    assert resp.status_code == 200, resp.text
    body = resp.json()

    for pii_field in ("target_display_name", "target_email", "target_phone"):
        assert pii_field not in body, (
            f"PII field '{pii_field}' must not appear in the public invite response"
        )


def test_public_get_strips_accepted_identifiers(client: TestClient) -> None:
    """Internal accepted_by_user_id and accepted_request_id must not appear publicly."""
    with patch(
        "api.routes.invites.RIAIAMService.get_ria_invite",
        new_callable=AsyncMock,
        return_value=_PII_BEARING_INVITE,
    ):
        resp = client.get("/api/invites/tok-abc")

    assert resp.status_code == 200, resp.text
    body = resp.json()

    for internal_field in ("accepted_by_user_id", "accepted_request_id"):
        assert internal_field not in body, (
            f"Internal field '{internal_field}' must not appear in the public invite response"
        )


def test_public_get_retains_landing_data(client: TestClient) -> None:
    """Public RIA profile and invite metadata must still be present."""
    with patch(
        "api.routes.invites.RIAIAMService.get_ria_invite",
        new_callable=AsyncMock,
        return_value=_PII_BEARING_INVITE,
    ):
        resp = client.get("/api/invites/tok-abc")

    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert "ria" in body, "RIA profile must remain in the public response"
    assert body["ria"]["display_name"] == "Bob RIA"
    assert "status" in body
    assert "scope_template_id" in body


def test_public_get_pii_values_not_in_response_text(client: TestClient) -> None:
    """The raw response body must not contain the PII strings at all."""
    with patch(
        "api.routes.invites.RIAIAMService.get_ria_invite",
        new_callable=AsyncMock,
        return_value=_PII_BEARING_INVITE,
    ):
        resp = client.get("/api/invites/tok-abc")

    assert resp.status_code == 200, resp.text
    raw = resp.text

    for pii_value in ("alice@example.com", "+15550001234", "Alice Target",
                      "uid-accepted-internal", "req-internal-456"):
        assert pii_value not in raw, (
            f"PII value '{pii_value}' must not appear anywhere in the public response body"
        )
