# mcp/tools/utility_tools.py
"""
Utility tool handlers (validate_token, delegate, list_scopes, discover_user_domains).

Supported data scopes are pkm.read, pkm.write, attr.{domain}.*, and optional
nested attr.{domain}.{subintent}.* scopes discovered per user.
"""

import json
import logging
import re

import httpx
from mcp.types import TextContent

from hushh_mcp.consent.scope_helpers import get_scope_description, get_scope_display_metadata
from hushh_mcp.consent.token import validate_token_with_db
from mcp_modules.config import FASTAPI_URL
from mcp_modules.developer_context import get_developer_api_headers

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

    # Use DB-backed validation logic for cross-instance revocation consistency
    #
    # Dynamic attr.* scopes must stay as raw strings here. Resolving
    # attr.social.relationships.* to the PKM_READ enum before validation changes
    # the requested scope to pkm.read and makes narrow dynamic tokens look wrong.
    valid, reason, token_obj = await validate_token_with_db(token_str, expected_scope_str)

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

    logger.info("✅ Token VALID (user=[redacted])")
    granted_scope = token_obj.scope_str or getattr(token_obj.scope, "value", str(token_obj.scope))

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "valid": True,
                    "user_id": token_obj.user_id,
                    "agent_id": token_obj.agent_id,
                    "scope": granted_scope,
                    "scope_enum": getattr(token_obj.scope, "value", str(token_obj.scope)),
                    "issued_at": token_obj.issued_at,
                    "expires_at": token_obj.expires_at,
                    "signature_verified": True,
                    "checks_passed": [
                        "✅ Signature valid (HMAC-SHA256)",
                        "✅ Not expired",
                        "✅ Not revoked (DB-backed cross-instance check)",
                        "✅ Scope matches" if expected_scope_str else "ℹ️ Scope not checked",
                    ],
                }
            ),
        )
    ]


async def handle_list_scopes(_args: dict | None = None) -> list[TextContent]:
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
                    "name": "cap.one.invoke",
                    "description": get_scope_description("cap.one.invoke"),
                },
                {
                    "name": "attr.{domain_slug}.{scope_slug}.*",
                    "description": "Dynamic semantic scope (discover per user first).",
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
    from .consent_tools import resolve_user_identifier_to_uid

    user_id = args.get("user_id") or ""
    country_iso2 = str(args.get("country_iso2") or "").strip() or None
    country = str(args.get("country") or "").strip() or None
    if not user_id.strip():
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "user_id is required",
                        "usage": "Call discover_user_domains with user_id (Firebase UID, registered email, or phone number). Use country_iso2/country for national numbers.",
                    }
                ),
            )
        ]

    resolved_uid, _email, _display = await resolve_user_identifier_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )
    if resolved_uid is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "User not found",
                        "user_id": user_id,
                        "hint": "Provide a valid Firebase UID, registered email, or phone number. Add country_iso2/country when the number is not already international.",
                    }
                ),
            )
        ]
    uid = resolved_uid

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            developer_headers = get_developer_api_headers()
            r = await client.get(
                f"{FASTAPI_URL}/api/v1/user-scopes/{uid}",
                headers=developer_headers,
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
                                "message": "No PKM domains for this user yet (new user or no domains yet)",
                                "usage": "Call request_consent with a discovered attr.{domain_slug}.{scope_slug}.* scope after the user adds data.",
                            }
                        ),
                    )
                ]
            if r.status_code == 401 and not developer_headers:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "error": "developer_token_missing",
                                "message": "HUSHH_DEVELOPER_TOKEN is required for discover_user_domains",
                                "hint": "Set HUSHH_DEVELOPER_TOKEN in the MCP environment to call /api/v1/user-scopes/{user_id}.",
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
    domains = [
        str(domain).strip()
        for domain in (data.get("available_domains") or [])
        if str(domain).strip()
    ]
    if not domains:
        derived_domains = []
        for s in scopes:
            scope_value = s.get("scope") if isinstance(s, dict) else s
            m = re.match(r"^attr\.([a-zA-Z0-9_]+)(?:\..*)?$", str(scope_value or ""))
            if m:
                derived_domains.append(m.group(1))
        domains = sorted(set(derived_domains))

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


