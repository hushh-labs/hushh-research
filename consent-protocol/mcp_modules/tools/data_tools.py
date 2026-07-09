# mcp/tools/data_tools.py
"""
Data access handlers (generic scoped export plus compatibility named getters).

SECURITY: Uses validate_token_with_db for cross-instance revocation consistency.
This ensures tokens revoked on one Cloud Run instance are rejected on all instances.
"""

import json
import logging

import httpx
from mcp.types import TextContent

from hushh_mcp.consent.token import validate_token_with_db
from mcp_modules.config import FASTAPI_URL
from mcp_modules.developer_context import get_developer_request_query

logger = logging.getLogger("hushh-mcp-server")


async def resolve_user_identifier_to_uid(
    user_id: str,
    *,
    country_iso2: str | None = None,
    country: str | None = None,
) -> str:
    """If user_id is an email or phone number, resolve it to Firebase UID."""
    from mcp_modules.tools.consent_tools import resolve_user_identifier_to_uid as _resolve

    resolved_uid, _email, _display_name = await _resolve(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )
    if resolved_uid is None:
        return user_id
    return resolved_uid


async def resolve_email_to_uid(
    user_id: str,
    *,
    country_iso2: str | None = None,
    country: str | None = None,
) -> str:
    return await resolve_user_identifier_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )


async def _fetch_encrypted_export_package(
    *,
    user_id: str,
    consent_token: str,
    expected_scope: str | None,
):
    token_query = get_developer_request_query()
    if not token_query:
        return {
            "status": "error",
            "error": "Developer token is not configured",
            "hint": "Set HUSHH_DEVELOPER_TOKEN for stdio or append ?token=<developer-token> to the remote MCP URL.",
        }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{FASTAPI_URL}/api/v1/scoped-export",
                params=token_query,
                json={
                    "user_id": user_id,
                    "consent_token": consent_token,
                    **({"expected_scope": expected_scope} if expected_scope else {}),
                },
                timeout=10.0,
            )
            if response.status_code >= 400:
                payload = response.json()
                detail = payload.get("detail")
                if isinstance(detail, dict):
                    return {
                        "status": "error",
                        "error": detail.get("message") or "Failed to fetch encrypted scoped export",
                        "error_code": detail.get("error_code"),
                    }
                return {
                    "status": "error",
                    "error": payload.get("detail") or "Failed to fetch encrypted scoped export",
                }
            return response.json()
    except Exception as exc:
        logger.warning("Encrypted scoped export fetch failed: %s", exc)
        return {
            "status": "error",
            "error": "Failed to fetch encrypted scoped export",
        }


async def handle_get_encrypted_scoped_export(args: dict) -> list[TextContent]:
    """
    Get the encrypted wrapped-key export package for any approved consent token.

    Hussh never decrypts the payload inside the hosted MCP runtime.
    """
    user_id = args.get("user_id")
    country_iso2 = str(args.get("country_iso2") or "").strip() or None
    country = str(args.get("country") or "").strip() or None
    consent_token = args.get("consent_token")
    expected_scope = args.get("expected_scope")

    user_id = await resolve_email_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )

    valid, reason, token_obj = await validate_token_with_db(
        consent_token,
        expected_scope=expected_scope,
    )

    if not valid:
        logger.warning("🚫 ACCESS DENIED (scoped): %s", reason)
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "access_denied",
                        "error": f"Consent validation failed: {reason}",
                        **({"required_scope": expected_scope} if expected_scope else {}),
                        "privacy_notice": "Hussh requires explicit scoped consent before accessing personal data.",
                        "remedy": "Call discover_user_domains first, then request_consent with one of the discovered scopes.",
                    }
                ),
            )
        ]

    if token_obj.user_id != user_id:
        logger.warning(
            "🚫 ACCESS DENIED: User mismatch (token=%s, request=%s)",
            token_obj.user_id,
            user_id,
        )
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "access_denied",
                        "error": "Token user_id does not match requested user_id",
                        "privacy_notice": "Tokens are bound to specific users and cannot be transferred.",
                    }
                ),
            )
        ]

    granted_scope = token_obj.scope_str or token_obj.scope.value
    export_payload = await _fetch_encrypted_export_package(
        user_id=user_id,
        consent_token=consent_token,
        expected_scope=str(expected_scope) if expected_scope else None,
    )
    status_value = str(export_payload.get("status") or "").strip().lower()
    if status_value != "success":
        return [TextContent(type="text", text=json.dumps(export_payload))]

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "status": "success",
                    "user_id": user_id,
                    "scope": granted_scope,
                    **({"expected_scope": expected_scope} if expected_scope else {}),
                    "consent_verified": True,
                    "granted_scope": export_payload.get("granted_scope", granted_scope),
                    "coverage_kind": export_payload.get("coverage_kind"),
                    "expires_at": export_payload.get("expires_at"),
                    "export_revision": export_payload.get("export_revision"),
                    "export_generated_at": export_payload.get("export_generated_at"),
                    "export_refresh_status": export_payload.get("export_refresh_status"),
                    "encrypted_data": export_payload.get("encrypted_data"),
                    "iv": export_payload.get("iv"),
                    "tag": export_payload.get("tag"),
                    "wrapped_key_bundle": export_payload.get("wrapped_key_bundle"),
                    "message": export_payload.get("message"),
                    "privacy_note": (
                        "This payload is encrypted. Hussh returns ciphertext plus wrapped key metadata only; "
                        "the external connector decrypts and narrows it client-side."
                    ),
                    "zero_knowledge": True,
                }
            ),
        )
    ]
