# mcp/tools/utility_tools.py
"""
Utility tool handlers (validate_token, delegate, list_scopes, discover_user_domains).

Only world-model scopes are supported: world_model.read, world_model.write,
attr.{domain}.*, and optional nested attr.{domain}.{subintent}.* scopes.
"""

import json
import logging
import re

import httpx
from mcp.types import TextContent

from hushh_mcp.consent.scope_helpers import (
    get_scope_description,
    get_scope_display_metadata,
    resolve_scope_to_enum,
)
from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import AGENT_PORTS
from hushh_mcp.trust.link import create_trust_link, verify_trust_link
from hushh_mcp.types import AgentID, UserID
from mcp_modules.config import FASTAPI_URL
from mcp_modules.developer_context import get_developer_request_query

logger = logging.getLogger("hushh-mcp-server")


async def handle_validate_token(args: dict) -> list[TextContent]:
    """
    Validate a consent token.

    Compliance:
    ✅ Signature verification (HMAC-SHA256)
    ✅ Expiration check
    ✅ Revocation check
    ✅ Scope verification (if provided)
    """
    token_str = args.get("token")
    expected_scope_str = args.get("expected_scope")

    # Determine expected scope if provided using centralized resolver
    expected_scope = None
    if expected_scope_str:
        expected_scope = resolve_scope_to_enum(expected_scope_str)

    # Use existing validation logic
    valid, reason, token_obj = validate_token(token_str, expected_scope)

    if not valid:
        logger.warning(f"❌ Token INVALID: {reason}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "valid": False,
                        "reason": reason,
                        "hint": "Call request_consent to obtain a new valid token",
                    }
                ),
            )
        ]

    logger.info(f"✅ Token VALID for user={token_obj.user_id}")

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "valid": True,
                    "user_id": token_obj.user_id,
                    "agent_id": token_obj.agent_id,
                    "scope": str(token_obj.scope),
                    "issued_at": token_obj.issued_at,
                    "expires_at": token_obj.expires_at,
                    "signature_verified": True,
                    "checks_passed": [
                        "✅ Signature valid (HMAC-SHA256)",
                        "✅ Not expired",
                        "✅ Not revoked",
                        "✅ Scope matches" if expected_scope else "ℹ️ Scope not checked",
                    ],
                }
            ),
        )
    ]


async def handle_delegate(args: dict) -> list[TextContent]:
    """
    Create TrustLink for agent-to-agent delegation.

    Compliance:
    ✅ HushhMCP: A2A delegation via TrustLink
    ✅ Cryptographically signed delegation proof
    ✅ Scoped and time-limited
    ✅ User authorization recorded
    """
    from_agent = args.get("from_agent")
    to_agent = args.get("to_agent")
    scope_str = args.get("scope")
    user_id = args.get("user_id")

    # Map scope string to enum
    # NOTE: Legacy VAULT_READ_* scopes have been removed.
    # Parse scope using centralized resolver
    scope = resolve_scope_to_enum(scope_str)

    # Create TrustLink
    trust_link = create_trust_link(
        from_agent=AgentID(from_agent),
        to_agent=AgentID(to_agent),
        scope=scope,
        signed_by_user=UserID(user_id),
    )

    # Verify the TrustLink
    is_valid = verify_trust_link(trust_link)

    logger.info(f"🔗 TrustLink CREATED: {from_agent} → {to_agent} (scope={scope_str})")

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "status": "delegated",
                    "trust_link": {
                        "from_agent": trust_link.from_agent,
                        "to_agent": trust_link.to_agent,
                        "scope": str(trust_link.scope),
                        "authorized_by_user": trust_link.signed_by_user,
                        "created_at": trust_link.created_at,
                        "expires_at": trust_link.expires_at,
                        "signature": trust_link.signature[:20] + "...",
                        "signature_verified": is_valid,
                    },
                    "message": f"Task delegated from {from_agent} to {to_agent}",
                    "target_port": AGENT_PORTS.get(to_agent, 10000),
                    "a2a_note": "This TrustLink can be verified by the target agent to confirm delegation authority.",
                }
            ),
        )
    ]


