# mcp/tools/consent_tools.py
"""
Consent request and status check handlers.

Only world-model scopes are supported: world_model.read, world_model.write,
attr.{domain}.*, and optional nested attr.{domain}.{subintent}.* scopes.

Regulated cutover note:
- request_consent no longer performs blocking SSE/poll waits for consent resolution.
- caller receives `pending` and must wait for user approval in-app (FCM-driven flow).
"""

import base64
import json
import logging
from pathlib import Path
from typing import Optional

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import x25519
from mcp.types import TextContent

from mcp_modules.config import (
    DEVELOPER_API_ENABLED,
    FASTAPI_URL,
    PRODUCTION_MODE,
    resolve_scope_api,
)
from mcp_modules.developer_context import get_developer_request_query

logger = logging.getLogger("hushh-mcp-server")
_CONNECTOR_KEY_DIR = Path.home() / ".hushh" / "mcp"
_CONNECTOR_KEY_FILE = _CONNECTOR_KEY_DIR / "connector_x25519_key.json"


def _load_or_create_connector_keypair() -> tuple[str, str]:
    _CONNECTOR_KEY_DIR.mkdir(parents=True, exist_ok=True)
    if _CONNECTOR_KEY_FILE.exists():
        try:
            payload = json.loads(_CONNECTOR_KEY_FILE.read_text(encoding="utf-8"))
            private_key_b64 = str(payload.get("private_key") or "").strip()
            public_key_b64 = str(payload.get("public_key") or "").strip()
            if private_key_b64 and public_key_b64:
                return private_key_b64, public_key_b64
        except Exception as exc:
            logger.warning("connector_key_load_failed: %s", exc)

    private_key = x25519.X25519PrivateKey.generate()
    public_key = private_key.public_key()
    private_key_b64 = base64.b64encode(
        private_key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
    ).decode("utf-8")
    public_key_b64 = base64.b64encode(
        public_key.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
    ).decode("utf-8")
    _CONNECTOR_KEY_FILE.write_text(
        json.dumps(
            {
                "private_key": private_key_b64,
                "public_key": public_key_b64,
            }
        ),
        encoding="utf-8",
    )
    return private_key_b64, public_key_b64


def get_connector_public_key_bundle() -> dict[str, str]:
    _private_key_b64, public_key_b64 = _load_or_create_connector_keypair()
    digest = hashes.Hash(hashes.SHA256())
    digest.update(base64.b64decode(public_key_b64))
    key_id = digest.finalize().hex()[:16]
    return {
        "connector_public_key": public_key_b64,
        "connector_key_id": key_id,
        "connector_wrapping_alg": "X25519-AES256-GCM",
    }


def load_connector_private_key() -> x25519.X25519PrivateKey:
    private_key_b64, _public_key_b64 = _load_or_create_connector_keypair()
    return x25519.X25519PrivateKey.from_private_bytes(base64.b64decode(private_key_b64))


async def resolve_email_to_uid(user_id: str) -> tuple[Optional[str], str | None, str | None]:
    """
    If user_id is an email, resolve to Firebase UID.
    Returns (user_id, email, display_name).
    """
    if not user_id or "@" not in user_id:
        return user_id, None, None

    token_query = get_developer_request_query()
    if not token_query:
        logger.warning("Email-to-UID lookup skipped: developer token not configured")
        return user_id, None, None

    try:
        async with httpx.AsyncClient() as client:
            lookup_response = await client.get(
                f"{FASTAPI_URL}/api/user/lookup",
                params={"email": user_id, **token_query},
                timeout=5.0,
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
                            "world_model.read",
                            "world_model.write",
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
    connector_bundle = get_connector_public_key_bundle()

    try:
        async with httpx.AsyncClient() as client:
            create_response = await client.post(
                f"{FASTAPI_URL}/api/v1/request-consent",
                params=token_query,
                json={
                    "user_id": user_id,
                    "scope": scope_dot,
                    "expiry_hours": 24,
                    **connector_bundle,
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
                                "message": "Consent already granted.",
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
                            "request_id": request_id,
                            "message": "Consent request submitted. User approval is pending in Hushh app.",
                            "approval_surface": data.get("approval_surface", "/consents"),
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
