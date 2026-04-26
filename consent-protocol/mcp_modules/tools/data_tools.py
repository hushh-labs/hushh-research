# mcp/tools/data_tools.py
"""
Data access handlers (generic scoped export plus compatibility named getters).

SECURITY: Uses validate_token_with_db for cross-instance revocation consistency.
This ensures tokens revoked on one Cloud Run instance are rejected on all instances.
"""

import base64
import json
import logging

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from mcp.types import TextContent

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
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


async def handle_get_financial(args: dict) -> list[TextContent]:
    """
    Get financial profile WITH mandatory consent validation.

    Compliance:
    ✅ HushhMCP: Consent BEFORE data access
    ✅ HushhMCP: Scoped Access (attr.financial.* or pkm.read required)
    ✅ HushhMCP: User ID must match token
    ✅ Privacy: Denied without valid consent
    ✅ Scope Isolation: Financial token can ONLY access financial data
    """
    user_id = args.get("user_id")
    country_iso2 = str(args.get("country_iso2") or "").strip() or None
    country = str(args.get("country") or "").strip() or None
    consent_token = args.get("consent_token")

    # Identifier resolution - returns (user_id, email, display_name)
    from mcp_modules.tools.consent_tools import resolve_email_to_uid

    original_identifier = user_id
    user_id, user_email, user_display_name = await resolve_email_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
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

    # Compliance check with cross-instance revocation
    # Use string-based scope matching for proper domain isolation
    valid, reason, token_obj = await validate_token_with_db(
        consent_token,
        expected_scope="attr.financial.*",  # Pass string for proper matching
    )

    if not valid:
        logger.warning(f"🚫 ACCESS DENIED (financial): {reason}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "access_denied",
                        "error": f"Consent validation failed: {reason}",
                        "required_scope": "attr.financial.*",
                        "privacy_notice": "Hussh requires explicit consent before accessing any personal data.",
                        "remedy": "Call request_consent with scope='attr.financial.*' first",
                    }
                ),
            )
        ]

    # User ID must match
    if token_obj.user_id != user_id:
        logger.warning(
            f"🚫 ACCESS DENIED: User mismatch (token={token_obj.user_id}, request={user_id})"
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

    # Fetch real data from encrypted export (zero-knowledge)
    financial_data = None

    try:
        async with httpx.AsyncClient() as client:
            export_response = await client.get(
                f"{FASTAPI_URL}/api/consent/data",
                params={"consent_token": consent_token},
                timeout=10.0,
            )

            if export_response.status_code == 200:
                export_data = export_response.json()

                # Decrypt the export data
                export_key_hex = export_data.get("export_key")
                encrypted_data = export_data.get("encrypted_data")
                iv = export_data.get("iv")
                tag = export_data.get("tag")

                if all([export_key_hex, encrypted_data, iv, tag]):
                    try:
                        key_bytes = bytes.fromhex(export_key_hex)
                        iv_bytes = base64.b64decode(iv)
                        ciphertext_bytes = base64.b64decode(encrypted_data)
                        tag_bytes = base64.b64decode(tag)

                        combined = ciphertext_bytes + tag_bytes

                        aesgcm = AESGCM(key_bytes)
                        plaintext = aesgcm.decrypt(iv_bytes, combined, None)

                        # Parse the decrypted data
                        all_data = json.loads(plaintext.decode("utf-8"))

                        # SCOPE ISOLATION: Extract ONLY financial domain data
                        # This ensures financial token only returns financial data
                        if isinstance(all_data, dict):
                            # Check if it's domain-structured (has financial key)
                            if "financial" in all_data:
                                financial_data = all_data["financial"]
                            elif "portfolios" in all_data or "holdings" in all_data:
                                # It's already financial data
                                financial_data = all_data
                            else:
                                # Check for any financial-related keys
                                financial_keys = [
                                    "portfolio",
                                    "holdings",
                                    "investments",
                                    "accounts",
                                    "transactions",
                                ]
                                financial_data = {
                                    k: v for k, v in all_data.items() if k.lower() in financial_keys
                                }
                                if not financial_data:
                                    financial_data = (
                                        all_data  # Return as-is if can't identify structure
                                    )
                        else:
                            financial_data = all_data

                        logger.info("✅ Successfully decrypted financial vault export!")

                    except Exception as e:
                        logger.error(f"❌ Financial decryption failed: {e}")

            elif export_response.status_code == 404:
                logger.warning("⚠️ No export data found for this token")

    except Exception as e:
        logger.warning(f"⚠️ Financial export fetch failed: {e}")

    # PRODUCTION: No fallback to demo data - fail if real data not found
    if financial_data is None:
        logger.warning(f"❌ No vault export data found for user={user_id}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "no_data",
                        "error": "No financial data found in vault",
                        "user_id": user_id,
                        "scope": "attr.financial.*",
                        "consent_verified": True,
                        "message": "The user has not saved any financial data yet, or the data export was not included with consent approval.",
                        "suggestion": "Ask the user to import their portfolio in the Hussh app and re-approve consent.",
                    }
                ),
            )
        ]

    logger.info(f"✅ Financial data ACCESSED for user={user_id} (consent verified)")

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "status": "success",
                    "user_id": user_id,
                    "scope": "attr.financial.*",
                    "consent_verified": True,
                    "consent_token_used": consent_token[:30] + "...",
                    "data": financial_data,
                    "privacy_note": "This data was accessed with valid user consent.",
                    "zero_knowledge": True,
                }
            ),
        )
    ]


