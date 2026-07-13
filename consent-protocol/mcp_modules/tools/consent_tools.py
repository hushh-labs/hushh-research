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

from hushh_mcp.services.local_mcp_keypair_service import get_or_create_local_connector_keypair
from hushh_mcp.services.user_identifier_service import resolve_lookup_identifier
from mcp_modules.config import (
    DEVELOPER_API_ENABLED,
    FASTAPI_URL,
    PRODUCTION_MODE,
    resolve_scope_api,
)
from mcp_modules.developer_context import get_developer_api_headers, get_developer_request_headers
from mcp_modules.transport_context import is_local_stdio_transport

logger = logging.getLogger("hushh-mcp-server")


async def resolve_user_identifier_to_uid(
    user_id: str,
    *,
    country_iso2: str | None = None,
    country: str | None = None,
) -> tuple[Optional[str], str | None, str | None]:
    """
    If user_id is an email or phone number, resolve to Firebase UID.
    Returns (user_id, email, display_name).
    """
    try:
        lookup_kind, lookup_identifier = resolve_lookup_identifier(
            identifier=user_id,
            email=None,
            phone_number=None,
            country_iso2=country_iso2,
            country=country,
        )
    except ValueError:
        return user_id, None, None

    if lookup_kind == "uid":
        return user_id, None, None

    token_headers = get_developer_request_headers()
    if not token_headers:
        logger.warning("User-identifier lookup skipped: developer token not configured")
        return user_id, None, None

    try:
        async with httpx.AsyncClient() as client:
            lookup_response = await client.get(
                f"{FASTAPI_URL}/api/user/lookup",
                params={
                    "identifier": lookup_identifier,
                    **({"country_iso2": country_iso2} if country_iso2 else {}),
                    **({"country": country} if country else {}),
                },
                headers=token_headers,
                timeout=10.0,
            )

            if lookup_response.status_code == 200:
                lookup_data = lookup_response.json()
                if lookup_data.get("exists"):
                    resolved_uid = lookup_data["user_id"]
                    email = lookup_data.get("email")
                    display_name = lookup_data.get("display_name")
                    logger.info("Resolved user identifier to uid for consent request")
                    return resolved_uid, email, display_name
                return None, lookup_identifier, None

            logger.warning("User lookup failed with status=%s", lookup_response.status_code)
    except Exception as e:
        logger.warning("User lookup failed: %s", e)

    return user_id, None, None


async def resolve_email_to_uid(
    user_id: str,
    *,
    country_iso2: str | None = None,
    country: str | None = None,
) -> tuple[Optional[str], str | None, str | None]:
    return await resolve_user_identifier_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )


def _normalize_offer(raw: object) -> tuple[Optional[dict], Optional[str]]:
    """Validate + normalize an optional priced-consent offer (reverse-auction bid).

    Returns (offer_dict_or_None, error_or_None). The offer rides inside
    request_consent: it is a data-access bid the user side clears against a
    reserve price. Settlement is AP2's job at the money boundary — this never
    moves money.
    """
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, "offer must be an object with at least a bid_amount."

    bid_raw = raw.get("bid_amount")
    if bid_raw is None or isinstance(bid_raw, bool):
        return None, "offer.bid_amount is required and must be a positive number."
    try:
        bid_amount = float(bid_raw)
    except (TypeError, ValueError):
        return None, "offer.bid_amount is required and must be a positive number."
    if not (bid_amount > 0):
        return None, "offer.bid_amount must be greater than 0."
    if bid_amount > 1_000_000:
        return None, "offer.bid_amount exceeds the maximum allowed (1,000,000)."

    currency = str(raw.get("currency") or "USD").strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        return None, "offer.currency must be a 3-letter ISO-4217 code."

    offer: dict[str, object] = {
        "bid_amount": round(bid_amount, 2),
        "currency": currency,
    }
    summary = str(raw.get("offer_summary") or "").strip()
    if summary:
        offer["offer_summary"] = summary[:500]
    settlement_ref = str(raw.get("settlement_ref") or "").strip()
    if settlement_ref:
        offer["settlement_ref"] = settlement_ref[:128]
    return offer, None


