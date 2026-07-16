from __future__ import annotations

import json

import pytest
from mcp.types import TextContent

from mcp_modules.public_contract import validate_public_tool_output
from mcp_modules.tools import campaign_context_tools as campaign


def _result(payload: dict):
    return [TextContent(type="text", text=json.dumps(payload))], payload


@pytest.mark.asyncio
async def test_campaign_compatibility_uses_new_refs_without_identity_or_token_leak(monkeypatch):
    request_ref = "req_" + "a" * 28

    async def search(_args):
        return _result(
            {
                "status": "success",
                "scopes": [
                    {
                        "scope": "attr.financial.portfolio.*",
                        "domain": "financial",
                        "label": "Portfolio",
                        "description": "Investment holdings.",
                    },
                    {
                        "scope": "attr.shopping.receipts_memory.*",
                        "domain": "shopping",
                        "label": "Shopping receipts",
                        "description": "Purchase and shopping preferences.",
                    },
                ],
                "next_cursor": None,
                "has_more": False,
            }
        )

    async def request(args):
        assert args["user_identifier"] == "private@example.com"
        assert args["scope"] == "attr.shopping.receipts_memory.*"
        return _result(
            {
                "status": "pending",
                "scope": args["scope"],
                "coverage_kind": None,
                "request_ref": request_ref,
                "expires_at": None,
                "poll_after_seconds": 5,
                "approval_timeout_at": 9999999999999,
            }
        )

    monkeypatch.setattr(campaign, "handle_search_user_scopes", search)
    monkeypatch.setattr(campaign, "handle_request_consent", request)
    _content, payload = await campaign.handle_prepare_campaign_context(
        {
            "user_id": "private@example.com",
            "campaign_goal": "improve a shopping commerce activation",
            "connector_public_key": "A" * 44,
            "connector_key_id": "ads-key",
            "connector_wrapping_alg": "X25519-AES256-GCM",
            "poll_seconds": 0,
        }
    )

    assert payload["status"] == "pending"
    assert payload["request_id"] == request_ref
    assert payload["request_ref"] == request_ref
    assert payload["selected_scope"] == "attr.shopping.receipts_memory.*"
    serialized = json.dumps(payload)
    assert "private@example.com" not in serialized
    assert "connector_public_key" not in serialized
    assert "consent_token" not in serialized
    assert validate_public_tool_output("prepare_campaign_context", payload)


@pytest.mark.asyncio
async def test_campaign_compatibility_reports_export_readiness_without_export_payload(monkeypatch):
    grant_ref = "req_" + "b" * 28

    async def search(_args):
        return _result(
            {
                "status": "success",
                "scopes": [
                    {
                        "scope": "attr.travel.preferences.*",
                        "domain": "travel",
                        "label": "Travel preferences",
                        "description": "Approved travel preferences.",
                    }
                ],
                "next_cursor": None,
                "has_more": False,
            }
        )

    async def request(args):
        return _result(
            {
                "status": "granted",
                "scope": args["scope"],
                "coverage_kind": "exact",
                "grant_ref": grant_ref,
                "expires_at": 9999999999999,
                "poll_after_seconds": None,
                "approval_timeout_at": None,
            }
        )

    async def export(_args):
        return _result(
            {
                "status": "success",
                "export_revision": 4,
                "consent_token": "must-not-pass-through",
                "information": {"private": "must-not-pass-through"},
            }
        )

    monkeypatch.setattr(campaign, "handle_search_user_scopes", search)
    monkeypatch.setattr(campaign, "handle_request_consent", request)
    monkeypatch.setattr(campaign, "handle_get_encrypted_scoped_export", export)
    _content, payload = await campaign.handle_prepare_campaign_context(
        {
            "user_identifier": "private@example.com",
            "campaign_goal": "improve a travel customer experience",
            "fetch_export_metadata": True,
        }
    )

    assert payload["status"] == "granted"
    assert payload["grant_ref"] == grant_ref
    assert payload["grant_reused"] is True
    assert payload["export_metadata_ready"] is True
    assert payload["export_revision"] == 4
    assert "must-not-pass-through" not in json.dumps(payload)
    assert validate_public_tool_output("prepare_campaign_context", payload)


@pytest.mark.asyncio
async def test_campaign_compatibility_maps_cancelled_for_legacy_adk(monkeypatch):
    request_ref = "req_" + "c" * 28

    async def search(_args):
        return _result(
            {
                "status": "success",
                "scopes": [
                    {
                        "scope": "attr.shopping.receipts_memory.*",
                        "domain": "shopping",
                        "label": "Shopping receipts",
                        "description": "Purchase history.",
                    }
                ],
                "next_cursor": None,
                "has_more": False,
            }
        )

    async def request(_args):
        return _result(
            {
                "status": "cancelled",
                "scope": "attr.shopping.receipts_memory.*",
                "coverage_kind": None,
                "request_ref": request_ref,
                "expires_at": None,
                "poll_after_seconds": None,
                "approval_timeout_at": None,
            }
        )

    monkeypatch.setattr(campaign, "handle_search_user_scopes", search)
    monkeypatch.setattr(campaign, "handle_request_consent", request)
    _content, payload = await campaign.handle_prepare_campaign_context(
        {
            "user_id": "private@example.com",
            "campaign_goal": "personalize shopping",
            "poll_seconds": 0,
        }
    )

    assert payload["status"] == "expired"
    assert payload["state"] == "expired"
    assert payload["request_ref"] == request_ref
    assert validate_public_tool_output("prepare_campaign_context", payload)
