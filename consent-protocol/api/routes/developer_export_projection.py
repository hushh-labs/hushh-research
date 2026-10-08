"""Public encrypted-export projections after canonical admission and durable audit.

These serializers own no grant or cryptographic authority. They never expose the
internal token, owner identifier, staging row or private key in MCP results.
"""

from __future__ import annotations

from typing import Any


def envelope_fields(export_data: dict[str, Any], *, export_id: str) -> dict[str, Any]:
    return {
        "version": export_data.get("envelope_version"),
        "export_id": export_id,
        "aad": export_data.get("envelope_aad"),
        "aad_sha256": export_data.get("envelope_aad_sha256"),
        "ciphertext_sha256": export_data.get("ciphertext_sha256"),
        "ciphertext_bytes": export_data.get("ciphertext_bytes"),
    }


def mcp_response(
    export_data: dict[str, Any],
    *,
    granted_scope: str,
    expected_scope: str,
    expires_at: int | None,
    export_revision: int,
    export_id: str,
    commercial_required: bool,
) -> dict[str, Any]:
    return {
        "status": "success",
        "granted_scope": granted_scope,
        "expected_scope": expected_scope,
        "expires_at": expires_at,
        "export_revision": export_revision,
        "commercial_required": commercial_required,
        "iv": export_data.get("iv"),
        "tag": export_data.get("tag"),
        "wrapped_key_bundle": export_data.get("wrapped_key_bundle"),
        "export_envelope": envelope_fields(export_data, export_id=export_id),
        # MCP transports encrypted bytes in the tool result. Connector private
        # keys remain connector-local; no ResourceLink follow-up is required.
        "encrypted_data": export_data.get("encrypted_data"),
    }
