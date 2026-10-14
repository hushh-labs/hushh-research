"""Pure wire rules for the single-source hosted memory envelope pilot.

This contract never receives a vault key or owner token. A digest of AAD is a
metadata consistency check; it cannot prove that a client encrypted correctly.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from typing import Any
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.curated_connector_manifest import get_manifest

SOURCE_KIND = "curated_oauth_connector"
SCOPE_CODE = "connector_status.v1"
ENVELOPE_VERSION = "aes256gcm.pilot.v1"
MAX_CIPHERTEXT_BYTES = 16_384
MAX_REVISION = 2**63 - 1
SOURCE_ID_PATTERN = re.compile(r"^[a-z0-9_][a-z0-9_.:-]{0,127}$")
_BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def admitted_source_id(source_id: str) -> bool:
    """Admit only checked-in curated providers, never an arbitrary ID."""
    return bool(SOURCE_ID_PATTERN.fullmatch(source_id) and get_manifest(source_id) is not None)


def active_catalog_source(connection: Any, source_id: str) -> bool:
    """Pin the checked-in source to the active operator-owned OAuth catalog."""
    if not admitted_source_id(source_id):
        return False
    return (
        connection.execute(
            text("""SELECT 1 FROM public.external_mcp_connectors
                    WHERE connector_id=:source_id AND user_id IS NULL
                      AND auth_style='oauth' AND transport_kind='mcp'
                      AND capability_policy->>'chat'='reviewed'
                      AND is_active IS TRUE FOR SHARE"""),
            {"source_id": source_id},
        ).first()
        is not None
    )


def _canonical_grant_id(grant_id: str) -> str:
    parsed = UUID(grant_id)
    if str(parsed) != grant_id:
        raise ValueError("grant ID must be canonical UUID")
    return grant_id


def owner_source_aad(
    *, user_id: str, grant_id: str, generation: int, source_id: str, revision: int
) -> bytes:
    """Exact AES-GCM AAD bytes shared with the browser client."""
    if not user_id or not SOURCE_ID_PATTERN.fullmatch(source_id):
        raise ValueError("invalid hosted source identity")
    if not 0 < generation <= MAX_REVISION or not 0 < revision <= MAX_REVISION:
        raise ValueError("invalid hosted source revision")
    grant = _canonical_grant_id(grant_id)
    encoded_owner = base64.urlsafe_b64encode(user_id.encode("utf-8")).rstrip(b"=").decode("ascii")
    return (
        f"hushh-hosted-source-v1\n{encoded_owner}\n{grant}\n{generation}\n"
        f"{source_id}\n{SCOPE_CODE}\n{revision}"
    ).encode("utf-8")


def aad_sha256_hex(aad: bytes) -> str:
    return hashlib.sha256(aad).hexdigest()


def decode_base64url(value: str) -> bytes:
    """Reject padded, noncanonical, or malformed URL-safe base64."""
    if not _BASE64URL_PATTERN.fullmatch(value):
        raise ValueError("invalid base64url")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, binascii.Error):
        raise ValueError("invalid base64url") from None
    if encode_base64url(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded


def encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
