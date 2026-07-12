# mcp/tools/data_tools.py
"""
Data access handlers (generic scoped export plus compatibility named getters).

SECURITY: Uses validate_token_with_db for cross-instance revocation consistency.
This ensures tokens revoked on one Cloud Run instance are rejected on all instances.
"""

import json
import logging
import os

import httpx
from cryptography.exceptions import InvalidTag
from mcp.types import ResourceLink, TextContent

from hushh_mcp.consent.export_projection import (
    decrypt_scoped_export_package,
    narrow_decrypted_export,
)
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.services.local_mcp_keypair_service import get_or_create_local_connector_keypair
from mcp_modules.config import FASTAPI_URL
from mcp_modules.developer_context import get_developer_api_headers
from mcp_modules.transport_context import is_local_stdio_transport

logger = logging.getLogger("hushh-mcp-server")

# The local stdio server decrypts+narrows locally before this ever reaches the
# LLM, so the result is plain decrypted JSON, not base64 ciphertext - roughly
# 3x denser per byte of real data than the base64 contract above, and the
# whole point of local decrypt is to let a sandboxed LLM host (no route to
# 127.0.0.1) read reasonably-sized single-domain scopes without ever touching
# a download step. Evidence-driven: attr.financial.profile.* and
# attr.financial.analytics.* decrypt to <2.5K chars; attr.financial.portfolio.*
# and attr.financial.documents.* run well past 16K but are still a small
# fraction of a full attr.financial.* export (~1.35MB raw ciphertext).
# Raising this only affects the decrypted_local success path; the raw
# ciphertext fallback (decrypt failure, remote transport, raw=true) is
DECRYPTED_LOCAL_MAX_JSON_CHARS = int(
    os.environ.get("HUSHH_MCP_LOCAL_DECRYPT_MAX_JSON_CHARS", "") or "120000"
)


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
    developer_headers = get_developer_api_headers()
    if not developer_headers:
        return {
            "status": "error",
            "error": "Developer token is not configured",
            "hint": "Set HUSHH_DEVELOPER_TOKEN for stdio or configure the hosted connector bearer token.",
        }
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{FASTAPI_URL}/api/v1/scoped-export",
                headers=developer_headers,
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
        logger.warning("Encrypted scoped export fetch failed: %s", type(exc).__name__)
        return {
            "status": "error",
            "error": "Failed to fetch encrypted scoped export",
        }


async def _fetch_resource_bytes(resource_uri: str) -> tuple[bytes | None, dict | None]:
    developer_headers = get_developer_api_headers()
    if not developer_headers:
        return None, {
            "status": "error",
            "error_code": "CONNECTOR_CRYPTO_UNSUPPORTED",
            "error": "Developer bearer authentication is not configured.",
        }
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(resource_uri, headers=developer_headers, timeout=30.0)
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except Exception:
                detail = None
            return None, {
                "status": "error",
                "error_code": (detail or {}).get("error_code")
                if isinstance(detail, dict)
                else "RESOURCE_FETCH_FAILED",
                "error": (detail or {}).get("message")
                if isinstance(detail, dict)
                else "Encrypted export resource fetch failed.",
            }
        return response.content, None
    except Exception as exc:
        logger.warning("Encrypted export resource fetch failed: %s", type(exc).__name__)
        return None, {
            "status": "error",
            "error_code": "RESOURCE_FETCH_FAILED",
            "error": "Encrypted export resource fetch failed.",
        }


async def handle_get_encrypted_scoped_export(args: dict) -> list[TextContent | ResourceLink]:
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

    base_fields = {
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
        "message": export_payload.get("message"),
    }

    if is_local_stdio_transport():
        decrypted_response, local_error = await _try_build_local_decrypted_response(
            base_fields,
            export_payload=export_payload,
            expected_scope=str(expected_scope) if expected_scope else None,
        )
        if decrypted_response is not None:
            return [TextContent(type="text", text=json.dumps(decrypted_response))]
        return [TextContent(type="text", text=json.dumps(local_error or {}))]

    resource = export_payload.get("resource_link")
    resource_uri = str((resource or {}).get("uri") or "").strip()
    if not resource_uri:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "status": "error",
                        "error_code": "RESOURCE_LINK_MISSING",
                        "error": "The encrypted export resource link is unavailable.",
                    }
                ),
            )
        ]
    metadata = {
        **base_fields,
        "delivery": "resource_link",
        "resource_link": resource,
        "iv": export_payload.get("iv"),
        "tag": export_payload.get("tag"),
        "wrapped_key_bundle": export_payload.get("wrapped_key_bundle"),
        "export_envelope": export_payload.get("export_envelope"),
        "privacy_note": (
            "Fetch ciphertext with developer bearer authentication and decrypt in the connector "
            "process. Never place ciphertext in model context."
        ),
        "zero_knowledge": True,
    }
    return [
        TextContent(type="text", text=json.dumps(metadata)),
        ResourceLink(
            type="resource_link",
            name=str((resource or {}).get("name") or "Hussh encrypted scoped export"),
            uri=resource_uri,
            description="Bearer-authenticated ciphertext; decrypt outside model context.",
            mimeType="application/octet-stream",
            size=(resource or {}).get("size"),
        ),
    ]


