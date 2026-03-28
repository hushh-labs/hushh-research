"""Read-only RIA and marketplace MCP tools."""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.types import TextContent

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.ria_iam_service import RIAIAMService

logger = logging.getLogger("hushh-mcp-server")


def _authorize_user(user_id: str, consent_token: str) -> tuple[bool, str | None]:
    valid, reason, payload = validate_token(consent_token, ConsentScope.VAULT_OWNER)
    if not valid or payload is None:
        return False, reason
    if payload.user_id != user_id:
        return False, "token_user_mismatch"
    return True, None


def _ok(payload: dict[str, Any]) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(payload, default=str))]


async def handle_list_ria_profiles(args: dict) -> list[TextContent]:
    service = RIAIAMService()
    items = await service.search_marketplace_rias(
        query=(args.get("query") or None),
        limit=int(args.get("limit") or 20),
        firm=(args.get("firm") or None),
        verification_status=(args.get("verification_status") or None),
    )
    return _ok({"status": "ok", "items": items})


async def handle_get_ria_profile(args: dict) -> list[TextContent]:
    ria_id = str(args.get("ria_id") or "").strip()
    if not ria_id:
        return _ok({"status": "error", "error": "ria_id is required"})

    service = RIAIAMService()
    profile = await service.get_marketplace_ria_profile(ria_id)
    if profile is None:
        return _ok({"status": "not_found", "ria_id": ria_id})
    return _ok({"status": "ok", "profile": profile})


async def handle_list_marketplace_investors(args: dict) -> list[TextContent]:
    service = RIAIAMService()
    items = await service.search_marketplace_investors(
        query=(args.get("query") or None),
        limit=int(args.get("limit") or 20),
    )
    return _ok({"status": "ok", "items": items})


async def handle_get_ria_verification_status(args: dict) -> list[TextContent]:
    user_id = str(args.get("user_id") or "").strip()
    consent_token = str(args.get("consent_token") or "").strip()
    if not user_id or not consent_token:
        return _ok({"status": "error", "error": "user_id and consent_token are required"})

    allowed, reason = _authorize_user(user_id, consent_token)
    if not allowed:
        return _ok({"status": "forbidden", "reason": reason})

    service = RIAIAMService()
    status = await service.get_ria_onboarding_status(user_id)
    return _ok({"status": "ok", "verification": status})


async def handle_get_ria_client_access_summary(args: dict) -> list[TextContent]:
    user_id = str(args.get("user_id") or "").strip()
    consent_token = str(args.get("consent_token") or "").strip()
    if not user_id or not consent_token:
        return _ok({"status": "error", "error": "user_id and consent_token are required"})

    allowed, reason = _authorize_user(user_id, consent_token)
    if not allowed:
        return _ok({"status": "forbidden", "reason": reason})

    service = RIAIAMService()
    clients_payload = await service.list_ria_clients(user_id)
    clients = list(clients_payload.get("items") or [])
    approved = sum(1 for item in clients if item.get("status") == "approved")
    pending = sum(1 for item in clients if item.get("status") == "request_pending")
    return _ok(
        {
            "status": "ok",
            "summary": {
                "total_clients": len(clients),
                "approved_clients": approved,
                "pending_clients": pending,
            },
            "items": clients,
        }
    )
