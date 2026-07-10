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
from mcp.types import TextContent

from hushh_mcp.consent.export_projection import (
    decrypt_scoped_export_package,
    narrow_decrypted_export,
)
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.services.local_mcp_keypair_service import get_or_create_local_connector_keypair
from mcp_modules.config import CONSENT_API_PUBLIC_ORIGIN, FASTAPI_URL
from mcp_modules.developer_context import get_developer_request_query
from mcp_modules.transport_context import is_local_stdio_transport

logger = logging.getLogger("hushh-mcp-server")

# Exports whose base64 ciphertext fits comfortably in a tool result stay inline
# so small reads remain a single turn. Anything larger is delivered via the
# authenticated download endpoint so the ciphertext never transits LLM context
# (models are slow and lossy at re-emitting large base64 through text tools).
# Threshold is evidence-driven: a 31.7KB-base64 portfolio export stalled a
# Claude Desktop connector that tried to re-emit it through text tools, so the
# inline lane is reserved for genuinely small payloads. This governs the RAW
# ciphertext contract only (remote/hosted transport, and stdio's raw=true
# opt-out) - see DECRYPTED_LOCAL_MAX_JSON_CHARS below for the local-decrypt
# threshold, which is deliberately larger.
INLINE_EXPORT_MAX_BASE64_CHARS = 16_000

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
# unaffected and still governed by INLINE_EXPORT_MAX_BASE64_CHARS.
DECRYPTED_LOCAL_MAX_JSON_CHARS = int(
    os.environ.get("HUSHH_MCP_LOCAL_DECRYPT_MAX_JSON_CHARS", "") or "120000"
)


def _download_instructions(*, user_id: str, consent_token: str) -> dict:
    """Build connector-facing instructions for fetching ciphertext directly.

    The developer token is intentionally NOT embedded here: the connector
    already holds it, and echoing it into model context would leak a
    credential. The curl template references the env var instead.
    """
    url = f"{CONSENT_API_PUBLIC_ORIGIN}/api/v1/scoped-export/download"
    body = json.dumps({"user_id": user_id, "consent_token": consent_token})
    return {
        "url": url,
        "method": "POST",
        "auth": "Authorization: Bearer <your developer token> (same token this MCP connection uses)",
        "json_body": {"user_id": user_id, "consent_token": consent_token},
        "response": (
            "Raw ciphertext bytes (application/octet-stream). IV and tag ride the "
            "X-Export-IV / X-Export-Tag response headers (base64)."
        ),
        "curl_example": (
            f'curl -sf -X POST "{url}" '
            '-H "Authorization: Bearer $HUSHH_DEVELOPER_TOKEN" '
            "-H 'Content-Type: application/json' "
            f"-d '{body}' -o export.bin -D headers.txt"
        ),
        "important": (
            "Fetch the ciphertext inside your script or shell. Never echo the "
            "ciphertext into the model context or retype it through text tools; "
            "decrypt export.bin locally with the wrapped key bundle."
        ),
        "if_unreachable": (
            "If your script environment cannot reach this URL (sandboxed "
            "runtimes, egress allowlists, localhost servers), call "
            "get_encrypted_scoped_export again with delivery='inline' to "
            "receive the full base64 ciphertext in the tool result instead."
        ),
    }


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

    # `raw=true` (or delivery='raw') opts out of local auto-decrypt even on
    # the stdio transport, for connectors that want to decrypt themselves.
    raw_requested = (
        bool(args.get("raw")) or str(args.get("delivery") or "").strip().lower() == "raw"
    )

    fallback_note: str | None = None
    if is_local_stdio_transport() and not raw_requested:
        decrypted_response, fallback_note = _try_build_local_decrypted_response(
            base_fields,
            export_payload=export_payload,
            expected_scope=str(expected_scope) if expected_scope else None,
        )
        if decrypted_response is not None:
            return [TextContent(type="text", text=json.dumps(decrypted_response))]
        # Decrypt failed (e.g. an older grant wrapped to a key this install
        # no longer holds) or the narrowed payload was still too large;
        # fall through to the raw ciphertext contract below.

    raw_delivery = _build_raw_delivery_fields(
        export_payload,
        user_id=user_id,
        consent_token=str(consent_token),
        forced_inline=str(args.get("delivery") or "").strip().lower() == "inline",
    )
    if fallback_note:
        raw_delivery["delivery_note"] = fallback_note

    return [
        TextContent(
            type="text",
            text=json.dumps(
                {
                    **base_fields,
                    **raw_delivery,
                    "iv": export_payload.get("iv"),
                    "tag": export_payload.get("tag"),
                    "wrapped_key_bundle": export_payload.get("wrapped_key_bundle"),
                    "privacy_note": (
                        "This payload is encrypted. Hussh returns ciphertext plus wrapped key metadata only; "
                        "the external connector decrypts and narrows it client-side."
                    ),
                    "zero_knowledge": True,
                }
            ),
        )
    ]


