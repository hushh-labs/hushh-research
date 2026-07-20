"""Result projection for the flat MCP schema profile.

Handlers keep producing the canonical v0.3 lifecycle payload. The MCP boundary
uses this module to derive an intentionally shallow projection for constrained
clients without creating another consent path.
"""

from __future__ import annotations

import json
from typing import Any


def _text(value: object) -> str:
    return str(value or "")


def _epoch(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _number(value: object) -> float:
    try:
        return max(0.0, float(value or 0))
    except (TypeError, ValueError):
        return 0.0


def _offer_fields(payload: dict[str, Any]) -> dict[str, Any]:
    offer = payload.get("offer")
    if not isinstance(offer, dict):
        return {
            "offer_amount": 0.0,
            "offer_currency": "",
            "offer_summary": "",
            "settlement_ref": "",
            "offer_status": "",
        }
    return {
        "offer_amount": _number(offer.get("bid_amount")),
        "offer_currency": _text(offer.get("currency"))[:3],
        "offer_summary": _text(offer.get("offer_summary"))[:500],
        "settlement_ref": _text(offer.get("settlement_ref"))[:128],
        "offer_status": _text(offer.get("settlement_status"))[:64],
    }


def project_flat_result(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Convert a successful standard handler payload to its flat equivalent."""

    if name == "search_user_scopes":
        scopes = payload.get("scopes")
        if not isinstance(scopes, list):
            raise ValueError("scope result is missing a scope list")
        return {
            "status": _text(payload.get("status")),
            "scope_values": [
                _text(item.get("scope"))
                for item in scopes
                if isinstance(item, dict) and _text(item.get("scope"))
            ],
            "next_cursor": _text(payload.get("next_cursor")),
            "has_more": bool(payload.get("has_more")),
        }
    if name == "request_consent":
        return {
            "status": _text(payload.get("status")),
            "scope": _text(payload.get("scope")),
            "request_ref": _text(payload.get("request_ref")),
            "grant_ref": _text(payload.get("grant_ref")),
            "expires_at": _epoch(payload.get("expires_at")),
            "poll_after_seconds": _epoch(payload.get("poll_after_seconds")),
            "approval_timeout_at": _epoch(payload.get("approval_timeout_at")),
            "coverage_kind": _text(payload.get("coverage_kind")),
            **_offer_fields(payload),
        }
    if name == "prepare_campaign_context":
        return {
            "status": _text(payload.get("status")),
            "selected_scope": _text(payload.get("selected_scope")),
            "selected_scope_label": _text(payload.get("selected_scope_label"))[:120],
            "request_ref": _text(payload.get("request_ref")),
            "grant_ref": _text(payload.get("grant_ref")),
            "approval_required": _text(payload.get("status")) == "pending",
            "poll_after_seconds": _epoch(payload.get("poll_after_seconds")),
            "expires_at": _epoch(payload.get("expires_at")),
            "approval_timeout_at": _epoch(payload.get("approval_timeout_at")),
            "export_metadata_ready": bool(payload.get("export_metadata_ready")),
            "export_revision": _epoch(payload.get("export_revision")),
            **_offer_fields(payload),
        }
    if name == "check_consent_status":
        return {
            "status": _text(payload.get("status")),
            "grant_ref": _text(payload.get("grant_ref")),
            "expires_at": _epoch(payload.get("expires_at")),
            "poll_after_seconds": _epoch(payload.get("poll_after_seconds")),
            "approval_timeout_at": _epoch(payload.get("approval_timeout_at")),
        }
    if name == "get_encrypted_scoped_export":
        if payload.get("delivery") == "decrypted_local":
            return {
                "status": _text(payload.get("status")),
                "delivery": "decrypted_local",
                "expected_scope": _text(payload.get("expected_scope")),
                "granted_scope": _text(payload.get("granted_scope")),
                "expires_at": _epoch(payload.get("expires_at")),
                "export_revision": max(1, _epoch(payload.get("export_revision"))),
                "ciphertext": "",
                "payload_iv": "",
                "payload_tag": "",
                "wrapped_export_key": "",
                "wrapped_key_iv": "",
                "wrapped_key_tag": "",
                "sender_public_key": "",
                "connector_key_id": "",
                # Keep the result inside the one public schema even though a
                # trusted local connector has already consumed the envelope.
                "wrapping_alg": "X25519-AES256-GCM",
                "export_envelope_json": "",
                "information_json": json.dumps(
                    payload.get("information") or {},
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                ),
            }
        crypto = payload.get("crypto")
        if not isinstance(crypto, dict):
            raise ValueError("encrypted export is missing its crypto envelope")
        wrapped = crypto.get("wrapped_key_bundle")
        envelope = crypto.get("export_envelope")
        if not isinstance(wrapped, dict) or not isinstance(envelope, dict):
            raise ValueError("encrypted export has an invalid crypto envelope")
        return {
            "status": _text(payload.get("status")),
            "delivery": "encrypted_inline",
            "expected_scope": _text(payload.get("expected_scope")),
            "granted_scope": _text(payload.get("granted_scope")),
            "expires_at": _epoch(payload.get("expires_at")),
            "export_revision": max(1, _epoch(payload.get("export_revision"))),
            "ciphertext": _text(payload.get("ciphertext")),
            "payload_iv": _text(crypto.get("iv")),
            "payload_tag": _text(crypto.get("tag")),
            "wrapped_export_key": _text(wrapped.get("wrapped_export_key")),
            "wrapped_key_iv": _text(wrapped.get("wrapped_key_iv")),
            "wrapped_key_tag": _text(wrapped.get("wrapped_key_tag")),
            "sender_public_key": _text(wrapped.get("sender_public_key")),
            "connector_key_id": _text(wrapped.get("connector_key_id")),
            "wrapping_alg": _text(wrapped.get("wrapping_alg")),
            "export_envelope_json": json.dumps(
                envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ),
            "information_json": "",
        }
    raise ValueError(f"{name} is not part of the flat profile")
