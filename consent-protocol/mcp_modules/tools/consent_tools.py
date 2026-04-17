# mcp/tools/consent_tools.py
"""
Consent request and status check handlers.

Canonical PKM scopes are supported: pkm.read, pkm.write,
attr.{domain}.*, and optional nested attr.{domain}.{subintent}.* scopes.

Regulated cutover note:
- request_consent no longer performs blocking SSE/poll waits for consent resolution.
- caller receives `pending` and must wait for user approval in-app (FCM-driven flow).
"""

import json
import logging
from typing import Optional

import httpx
from mcp.types import TextContent

from mcp_modules.config import (
    DEVELOPER_API_ENABLED,
    FASTAPI_URL,
    PRODUCTION_MODE,
    resolve_scope_api,
)
from mcp_modules.developer_context import get_developer_request_headers, get_developer_request_query

logger = logging.getLogger("hushh-mcp-server")


async def resolve_email_to_uid(user_id: str) -> tuple[Optional[str], str | None, str | None]:
    """
    If user_id is an email, resolve to Firebase UID.
    Returns (user_id, email, display_name).
    """
    if not user_id or "@" not in user_id:
        return user_id, None, None

    token_headers = get_developer_request_headers()
    if not token_headers:
        logger.warning("Email-to-UID lookup skipped: developer token not configured")
        return user_id, None, None

    try:
        async with httpx.AsyncClient() as client:
            lookup_response = await client.get(
                f"{FASTAPI_URL}/api/user/lookup",
                params={"email": user_id},
                headers=token_headers,
                timeout=10.0,
            )

            if lookup_response.status_code == 200:
                lookup_data = lookup_response.json()
                if lookup_data.get("exists"):
                    resolved_uid = lookup_data["user_id"]
                    email = lookup_data.get("email")
                    display_name = lookup_data.get("display_name")
                    logger.info("Resolved email to uid for consent request")
                    return resolved_uid, email, display_name
                return None, user_id, None

            logger.warning("Email lookup failed with status=%s", lookup_response.status_code)
    except Exception as e:
        logger.warning("Email lookup failed: %s", e)

    return user_id, None, None