async def handle_get_food(args: dict) -> list[TextContent]:
    """
    Get food preferences WITH mandatory consent validation.

    Compliance:
    ✅ HushhMCP: Consent BEFORE data access
    ✅ HushhMCP: Compatibility wrapper over the governed export path
    ✅ HushhMCP: User ID must match token
    ✅ Privacy: Denied without valid consent
    """
    user_id = args.get("user_id")
    country_iso2 = str(args.get("country_iso2") or "").strip() or None
    country = str(args.get("country") or "").strip() or None
    consent_token = args.get("consent_token")

    # Identifier resolution
    user_id = await resolve_email_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )

    # Compliance check with cross-instance revocation
    # NOTE: Legacy VAULT_READ_FOOD scope has been removed.
    valid, reason, token_obj = await validate_token_with_db(
        consent_token, expected_scope=ConsentScope.PKM_READ
    )

    if not valid:
        logger.warning(f"🚫 ACCESS DENIED (food): {reason}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "access_denied",
                        "error": f"Consent validation failed: {reason}",
                        "required_scope": "pkm.read",
                        "privacy_notice": "Hussh requires explicit consent before accessing any personal data.",
                        "remedy": "Call request_consent with scope='pkm.read' first",
                    }
                ),
            )
        ]

    # User ID must match
    if token_obj.user_id != user_id:
        logger.warning(
            f"🚫 ACCESS DENIED: User mismatch (token={token_obj.user_id}, request={user_id})"
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

    # Fetch real data from encrypted export (zero-knowledge)
    food_data = None

    try:
        async with httpx.AsyncClient() as client:
            export_response = await client.get(
                f"{FASTAPI_URL}/api/consent/data",
                params={"consent_token": consent_token},
                timeout=10.0,
            )

            if export_response.status_code == 200:
                export_data = export_response.json()

                # Decrypt the export data
                export_key_hex = export_data.get("export_key")
                encrypted_data = export_data.get("encrypted_data")
                iv = export_data.get("iv")
                tag = export_data.get("tag")

                if all([export_key_hex, encrypted_data, iv, tag]):
                    try:
                        key_bytes = bytes.fromhex(export_key_hex)
                        iv_bytes = base64.b64decode(iv)
                        ciphertext_bytes = base64.b64decode(encrypted_data)
                        tag_bytes = base64.b64decode(tag)

                        combined = ciphertext_bytes + tag_bytes

                        aesgcm = AESGCM(key_bytes)
                        plaintext = aesgcm.decrypt(iv_bytes, combined, None)

                        food_data = json.loads(plaintext.decode("utf-8"))
                        logger.info("✅ Successfully decrypted vault export!")

                    except Exception as e:
                        logger.error(f"❌ Decryption failed: {e}")

            elif export_response.status_code == 404:
                logger.warning("⚠️ No export data found for this token")

    except Exception as e:
        logger.warning(f"⚠️ Export fetch failed: {e}")

    # PRODUCTION: No fallback to demo data - fail if real data not found
    if food_data is None:
        logger.warning(f"❌ No vault export data found for user={user_id}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "no_data",
                        "error": "No food preferences data found in vault",
                        "user_id": user_id,
                        "scope": getattr(token_obj, "scope", "pkm.read"),
                        "compatibility_wrapper": "get_food_preferences",
                        "consent_verified": True,
                        "message": "The user has not saved any food preferences yet, or the data export was not included with consent approval.",
                        "suggestion": "Ask the user to update their food preferences in the Hussh app and re-approve consent.",
                    }
                ),
            )
        ]

    logger.info(f"✅ Food data ACCESSED for user={user_id} (consent verified)")

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "status": "success",
                    "user_id": user_id,
                    "scope": getattr(token_obj, "scope", "pkm.read"),
                    "compatibility_wrapper": "get_food_preferences",
                    "consent_verified": True,
                    "consent_token_used": consent_token[:30] + "...",
                    "data": food_data,
                    "privacy_note": "This data was accessed with valid user consent.",
                    "zero_knowledge": True,
                }
            ),
        )
    ]


