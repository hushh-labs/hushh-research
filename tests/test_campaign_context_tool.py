from __future__ import annotations

import json

import pytest
from mcp.types import TextContent

from mcp_modules.tools import campaign_context_tools as cct


def _content(payload: dict) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(payload))]


DISCOVERY_PAYLOAD = {
    "user_id": "uid_123",
    "domains": ["financial", "shopping", "location"],
    "scopes": [
        {
            "scope": "attr.financial.analysis.*",
            "label": "All Financial Data",
            "description": "Financial analysis stream",
        },
        {
            "scope": "attr.shopping.receipts_memory.*",
            "label": "Shopping Receipts",
            "description": "Shopping and receipt memory, including bookings and purchases",
        },
        {
            "scope": "attr.location.preferences.*",
            "label": "Location Preferences",
            "description": "Geographic preferences and destination anchors",
        },
    ],
}


@pytest.mark.asyncio
async def test_prepare_campaign_context_prefers_shopping_receipts_over_financial_for_trip(
    monkeypatch,
):
    calls: list[tuple[str, dict]] = []

    async def fake_discover(args):
        calls.append(("discover", args))
        return _content(DISCOVERY_PAYLOAD)

    async def fake_status(args):
        calls.append(("status", args))
        return _content({"status": "not_found", "user_id": args["user_id"], "scope": args["scope"]})

    monkeypatch.setattr(cct, "handle_discover_user_domains", fake_discover)
    monkeypatch.setattr(cct, "handle_check_consent_status", fake_status)

    result = await cct.handle_prepare_campaign_context(
        {
            "user_id": "kushal@example.com",
            "campaign_goal": "Help make the next customer experience feel more relevant for someone considering a trip.",
            "poll_seconds": 0,
        }
    )

    payload = json.loads(result[0].text)
    assert payload["state"] == "needs_connector_key_bundle"
    assert payload["selected_scope"] == "attr.shopping.receipts_memory.*"
    assert payload["selected_category_label"] == "Shopping Receipts"
    assert payload["selected_domain"] == "shopping"
    assert "connector_public_key" in payload["required_fields"]
    assert calls[0][0] == "discover"
    assert calls[1] == (
        "status",
        {"user_id": "uid_123", "scope": "attr.shopping.receipts_memory.*"},
    )


@pytest.mark.asyncio
async def test_prepare_campaign_context_explicit_location_request_creates_pending_with_scope(
    monkeypatch,
):
    calls: list[tuple[str, dict]] = []

    async def fake_discover(args):
        calls.append(("discover", args))
        return _content(DISCOVERY_PAYLOAD)

    async def fake_status(args):
        calls.append(("status", args))
        return _content({"status": "not_found", "user_id": args["user_id"], "scope": args["scope"]})

    async def fake_request(args):
        calls.append(("request", args))
        return _content(
            {
                "status": "pending",
                "user_id": args["user_id"],
                "scope": args["scope"],
                "request_id": "req_location",
                "approval_timeout_minutes": args["approval_timeout_minutes"],
                "expiry_hours": args["expiry_hours"],
            }
        )

    monkeypatch.setattr(cct, "handle_discover_user_domains", fake_discover)
    monkeypatch.setattr(cct, "handle_check_consent_status", fake_status)
    monkeypatch.setattr(cct, "handle_request_consent", fake_request)

    result = await cct.handle_prepare_campaign_context(
        {
            "user_id": "kushal@example.com",
            "campaign_goal": "Can you get the location preference for this trip experience?",
            "preferred_context": "location",
            "poll_seconds": 0,
            "connector_public_key": "public_key",
            "connector_key_id": "key_1",
            "connector_wrapping_alg": "X25519-AES256-GCM",
        }
    )

    payload = json.loads(result[0].text)
    assert payload["state"] == "pending_approval"
    assert payload["selected_scope"] == "attr.location.preferences.*"
    assert payload["request_id"] == "req_location"
    assert payload["requested_duration_hours"] == 24
    assert payload["approval_timeout_minutes"] == 1440
    assert calls[1][0] == "status"
    assert calls[2][0] == "request"


@pytest.mark.asyncio
async def test_prepare_campaign_context_granted_fetches_safe_export_metadata(monkeypatch):
    async def fake_discover(_args):
        return _content(DISCOVERY_PAYLOAD)

    async def fake_status(args):
        return _content(
            {
                "status": "granted",
                "user_id": args["user_id"],
                "scope": args["scope"],
                "requested_scope": args["scope"],
                "granted_scope": args["scope"],
                "coverage_kind": "exact",
                "request_id": "req_existing",
                "consent_token": "token_secret",
                "expires_at": 1234,
            }
        )

    async def fake_export(_args):
        return _content(
            {
                "status": "success",
                "scope": "attr.shopping.receipts_memory.*",
                "export_revision": 3,
                "export_generated_at": "2026-06-01T00:00:00Z",
                "encrypted_data": "ciphertext",
                "iv": "iv",
                "tag": "tag",
                "wrapped_key_bundle": {"wrapped": "key"},
            }
        )

    monkeypatch.setattr(cct, "handle_discover_user_domains", fake_discover)
    monkeypatch.setattr(cct, "handle_check_consent_status", fake_status)
    monkeypatch.setattr(cct, "handle_get_encrypted_scoped_export", fake_export)

    result = await cct.handle_prepare_campaign_context(
        {
            "user_id": "kushal@example.com",
            "campaign_goal": "Help make a trip experience more relevant.",
            "poll_seconds": 0,
        }
    )

    payload = json.loads(result[0].text)
    assert payload["state"] == "approved_ready"
    assert payload["lifecycle_action"] == "already_granted_reused"
    assert payload["plaintext_returned"] is False
    assert payload["encrypted_export_ready"] is True
    metadata = payload["encrypted_export_metadata"]
    assert metadata["export_revision"] == 3
    assert "encrypted_data" not in metadata
    assert "iv" not in metadata
    assert "tag" not in metadata
    assert "wrapped_key_bundle" not in metadata
    assert "consent_token" not in payload