async def handle_list_scopes() -> list[TextContent]:
    """
    List scope categories using backend dynamic registry output.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{FASTAPI_URL}/api/v1/list-scopes")
            response.raise_for_status()
            data = response.json()
            return [TextContent(type="text", text=json.dumps(data))]
    except Exception as e:
        logger.warning("list_scopes backend fallback: %s", e)
        fallback = {
            "scopes": [
                {
                    "name": "world_model.read",
                    "description": get_scope_description("world_model.read"),
                },
                {
                    "name": "world_model.write",
                    "description": get_scope_description("world_model.write"),
                },
                {
                    "name": "attr.{domain}.*",
                    "description": "Dynamic domain scope (discover per user first).",
                },
                {
                    "name": "attr.{domain}.{subintent}.*",
                    "description": "Dynamic subintent scope when metadata exposes subintents.",
                },
            ],
            "scopes_are_dynamic": True,
            "note": "Use discover_user_domains(user_id) for user-specific scope strings.",
            "fallback_reason": str(e),
        }
        return [TextContent(type="text", text=json.dumps(fallback))]


async def handle_discover_user_domains(args: dict) -> list[TextContent]:
    """
    Discover which domains a user has and the scope strings to request.
    Calls GET /api/v1/user-scopes/{user_id}. Use before request_consent.
    """
    from .consent_tools import resolve_email_to_uid

    user_id = args.get("user_id") or ""
    if not user_id.strip():
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "user_id is required",
                        "usage": "Call discover_user_domains with user_id (Firebase UID or email)",
                    }
                ),
            )
        ]

    resolved_uid, _email, _display = await resolve_email_to_uid(user_id)
    if resolved_uid is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "User not found",
                        "user_id": user_id,
                        "hint": "Provide a valid Firebase UID or registered email",
                    }
                ),
            )
        ]
    uid = resolved_uid

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            token_query = get_developer_request_query()
            r = await client.get(
                f"{FASTAPI_URL}/api/v1/user-scopes/{uid}",
                params=token_query or None,
            )
            if r.status_code == 404:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "user_id": uid,
                                "domains": [],
                                "scopes": [],
                                "message": "No world model data for this user (new user or no domains yet)",
                                "usage": "Call request_consent with scope='world_model.read' or attr.{domain}.* after user adds data",
                            }
                        ),
                    )
                ]
            if r.status_code == 401 and not token_query:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "error": "developer_token_missing",
                                "message": "HUSHH_DEVELOPER_TOKEN is required for discover_user_domains",
                                "hint": "Set HUSHH_DEVELOPER_TOKEN in MCP environment to call /api/v1/user-scopes/{user_id}. MCP_DEVELOPER_TOKEN remains a compatibility alias.",
                            }
                        ),
                    )
                ]
            r.raise_for_status()
            data = r.json()
    except httpx.ConnectError as e:
        logger.warning(f"⚠️ Discover domains: backend not reachable: {e}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "Cannot reach backend",
                        "message": str(e),
                        "hint": f"Ensure FastAPI is running at {FASTAPI_URL}",
                    }
                ),
            )
        ]
    except Exception as e:
        logger.exception("Discover user domains failed")
        return [
            TextContent(
                type="text", text=json.dumps({"error": "discover_failed", "message": str(e)})
            )
        ]

    scopes = data.get("scopes") or []
    domains = []
    for s in scopes:
        m = re.match(r"^attr\.([a-zA-Z0-9_]+)(?:\..*)?$", s)
        if m:
            domains.append(m.group(1))
    domains = sorted(set(domains))

    # Enrich each scope with display metadata (label, icon, color)
    enriched_scopes = []
    for s in scopes:
        meta = get_scope_display_metadata(s)
        enriched_scopes.append(
            {
                "scope": s,
                "label": meta["label"],
                "description": meta["description"],
                "icon_name": meta.get("icon_name"),
                "color_hex": meta.get("color_hex"),
            }
        )

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "user_id": data.get("user_id", uid),
                    "domains": domains,
                    "scopes": enriched_scopes,
                    "usage": "Call request_consent(user_id, scope) with one of the scopes above to request consent",
                }
            ),
        )
    ]