async def _try_build_local_decrypted_response(
    base_fields: dict,
    *,
    export_payload: dict,
    expected_scope: str | None,
) -> tuple[dict | None, dict | None]:
    """Decrypt and narrow a scoped export using the local persisted keypair.

    Returns ``(response, None)`` on success, or ``(None, fallback_note)`` if
    the caller should fall back to the raw ciphertext contract: a decrypt
    failure on an older grant wrapped to a key this install no longer holds,
    or a narrowed result still too large to return safely.
    """
    wrapped_key_bundle = export_payload.get("wrapped_key_bundle")
    export_envelope = export_payload.get("export_envelope")
    resource_uri = str((export_payload.get("resource_link") or {}).get("uri") or "").strip()
    iv = export_payload.get("iv")
    tag = export_payload.get("tag")
    if not (resource_uri and wrapped_key_bundle and export_envelope and iv and tag):
        return None, {
            "status": "error",
            "error_code": "CONNECTOR_CRYPTO_UNSUPPORTED",
            "error": "Envelope v2 resource metadata is incomplete.",
        }

    ciphertext, fetch_error = await _fetch_resource_bytes(resource_uri)
    if ciphertext is None:
        return None, fetch_error

    try:
        local_keypair = get_or_create_local_connector_keypair()
        connector_key_id = str((wrapped_key_bundle or {}).get("connector_key_id") or "")
        if connector_key_id and connector_key_id != local_keypair.key_id:
            return None, {
                "status": "error",
                "error_code": "CONNECTOR_KEY_REBIND_REQUIRED",
                "error": "This grant is bound to a different connector key.",
            }
        decrypted_payload = decrypt_scoped_export_package(
            wrapped_key_bundle=wrapped_key_bundle,
            iv_b64=str(iv),
            tag_b64=str(tag),
            ciphertext=ciphertext,
            connector_private_key=local_keypair.private_key,
            export_envelope=export_envelope,
        )
        narrowed = narrow_decrypted_export(decrypted_payload, expected_scope)
        # __export_metadata carries internal bookkeeping (e.g. every scope path
        # ever approved for this user's whole export manifest) that can dwarf
        # the actual narrowed data and is not meant for the LLM; the tool
        # response already surfaces the relevant scope/granted_scope/export_
        # revision fields at the top level.
        narrowed.pop("__export_metadata", None)
    except (InvalidTag, KeyError, ValueError, TypeError) as exc:
        logger.warning("Local auto-decrypt unavailable for this grant: %s", exc)
        return None, {
            "status": "error",
            "error_code": "INVALID_EXPORT_AAD",
            "error": "Envelope validation or local decryption failed.",
        }

    narrowed_json = json.dumps(narrowed)
    if len(narrowed_json) > DECRYPTED_LOCAL_MAX_JSON_CHARS:
        logger.info(
            "Local auto-decrypt result (%d chars) exceeds the %d-char decrypted-local threshold; "
            "falling back to raw delivery.",
            len(narrowed_json),
            DECRYPTED_LOCAL_MAX_JSON_CHARS,
        )
        return None, {
            "status": "error",
            "error_code": "RESULT_REQUIRES_NARROWER_SCOPE",
            "error": "The decrypted result exceeds the model-result limit.",
            "maximum_model_result_chars": DECRYPTED_LOCAL_MAX_JSON_CHARS,
            "suggestion": "Retry with a discovered child scope under the granted domain.",
        }

    return {
        **base_fields,
        "delivery": "decrypted_local",
        "decrypted": True,
        "data": narrowed,
        "privacy_note": (
            "Decrypted locally by your own Hussh MCP install; Hussh's servers never saw the "
            "plaintext or your private key."
        ),
        "zero_knowledge": True,
    }, None