def _build_raw_delivery_fields(
    export_payload: dict,
    *,
    user_id: str,
    consent_token: str,
    forced_inline: bool,
) -> dict:
    """Build the legacy raw-ciphertext delivery contract (inline/download).

    Unchanged behavior: this is the byte-for-byte original contract used by
    the remote/hosted MCP transport and by any local stdio caller that opts
    out of auto-decrypt (`raw=true`), or that hits the local-decrypt fallback
    path (oversized narrowed result, or a decrypt failure on an older grant).
    """
    encrypted_data = str(export_payload.get("encrypted_data") or "")
    inline_ok = forced_inline or len(encrypted_data) <= INLINE_EXPORT_MAX_BASE64_CHARS
    delivery: dict = {
        "delivery": "inline" if inline_ok else "download",
        "encrypted_data": encrypted_data if inline_ok else None,
        "download": _download_instructions(user_id=user_id, consent_token=consent_token),
    }
    if not inline_ok:
        delivery["delivery_note"] = (
            f"Ciphertext is {len(encrypted_data)} base64 chars, above the "
            f"{INLINE_EXPORT_MAX_BASE64_CHARS}-char inline limit. Fetch it with the "
            "download instructions; do not attempt to reconstruct it from context. "
            "If your environment cannot reach the download URL, retry this tool "
            "with delivery='inline'."
        )
    elif forced_inline and len(encrypted_data) > INLINE_EXPORT_MAX_BASE64_CHARS:
        delivery["delivery_note"] = (
            "Inline delivery was forced for a large export. Write encrypted_data "
            "to a file in ONE step (do not retype it); then decrypt locally."
        )
    return delivery


def _try_build_local_decrypted_response(
    base_fields: dict,
    *,
    export_payload: dict,
    expected_scope: str | None,
) -> tuple[dict | None, str | None]:
    """Decrypt and narrow a scoped export using the local persisted keypair.

    Returns ``(response, None)`` on success, or ``(None, fallback_note)`` if
    the caller should fall back to the raw ciphertext contract: a decrypt
    failure on an older grant wrapped to a key this install no longer holds,
    or a narrowed result still too large to return safely.
    """
    encrypted_data = export_payload.get("encrypted_data")
    wrapped_key_bundle = export_payload.get("wrapped_key_bundle")
    iv = export_payload.get("iv")
    tag = export_payload.get("tag")
    if not (encrypted_data and wrapped_key_bundle and iv and tag):
        return None, None

    try:
        local_keypair = get_or_create_local_connector_keypair()
        decrypted_payload = decrypt_scoped_export_package(
            wrapped_key_bundle=wrapped_key_bundle,
            iv_b64=str(iv),
            tag_b64=str(tag),
            ciphertext=str(encrypted_data),
            connector_private_key=local_keypair.private_key,
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
        return None, (
            "Local auto-decrypt unavailable for this grant (older connector key). "
            "Falling back to raw ciphertext; request a fresh consent grant to get "
            "automatic decryption next time."
        )

    narrowed_json = json.dumps(narrowed)
    if len(narrowed_json) > DECRYPTED_LOCAL_MAX_JSON_CHARS:
        logger.info(
            "Local auto-decrypt result (%d chars) exceeds the %d-char decrypted-local threshold; "
            "falling back to raw delivery.",
            len(narrowed_json),
            DECRYPTED_LOCAL_MAX_JSON_CHARS,
        )
        return None, (
            f"Decrypted local result ({len(narrowed_json)} chars) is still too large to return "
            f"directly (limit {DECRYPTED_LOCAL_MAX_JSON_CHARS} chars). Narrow to a smaller "
            "sub-scope (e.g. a specific path under this domain) and try again, or fall back to "
            "raw ciphertext delivery for this export."
        )

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
