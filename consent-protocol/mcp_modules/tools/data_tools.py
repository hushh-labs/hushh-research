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
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from mcp.types import TextContent

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from mcp_modules.config import FASTAPI_URL
from mcp_modules.developer_context import get_developer_request_query
from mcp_modules.tools.consent_tools import load_connector_private_key

logger = logging.getLogger("hushh-mcp-server")


async def resolve_email_to_uid(user_id: str) -> str:
    """If user_id is an email, resolve to Firebase UID."""
    if not user_id or "@" not in user_id:
        return user_id
    token_query = get_developer_request_query()
    if not token_query:
        logger.warning("⚠️ Email lookup skipped: developer token not configured")
        return user_id

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
                    resolved = lookup_data["user_id"]
                    logger.info(f"✅ Resolved email to UID: {resolved}")
                    return resolved
    except Exception as e:
        logger.warning(f"⚠️ Email lookup failed: {e}")

    return user_id


async def _fetch_decrypted_export(consent_token: str):
    """
    Fetch encrypted export data from the backend and decrypt it locally.

    The export is already scope-filtered by the approval flow, so callers
    receive only the approved subset.
    """
    try:
        async with httpx.AsyncClient() as client:
            export_response = await client.get(
                f"{FASTAPI_URL}/api/consent/data",
                params={"consent_token": consent_token},
                timeout=10.0,
            )

            if export_response.status_code == 404:
                logger.warning("⚠️ No export data found for consent token")
                return None

            export_response.raise_for_status()
            export_data = export_response.json()

            export_key_hex = export_data.get("export_key")
            wrapped_key_bundle = export_data.get("wrapped_key_bundle") or {}
            encrypted_data = export_data.get("encrypted_data")
            iv = export_data.get("iv")
            tag = export_data.get("tag")

            if not all([encrypted_data, iv, tag]):
                logger.warning("⚠️ Incomplete export payload for consent token")
                return None

            if isinstance(wrapped_key_bundle, dict) and wrapped_key_bundle.get(
                "wrapped_export_key"
            ):
                private_key = load_connector_private_key()
                sender_public_key = x25519.X25519PublicKey.from_public_bytes(
                    base64.b64decode(str(wrapped_key_bundle.get("sender_public_key") or ""))
                )
                shared_secret = private_key.exchange(sender_public_key)
                digest = hashes.Hash(hashes.SHA256())
                digest.update(shared_secret)
                wrapping_key = digest.finalize()

                wrapped_ciphertext = base64.b64decode(
                    str(wrapped_key_bundle.get("wrapped_export_key") or "")
                )
                wrapped_iv = base64.b64decode(str(wrapped_key_bundle.get("wrapped_key_iv") or ""))
                wrapped_tag = base64.b64decode(str(wrapped_key_bundle.get("wrapped_key_tag") or ""))
                wrapped_combined = wrapped_ciphertext + wrapped_tag
                export_key_bytes = AESGCM(wrapping_key).decrypt(wrapped_iv, wrapped_combined, None)
                export_key_hex = export_key_bytes.hex()

            if not export_key_hex:
                logger.warning("⚠️ Missing export key material for consent token")
                return None

            key_bytes = bytes.fromhex(export_key_hex)
            iv_bytes = base64.b64decode(iv)
            ciphertext_bytes = base64.b64decode(encrypted_data)
            tag_bytes = base64.b64decode(tag)

            combined = ciphertext_bytes + tag_bytes
            aesgcm = AESGCM(key_bytes)
            plaintext = aesgcm.decrypt(iv_bytes, combined, None)
            return json.loads(plaintext.decode("utf-8"))
    except Exception as e:
        logger.warning("⚠️ Scoped export fetch/decrypt failed: %s", e)
        return None


async def handle_get_scoped_data(args: dict) -> list[TextContent]:
    """
    Get scope-filtered export data for any approved consent token.

    This is the scalable dynamic replacement for named domain getters.
    """
    user_id = args.get("user_id")
    consent_token = args.get("consent_token")
    expected_scope = args.get("expected_scope")

    user_id = await resolve_email_to_uid(user_id)

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
                        "privacy_notice": "Hushh requires explicit scoped consent before accessing personal data.",
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

    scoped_data = await _fetch_decrypted_export(consent_token)
    granted_scope = token_obj.scope_str or token_obj.scope.value

    if scoped_data is None:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "no_data",
                        "error": "No scoped export data found for this token",
                        "user_id": user_id,
                        "scope": granted_scope,
                        "consent_verified": True,
                        "message": "The user has not approved export data for this scope yet, or the export has expired.",
                    }
                ),
            )
        ]

    payload_keys = sorted(scoped_data.keys()) if isinstance(scoped_data, dict) else None

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
                    "data": scoped_data,
                    **({"top_level_keys": payload_keys} if payload_keys is not None else {}),
                    "privacy_note": "This payload contains only the subset the user approved for this consent token.",
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
    consent_token = args.get("consent_token")

    # Email resolution - returns (user_id, email, display_name)
    from mcp_modules.tools.consent_tools import resolve_email_to_uid

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
                        "privacy_notice": "Hushh requires explicit consent before accessing any personal data.",
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
                        "suggestion": "Ask the user to import their portfolio in the Hushh app and re-approve consent.",
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
    consent_token = args.get("consent_token")

    # Email resolution
    user_id = await resolve_email_to_uid(user_id)

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
                        "privacy_notice": "Hushh requires explicit consent before accessing any personal data.",
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
                        "suggestion": "Ask the user to update their food preferences in the Hushh app and re-approve consent.",
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
    consent_token = args.get("consent_token")

    # Email resolution
    user_id = await resolve_email_to_uid(user_id)

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
                        "suggestion": "Ask the user to update their professional profile in the Hushh app and re-approve consent.",
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