async def handle_request_consent(args: dict) -> list[TextContent]:
    """
    Request consent from a user.

    In production, this endpoint returns:
    - granted: if already granted
    - pending: user must approve in Hussh app/dashboard

    Optionally carries a priced-consent ``offer`` (the consent reverse-auction
    bid): a Demand Agent pays the user for scoped access; the user side clears
    the bid against a reserve price; AP2 settles on approval.
    """
    user_id = args.get("user_id")
    country_iso2 = args.get("country_iso2")
    country = args.get("country")
    scope_str = args.get("scope")
    scope_bundle_key = args.get("scope_bundle")

    # If a scope bundle is provided, only single-scope bundles are safe in this
    # public MCP path. Multi-scope bundles need one explicit request per scope.
    if scope_bundle_key and not scope_str:
        from hushh_mcp.consent.scope_bundles import expand_bundle

        try:
            expanded = expand_bundle(scope_bundle_key)
            if len(expanded) > 1:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps(
                            {
                                "status": "error",
                                "error": "scope_bundle expands to multiple scopes; request each discovered scope explicitly.",
                                "expanded_scopes": expanded,
                            }
                        ),
                    )
                ]
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
    refresh_policy = str(args.get("refresh_policy") or "snapshot").strip().lower()
    if refresh_policy not in {"snapshot", "continuous_until_expiry"}:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error_code": "INVALID_REFRESH_POLICY",
                        "error": "refresh_policy must be snapshot or continuous_until_expiry.",
                    }
                ),
            )
        ]

    # Optional priced-consent offer (the consent reverse-auction bid). Normalized
    # here and forwarded to the API; the API records it on the consent event and
    # the user side clears it against a reserve price. AP2 settles on approval.
    offer_payload, offer_error = _normalize_offer(args.get("offer"))
    if offer_error:
        return [
            TextContent(
                type="text",
                text=json.dumps({"status": "error", "error": offer_error}),
            )
        ]

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
    user_id, user_email, user_display_name = await resolve_user_identifier_to_uid(
        user_id,
        country_iso2=str(country_iso2 or "").strip() or None,
        country=str(country or "").strip() or None,
    )

    if user_id is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "user_not_found",
                        "identifier": original_identifier,
                        "message": f"No Hussh account found for {original_identifier}",
                        "next_step": "Ask the user to sign in to the Hussh app before requesting consent.",
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

    developer_headers = get_developer_api_headers()
    if not developer_headers:
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

    # On the local stdio transport, the MCP server manages its own persisted
    # X25519 keypair (see local_mcp_keypair_service) so the LLM host never
    # has to generate/remember one. This also fixes the prior failure mode
    # where an LLM generated a fresh key each session but a later decrypt
    # attempt targeted a stale connector_key_id. Explicit args still win if
    # a caller passes its own key even on stdio. The remote/hosted transport
    # never auto-fills: third-party connectors always supply their own key.
    is_information_scope = scope_dot.startswith("attr.")
    if (
        is_information_scope
        and is_local_stdio_transport()
        and not all([connector_public_key, connector_key_id, connector_wrapping_alg])
    ):
        local_keypair = get_or_create_local_connector_keypair()
        connector_public_key = connector_public_key or local_keypair.public_key_b64
        connector_key_id = connector_key_id or local_keypair.key_id
        connector_wrapping_alg = connector_wrapping_alg or local_keypair.wrapping_alg

    if is_information_scope and not all(
        [connector_public_key, connector_key_id, connector_wrapping_alg]
    ):
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
                headers=developer_headers,
                json={
                    "user_id": user_id,
                    "scope": scope_dot,
                    "reason": reason,
                    "expiry_hours": resolved_expiry_hours,
                    "approval_timeout_minutes": resolved_approval_timeout_minutes,
                    "refresh_policy": refresh_policy if is_information_scope else "snapshot",
                    **(
                        {
                            "connector_public_key": connector_public_key,
                            "connector_key_id": connector_key_id,
                            "connector_wrapping_alg": connector_wrapping_alg,
                        }
                        if is_information_scope
                        else {}
                    ),
                    **({"offer": offer_payload} if offer_payload else {}),
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
                                "requester_label": data.get("requester_label"),
                                "requester_image_url": data.get("requester_image_url"),
                                "reason": data.get("reason"),
                                "message": data.get("message", "Consent already granted."),
                                "offer": data.get("offer"),
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
                                "Consent request submitted. User approval is pending in Hussh app.",
                            ),
                            # Device-flow boundary: the OWNER approves on their
                            # own device. Hussh has already notified them (push
                            # + consent inbox). The requesting party never gets
                            # or relays an approval link - it is not their
                            # surface, and link-relay invites phishing patterns.
                            "user_notification": (
                                "The user has been notified in their Hussh app "
                                "(push notification + consent inbox) and will "
                                "approve or decline there. Do not send them a "
                                "link; there is nothing for you to forward."
                            ),
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
                            "offer": data.get("offer"),
                            "next_step": (
                                "Poll check_consent_status with this request_id "
                                "until it reports granted or denied."
                            ),
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
    country_iso2 = args.get("country_iso2")
    country = args.get("country")
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
    user_id, _user_email, _user_display_name = await resolve_user_identifier_to_uid(
        user_id,
        country_iso2=str(country_iso2 or "").strip() or None,
        country=str(country or "").strip() or None,
    )

    if user_id is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "user_not_found",
                        "identifier": original_identifier,
                        "message": f"No Hussh account found for {original_identifier}",
                    }
                ),
            )
        ]

    logger.info("Checking consent status user=%s scope=%s", user_id, scope_str)

    try:
        developer_headers = get_developer_api_headers()
        if not developer_headers:
            return [
                TextContent(
                    type="text",
                    text=json.dumps(
                        {
                            "status": "error",
                            "error": "Developer token is not configured",
                            "hint": "Set HUSHH_DEVELOPER_TOKEN for stdio or configure the hosted connector bearer token.",
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
                },
                headers=developer_headers,
                timeout=10.0,
            )
            status_response.raise_for_status()
            data = status_response.json()

        # Same device-flow boundary as request_consent: the approval deep link
        # belongs to the owner's notified device, never to the requesting party.
        if isinstance(data, dict):
            data.pop("request_url", None)
            data.pop("approval_surface", None)
            if str(data.get("status") or "").strip().lower() == "pending":
                data["user_notification"] = (
                    "The user has been notified in their Hussh app and approves "
                    "or declines there. Keep polling; do not send them a link."
                )

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