async def handle_request_consent(args: dict) -> list[TextContent]:
    """
    Request consent from a user.

    In production, this endpoint returns:
    - granted: if already granted
    - pending: user must approve in Hushh app/dashboard
    """
    user_id = args.get("user_id")
    scope_str = args.get("scope")
    scope_bundle_key = args.get("scope_bundle")

    # If a scope bundle is provided, expand it and use the first scope
    # (bundled consent creates one request per scope in the bundle)
    if scope_bundle_key and not scope_str:
        from hushh_mcp.consent.scope_bundles import expand_bundle

        try:
            expanded = expand_bundle(scope_bundle_key)
            scope_str = expanded[0] if len(expanded) == 1 else expanded[0]
            # For multi-scope bundles, we request the domain wildcard
            if len(expanded) > 1:
                # Find common domain prefix or use first scope
                scope_str = expanded[0]
        except ValueError:
            return [
                TextContent(
                    type="text",
                    text=json.dumps(
                        {
                            "status": "error",
                            "error": f"Unknown scope bundle: {scope_bundle_key}",
                            "available_bundles": [
                                "financial_overview",
                                "full_portfolio_review",
                                "risk_assessment",
                                "health_wellness",
                                "lifestyle_preferences",
                            ],
                        }
                    ),
                )
            ]

    reason = str(args.get("reason") or "").strip() or None
    expiry_hours = args.get("expiry_hours")
    approval_timeout_minutes = args.get("approval_timeout_minutes")
    connector_public_key = str(args.get("connector_public_key") or "").strip()
    connector_key_id = str(args.get("connector_key_id") or "").strip()
    connector_wrapping_alg = str(args.get("connector_wrapping_alg") or "").strip()

    try:
        resolved_expiry_hours = int(expiry_hours) if expiry_hours is not None else 24
    except (TypeError, ValueError):
        resolved_expiry_hours = 24
    try:
        resolved_approval_timeout_minutes = (
            int(approval_timeout_minutes) if approval_timeout_minutes is not None else 24 * 60
        )
    except (TypeError, ValueError):
        resolved_approval_timeout_minutes = 24 * 60

    original_identifier = user_id
    user_id, user_email, user_display_name = await resolve_email_to_uid(user_id)

    if user_id is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "user_not_found",
                        "email": original_identifier,
                        "message": f"No Hushh account found for {original_identifier}",
                        "next_step": "Ask the user to sign in to the Hushh app before requesting consent.",
                    }
                ),
            )
        ]

    scope_dot = resolve_scope_api(scope_str)
    if not scope_dot:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error": f"Invalid scope: {scope_str}",
                        "valid_scopes": [
                            "pkm.read",
                            "pkm.write",
                            "attr.{domain}.*",
                            "attr.{domain}.{subintent}.*",
                        ],
                        "hint": "Use discover_user_domains(user_id) to fetch actual per-user scope strings.",
                    }
                ),
            )
        ]

    if not DEVELOPER_API_ENABLED:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "developer_api_disabled",
                        "error_code": "DEVELOPER_API_DISABLED_IN_PRODUCTION",
                        "message": "Developer API is disabled in production.",
                    }
                ),
            )
        ]

    token_query = get_developer_request_query()
    if not token_query:
        logger.error("request_consent aborted: developer token missing")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error": "Developer token is not configured",
                    }
                ),
            )
        ]

    if not PRODUCTION_MODE:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error": "Production mode requires explicit user consent",
                        "message": "Auto-granting tokens is disabled.",
                    }
                ),
            )
        ]

    display_id = user_display_name or user_email or user_id
    logger.info("Requesting consent for %s / %s", display_id, scope_str)
    if not all([connector_public_key, connector_key_id, connector_wrapping_alg]):
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error": (
                            "Strict zero-knowledge mode requires connector_public_key, "
                            "connector_key_id, and connector_wrapping_alg."
                        ),
                        "hint": (
                            "Generate an X25519 keypair in the external connector, keep the private key there, "
                            "and pass the public bundle into request_consent."
                        ),
                    }
                ),
            )
        ]

    try:
        async with httpx.AsyncClient() as client:
            create_response = await client.post(
                f"{FASTAPI_URL}/api/v1/request-consent",
                params=token_query,
                json={
                    "user_id": user_id,
                    "scope": scope_dot,
                    "reason": reason,
                    "expiry_hours": resolved_expiry_hours,
                    "approval_timeout_minutes": resolved_approval_timeout_minutes,
                    "connector_public_key": connector_public_key,
                    "connector_key_id": connector_key_id,
                    "connector_wrapping_alg": connector_wrapping_alg,
                },
                timeout=10.0,
            )

            if create_response.status_code != 200:
                response_payload = create_response.json()
                detail = response_payload.get("detail")
                error_code = response_payload.get("error_code")
                message = response_payload.get("message")

                if isinstance(detail, dict):
                    error_code = detail.get("error_code", error_code)
                    message = detail.get("message", message)

                if (
                    create_response.status_code == 410
                    and error_code == "DEVELOPER_API_DISABLED_IN_PRODUCTION"
                ):
                    return [
                        TextContent(
                            type="text",
                            text=json.dumps(
                                {
                                    "status": "developer_api_disabled",
                                    "error_code": "DEVELOPER_API_DISABLED_IN_PRODUCTION",
                                    "message": message
                                    or "Developer API is disabled in production.",
                                }
                            ),
                        )
                    ]

                error_detail = message or detail or "Unknown error"
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "status": "error",
                                "error": error_detail,
                                "hint": "Check backend availability and developer registration.",
                            }
                        ),
                    )
                ]

            data = create_response.json()
            status = data.get("status")

            if status == "already_granted":
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "status": "granted",
                                "consent_token": data.get("consent_token"),
                                "user_id": user_id,
                                "scope": data.get("scope", scope_dot),
                                "requested_scope": data.get(
                                    "requested_scope", data.get("scope", scope_dot)
                                ),
                                "granted_scope": data.get(
                                    "granted_scope", data.get("scope", scope_dot)
                                ),
                                "coverage_kind": data.get("coverage_kind", "exact"),
                                "covered_by_existing_grant": data.get(
                                    "covered_by_existing_grant", True
                                ),
                                "expiry_hours": data.get("expiry_hours"),
                                "request_url": data.get("request_url"),
                                "requester_label": data.get("requester_label"),
                                "requester_image_url": data.get("requester_image_url"),
                                "reason": data.get("reason"),
                                "message": data.get("message", "Consent already granted."),
                            }
                        ),
                    )
                ]

            if status == "denied_recently":
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "status": "denied_recently",
                                "user_id": user_id,
                                "scope": data.get("scope", scope_dot),
                                "message": data.get(
                                    "message",
                                    "This scope was recently denied. Wait before requesting again.",
                                ),
                            }
                        ),
                    )
                ]

            if status and status != "pending":
                return [TextContent(type="text", text=json.dumps(data))]

            request_id = data.get("request_id")
            if not request_id:
                message = data.get("message", "")
                if "Request ID:" in message:
                    request_id = message.split("Request ID:")[-1].strip()

            return [
                TextContent(
                    type="text",
                    text=json.dumps(
                        {
                            "status": "pending",
                            "user_id": user_id,
                            "scope": data.get("scope", scope_dot),
                            "requested_scope": data.get(
                                "requested_scope", data.get("scope", scope_dot)
                            ),
                            "granted_scope": data.get("granted_scope"),
                            "coverage_kind": data.get("coverage_kind"),
                            "covered_by_existing_grant": data.get(
                                "covered_by_existing_grant", False
                            ),
                            "request_id": request_id,
                            "message": data.get(
                                "message",
                                "Consent request submitted. User approval is pending in Hushh app.",
                            ),
                            "approval_surface": data.get("approval_surface", "/consents"),
                            "request_url": data.get("request_url"),
                            "approval_timeout_at": data.get("approval_timeout_at")
                            or data.get("poll_timeout_at"),
                            "approval_timeout_minutes": data.get("approval_timeout_minutes"),
                            "expiry_hours": data.get("expiry_hours"),
                            "requester_label": data.get("requester_label"),
                            "requester_image_url": data.get("requester_image_url"),
                            "reason": data.get("reason"),
                            "is_scope_upgrade": data.get("is_scope_upgrade"),
                            "existing_granted_scopes": data.get("existing_granted_scopes"),
                            "additional_access_summary": data.get("additional_access_summary"),
                            "next_step": "Call check_consent_status later, or wait for user confirmation.",
                        }
                    ),
                )
            ]

    except httpx.ConnectError as e:
        logger.error("Consent backend unavailable at %s: %s", FASTAPI_URL, e)
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error": "Consent backend unavailable",
                        "message": f"Cannot reach consent server at {FASTAPI_URL}.",
                    }
                ),
            )
        ]
    except Exception as e:
        logger.error("Error requesting consent: %s", e)
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error": "Consent request failed",
                    }
                ),
            )
        ]


