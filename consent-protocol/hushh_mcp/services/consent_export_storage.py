"""Canonical encrypted-export normalization and persistence adapter.

The existing ConsentDBService facade supplies server-authorized inputs. Wrapped
key and v2 shape checks remain identical for free and commercial publication.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.consent.export_envelope import normalize_refresh_policy

logger = logging.getLogger(__name__)


async def store_export(service: Any, values: dict, *, connection: Any = None) -> bool:
    from hushh_mcp.services.consent_db import _token_fingerprint

    db = service._get_db() if connection is None else None
    from datetime import datetime, timezone

    expires_at = datetime.fromtimestamp(values["expires_at_ms"] / 1000, tz=timezone.utc).isoformat()
    normalized_bundle = service._normalize_wrapped_key_bundle(values["wrapped_key_bundle"])
    if normalized_bundle is None:
        logger.error(
            "Refusing to store consent export without a wrapped key bundle token_fp=%s",
            _token_fingerprint(values["consent_token"]),
        )
        return False
    normalized_envelope_version = int(values["envelope_version"] or 1)
    if normalized_envelope_version == 2 and (
        not all(
            (
                values["export_id"],
                values["grant_id"],
                values["app_id"],
                values["scope_handle"],
                values["recipient_key_fingerprint"],
                values["envelope_aad"],
                values["envelope_aad_sha256"],
                values["ciphertext_sha256"],
                values["ciphertext_bytes"],
            )
        )
    ):
        logger.error(
            "Refusing incomplete consent export envelope v2 token_fp=%s",
            _token_fingerprint(values["consent_token"]),
        )
        return False
    try:
        export_row = _export_row(
            service, values, normalized_bundle, normalized_envelope_version, expires_at
        )
        if connection is not None:
            from hushh_mcp.services.consent_commerce_ports import store_export

            return await store_export(connection, export_row)
        query = db.table("consent_exports").upsert(export_row, on_conflict="consent_token")
        await asyncio.to_thread(query.execute)
        logger.info(
            "Stored consent export for token_fp=%s", _token_fingerprint(values["consent_token"])
        )
        return True
    except Exception as e:
        if connection is not None:
            raise
        logger.error("Failed to store consent export error_type=%s", type(e).__name__)
        return False


def _export_row(
    service: Any,
    values: dict,
    normalized_bundle: dict,
    normalized_envelope_version: int,
    expires_at: str,
) -> dict:
    export_row = {
        "consent_token": values["consent_token"],
        "user_id": values["user_id"],
        "encrypted_data": values["encrypted_data"],
        "iv": values["iv"],
        "tag": values["tag"],
        "export_key": None,
        "wrapped_key_bundle": normalized_bundle,
        "connector_key_id": normalized_bundle.get("connector_key_id"),
        "connector_wrapping_alg": normalized_bundle.get("wrapping_alg"),
        "export_revision": max(1, int(values["export_revision"] or 1)),
        "export_generated_at": values["export_generated_at"]
        or datetime.now(timezone.utc).isoformat(),
        "source_content_revision": values["source_content_revision"],
        "source_manifest_revision": values["source_manifest_revision"],
        "refresh_status": service._normalize_refresh_status(values["refresh_status"]),
        "refresh_policy": normalize_refresh_policy(values["refresh_policy"]),
        "envelope_version": normalized_envelope_version,
        "grant_id": values["grant_id"],
        "app_id": values["app_id"],
        "scope_handle": values["scope_handle"],
        "recipient_key_fingerprint": values["recipient_key_fingerprint"],
        "payload_algorithm": values["payload_algorithm"],
        "envelope_aad": values["envelope_aad"],
        "envelope_aad_sha256": values["envelope_aad_sha256"],
        "ciphertext_sha256": values["ciphertext_sha256"],
        "ciphertext_bytes": values["ciphertext_bytes"],
        "scope": values["scope"],
        "expires_at": expires_at,
    }
    if values["export_id"]:
        export_row["export_id"] = values["export_id"]
    return export_row