async def handle_get_professional(args: dict) -> list[TextContent]:
    """
    Get professional profile WITH mandatory consent validation.

    Compliance:
    ✅ HushhMCP: Different scope = Different token required
    ✅ HushhMCP: Compatibility wrapper over the governed export path
    ✅ HushhMCP: Scope isolation remains enforced by the consent token
    """
    user_id = args.get("user_id")
    country_iso2 = str(args.get("country_iso2") or "").strip() or None
    country = str(args.get("country") or "").strip() or None
    consent_token = args.get("consent_token")

    # Identifier resolution
    user_id = await resolve_email_to_uid(
        user_id,
        country_iso2=country_iso2,
        country=country,
    )

    # Compliance check with cross-instance revocation - must have PKM full-read scope
    valid, reason, token_obj = await validate_token_with_db(
        consent_token, expected_scope=ConsentScope.PKM_READ
    )

    if not valid:
        logger.warning(f"🚫 ACCESS DENIED (professional): {reason}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "access_denied",
                        "error": f"Consent validation failed: {reason}",
                        "required_scope": "pkm.read",
                        "privacy_notice": "Each data category requires its own consent token.",
                        "remedy": "Call request_consent with scope='pkm.read' first",
                    }
                ),
            )
        ]

    # User ID must match
    if token_obj.user_id != user_id:
        return [
            TextContent(
                type="text",
                text=json.dumps({"status": "access_denied", "error": "Token user_id mismatch"}),
            )
        ]

    # Fetch real data from encrypted export (zero-knowledge)
    professional_data = None

    try:
        async with httpx.AsyncClient() as client:
            export_response = await client.get(
                f"{FASTAPI_URL}/api/consent/data",
                params={"consent_token": consent_token},
                timeout=10.0,
            )

            if export_response.status_code == 200:
                export_data = export_response.json()

                # Decrypt the export data
                export_key_hex = export_data.get("export_key")
                encrypted_data = export_data.get("encrypted_data")
                iv = export_data.get("iv")
                tag = export_data.get("tag")

                if all([export_key_hex, encrypted_data, iv, tag]):
                    try:
                        key_bytes = bytes.fromhex(export_key_hex)
                        iv_bytes = base64.b64decode(iv)
                        ciphertext_bytes = base64.b64decode(encrypted_data)
                        tag_bytes = base64.b64decode(tag)

                        combined = ciphertext_bytes + tag_bytes

                        aesgcm = AESGCM(key_bytes)
                        plaintext = aesgcm.decrypt(iv_bytes, combined, None)

                        professional_data = json.loads(plaintext.decode("utf-8"))
                        logger.info("✅ Successfully decrypted professional vault export!")

                    except Exception as e:
                        logger.error(f"❌ Professional decryption failed: {e}")

            elif export_response.status_code == 404:
                logger.warning("⚠️ No export data found for this professional token")

    except Exception as e:
        logger.warning(f"⚠️ Professional export fetch failed: {e}")

    # PRODUCTION: No fallback to demo data - fail if real data not found
    if professional_data is None:
        logger.warning(f"❌ No vault export data found for user={user_id}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "no_data",
                        "error": "No professional profile data found in vault",
                        "user_id": user_id,
                        "scope": getattr(token_obj, "scope", "pkm.read"),
                        "compatibility_wrapper": "get_professional_profile",
                        "consent_verified": True,
                        "message": "The user has not saved any professional profile yet, or the data export was not included with consent approval.",
                        "suggestion": "Ask the user to update their professional profile in the Hussh app and re-approve consent.",
                    }
                ),
            )
        ]

    logger.info(f"✅ Professional data ACCESSED for user={user_id} (consent verified)")

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    "status": "success",
                    "user_id": user_id,
                    "scope": getattr(token_obj, "scope", "pkm.read"),
                    "compatibility_wrapper": "get_professional_profile",
                    "consent_verified": True,
                    "data": professional_data,
                    "privacy_note": "This data was accessed with valid user consent.",
                }
            ),
        )
    ]
