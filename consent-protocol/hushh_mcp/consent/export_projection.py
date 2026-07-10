"""Shared scoped-export decrypt and scope-narrowing utilities.

Extracted from the proven, live-tested implementation in
``consent-protocol/scripts/uat_kai_regression_smoke.py`` so both the smoke
script and server-side callers (e.g. the local stdio MCP server) can decrypt
and narrow a zero-knowledge scoped export using identical, tested logic.

Decrypt construction (matches the connector-side reference implementation in
``hushh-webapp/lib/services/one-kyc-client-zk-service.ts``):

1. X25519 ECDH: ``connector_private_key.exchange(sender_public_key)``
2. ``SHA256(shared_secret)`` as the AES-256-GCM wrapping key
3. AES-256-GCM decrypt ``wrapped_export_key + wrapped_key_tag`` using
   ``wrapped_key_iv`` and the wrapping key to recover the export key
4. AES-256-GCM decrypt the export ciphertext using the export key and ``iv``
5. ``json.loads`` the resulting plaintext

Hussh's backend never performs this decrypt; it only ever wraps the export
key to a connector's public key. Callers of this module are, by definition,
connectors holding a private key (either an external party's own key, or the
key generated and persisted locally by a Hussh-owned trusted process such as
the local stdio MCP server).
"""

from __future__ import annotations

import base64
import copy
import json
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _b64decode(value: str) -> bytes:
    normalized = str(value or "").strip().replace("-", "+").replace("_", "/")
    while normalized and len(normalized) % 4 != 0:
        normalized += "="
    return base64.b64decode(normalized)


def decrypt_scoped_export_package(
    *,
    wrapped_key_bundle: dict[str, Any],
    iv_b64: str,
    tag_b64: str,
    ciphertext: str | bytes,
    connector_private_key: X25519PrivateKey,
) -> dict[str, Any]:
    """Decrypt a zero-knowledge scoped-export package.

    ``ciphertext`` may be the inline base64 ``encrypted_data`` string, or the
    raw bytes returned by the authenticated ``/api/v1/scoped-export/download``
    endpoint. Both delivery shapes carry the same plaintext.
    """
    sender_public = X25519PublicKey.from_public_bytes(
        _b64decode(str(wrapped_key_bundle["sender_public_key"]))
    )
    shared_secret = connector_private_key.exchange(sender_public)
    digest = hashes.Hash(hashes.SHA256())
    digest.update(shared_secret)
    wrapping_key = digest.finalize()
    export_key = AESGCM(wrapping_key).decrypt(
        _b64decode(str(wrapped_key_bundle["wrapped_key_iv"])),
        _b64decode(str(wrapped_key_bundle["wrapped_export_key"]))
        + _b64decode(str(wrapped_key_bundle["wrapped_key_tag"])),
        None,
    )
    ciphertext_bytes = ciphertext if isinstance(ciphertext, bytes) else _b64decode(str(ciphertext))
    plaintext = AESGCM(export_key).decrypt(
        _b64decode(str(iv_b64)),
        ciphertext_bytes + _b64decode(str(tag_b64)),
        None,
    )
    return json.loads(plaintext)


def _extract_path_value(value: Any, segments: list[str]) -> Any:
    if not segments:
        return copy.deepcopy(value)
    segment = segments[0]
    rest = segments[1:]
    if segment == "_items":
        if not isinstance(value, list):
            return None
        extracted = [_extract_path_value(item, rest) for item in value]
        filtered = [item for item in extracted if item is not None]
        return filtered or None
    if not isinstance(value, dict) or segment not in value:
        return None
    return _extract_path_value(value[segment], rest)


def _rebuild_projected_value(segments: list[str], value: Any) -> Any:
    if not segments:
        return copy.deepcopy(value)
    segment = segments[0]
    rest = segments[1:]
    if segment == "_items":
        if not isinstance(value, list):
            return []
        return [_rebuild_projected_value(rest, item) for item in value]
    return {segment: _rebuild_projected_value(rest, value)}


def project_domain_data_for_scope(
    domain: str, scope: str, domain_data: dict[str, Any]
) -> dict[str, Any]:
    if scope in {"pkm.read", f"attr.{domain}.*"}:
        return {domain: copy.deepcopy(domain_data)}

    prefix = f"attr.{domain}."
    if not scope.startswith(prefix):
        return {domain: {}}

    raw_path = scope[len(prefix) :].removesuffix(".*")
    normalized_segments = [
        "".join(ch.lower() if ch.isalnum() or ch == "_" else "_" for ch in segment).strip("_")
        for segment in raw_path.split(".")
    ]
    normalized_segments = [segment for segment in normalized_segments if segment]
    if not normalized_segments:
        return {domain: copy.deepcopy(domain_data)}

    extracted = _extract_path_value(domain_data, normalized_segments)
    if extracted is None:
        return {domain: {}}
    return {domain: _rebuild_projected_value(normalized_segments, extracted)}


def narrow_decrypted_export(payload: dict[str, Any], expected_scope: str | None) -> dict[str, Any]:
    if not expected_scope:
        return copy.deepcopy(payload)
    export_metadata = payload.get("__export_metadata")
    source_domain = None
    if isinstance(export_metadata, dict):
        source_domain = str(export_metadata.get("source_domain") or "").strip() or None
    if not source_domain and expected_scope.startswith("attr."):
        parts = expected_scope.split(".")
        if len(parts) >= 2:
            source_domain = parts[1]
    if not source_domain:
        return copy.deepcopy(payload)
    domain_data = payload.get(source_domain)
    if not isinstance(domain_data, dict):
        return copy.deepcopy(payload)
    narrowed = project_domain_data_for_scope(source_domain, expected_scope, domain_data)
    if "__export_metadata" in payload:
        narrowed["__export_metadata"] = copy.deepcopy(payload["__export_metadata"])
    return narrowed