async def handle_check_consent_status(args: dict) -> list[TextContent]:
    """
    Check consent status - returns active token if available, or pending status.
    """
    user_id = args.get("user_id")
    scope_str = args.get("scope")
    request_id = args.get("request_id")

    if not DEVELOPER_API_ENABLED:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "developer_api_unavailable",
                        "error_code": "DEVELOPER_API_DISABLED_IN_PRODUCTION",
                        "message": "Developer API is disabled in production.",
                    }
                ),
            )
        ]

    original_identifier = user_id
    user_id, _user_email, _user_display_name = await resolve_email_to_uid(user_id)

    if user_id is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "user_not_found",
                        "email": original_identifier,
                        "message": f"No Hushh account found for {original_identifier}",
                    }
                ),
            )
        ]

    logger.info("Checking consent status user=%s scope=%s", user_id, scope_str)

    try:
        token_query = get_developer_request_query()
        if not token_query:
            return [
                TextContent(
                    type="text",
                    text=json.dumps(
                        {
                            "status": "error",
                            "error": "Developer token is not configured",
                            "hint": "Set HUSHH_DEVELOPER_TOKEN for stdio or append ?token=<developer-token> to the remote MCP URL.",
                        }
                    ),
                )
            ]

        async with httpx.AsyncClient() as client:
            status_response = await client.get(
                f"{FASTAPI_URL}/api/v1/consent-status",
                params={
                    "user_id": user_id,
                    **({"scope": scope_str} if scope_str else {}),
                    **({"request_id": request_id} if request_id else {}),
                    **token_query,
                },
                timeout=10.0,
            )
            status_response.raise_for_status()
            data = status_response.json()

        return [TextContent(type="text", text=json.dumps(data))]

    except httpx.ConnectError:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error": "Cannot connect to consent backend",
                        "hint": "Make sure FastAPI server is running on " + FASTAPI_URL,
                    }
                ),
            )
        ]
    except Exception as e:
        logger.error("Error checking consent status: %s", e)
        return [
            TextContent(
                type="text",
                text=json.dumps({"status": "error", "error": "Failed to check consent status"}),
            )
        ]