async def handle_search_user_scopes(args: dict) -> list[TextContent]:
    """
    Search and rank a user's discoverable scopes by intent.

    Calls GET /api/v1/user-scopes/{user_id}/search. Ranking is deterministic on
    the backend (exact domain > substring > fuzzy), least-privilege first. This
    is a graceful lookup: unknown domain or no match returns an empty match list
    plus available domains, never an error.
    """
    from .consent_tools import resolve_user_identifier_to_uid

    user_id = args.get("user_id") or ""
    query = str(args.get("query") or "").strip()
    domain = str(args.get("domain") or "").strip()
    country_iso2 = str(args.get("country_iso2") or "").strip() or None
    country = str(args.get("country") or "").strip() or None
    try:
        limit = max(1, min(int(args.get("limit") or 20), 50))
    except (TypeError, ValueError):
        limit = 20

    if not user_id.strip():
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "user_id is required",
                        "usage": "Call search_user_scopes with user_id and an optional query/domain to rank scopes.",
                    }
                ),
            )
        ]

    resolved_uid, _email, _display = await resolve_user_identifier_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )
    if resolved_uid is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "User not found",
                        "user_id": user_id,
                        "hint": "Provide a valid Firebase UID, registered email, or phone number. Add country_iso2/country when the number is not already international.",
                    }
                ),
            )
        ]
    uid = resolved_uid

    params: dict[str, str | int] = {"limit": limit}
    if query:
        params["query"] = query
    if domain:
        params["domain"] = domain

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            developer_headers = get_developer_api_headers()
            r = await client.get(
                f"{FASTAPI_URL}/api/v1/user-scopes/{uid}/search",
                params=params,
                headers=developer_headers,
            )
            if r.status_code == 404:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "user_id": uid,
                                "query": query or None,
                                "domain": domain or None,
                                "matches": [],
                                "available_domains": [],
                                "message": "No PKM domains for this user yet (new user or no domains yet)",
                            }
                        ),
                    )
                ]
            if r.status_code == 401 and not developer_headers:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "error": "developer_token_missing",
                                "message": "HUSHH_DEVELOPER_TOKEN is required for search_user_scopes",
                                "hint": "Set HUSHH_DEVELOPER_TOKEN in the MCP environment to call /api/v1/user-scopes/{user_id}/search.",
                            }
                        ),
                    )
                ]
            r.raise_for_status()
            data = r.json()
    except httpx.ConnectError as e:
        logger.warning(f"⚠️ Search scopes: backend not reachable: {e}")
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
        logger.exception("Search user scopes failed")
        return [
            TextContent(type="text", text=json.dumps({"error": "search_failed", "message": str(e)}))
        ]

    raw_matches = data.get("matches") or []
    enriched_matches = []
    for entry in raw_matches:
        scope_value = entry.get("scope") if isinstance(entry, dict) else entry
        meta = get_scope_display_metadata(scope_value)
        enriched_matches.append(
            {
                "scope": scope_value,
                "domain": (entry.get("domain") if isinstance(entry, dict) else None),
                "match_reason": (entry.get("match_reason") if isinstance(entry, dict) else None),
                "label": meta["label"],
                "description": meta["description"],
                "icon_name": meta.get("icon_name"),
                "color_hex": meta.get("color_hex"),
            }
        )

    available_domains = [
        str(d).strip() for d in (data.get("available_domains") or []) if str(d).strip()
    ]

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "user_id": data.get("user_id", uid),
                    "query": query or None,
                    "domain": domain or None,
                    "matches": enriched_matches,
                    "available_domains": available_domains,
                    "usage": "Call request_consent(user_id, scope) with the least-privilege scope that fits your purpose.",
                }
            ),
        )
    ]
