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

from hushh_mcp.consent.export_envelope import (
    ConsentExportEnvelopeSubmissionV2,
    canonical_aad_bytes,
    canonical_envelope_submission_bytes,
    digest_bytes,
)


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
    export_envelope: dict[str, Any] | None = None,
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
    envelope = (
        ConsentExportEnvelopeSubmissionV2.model_validate(export_envelope)
        if export_envelope
        else None
    )
    key_wrap_aad = canonical_envelope_submission_bytes(envelope) if envelope else None
    export_key = AESGCM(wrapping_key).decrypt(
        _b64decode(str(wrapped_key_bundle["wrapped_key_iv"])),
        _b64decode(str(wrapped_key_bundle["wrapped_export_key"]))
        + _b64decode(str(wrapped_key_bundle["wrapped_key_tag"])),
        key_wrap_aad,
    )
    ciphertext_bytes = ciphertext if isinstance(ciphertext, bytes) else _b64decode(str(ciphertext))
    if envelope is not None:
        if len(ciphertext_bytes) != envelope.ciphertext_bytes:
            raise ValueError("export_ciphertext_size_mismatch")
        if digest_bytes(ciphertext_bytes) != envelope.ciphertext_sha256:
            raise ValueError("export_ciphertext_digest_mismatch")
    plaintext = AESGCM(export_key).decrypt(
        _b64decode(str(iv_b64)),
        ciphertext_bytes + _b64decode(str(tag_b64)),
        canonical_aad_bytes(envelope.aad) if envelope else None,
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


def _merge_projected_values(current: Any, incoming: Any) -> Any:
    if isinstance(current, dict) and isinstance(incoming, dict):
        merged = copy.deepcopy(current)
        for key, value in incoming.items():
            merged[key] = (
                _merge_projected_values(merged[key], value)
                if key in merged
                else copy.deepcopy(value)
            )
        return merged
    if isinstance(current, list) and isinstance(incoming, list):
        merged: list[Any] = []
        for index in range(max(len(current), len(incoming))):
            if index >= len(current):
                merged.append(copy.deepcopy(incoming[index]))
            elif index >= len(incoming):
                merged.append(copy.deepcopy(current[index]))
            else:
                merged.append(_merge_projected_values(current[index], incoming[index]))
        return merged
    return copy.deepcopy(incoming)


def _normalize_projection_path(path: str) -> str:
    segments: list[str] = []
    for raw in str(path or "").split("."):
        if raw.strip().lower() == "_items":
            segments.append("_items")
            continue
        segment = "".join(ch.lower() if ch.isalnum() or ch == "_" else "_" for ch in raw).strip("_")
        if segment:
            segments.append(segment)
    return ".".join(segments)


def project_domain_data_for_scope(
    domain: str,
    scope: str,
    domain_data: dict[str, Any],
    *,
    approved_paths: list[str] | None = None,
) -> dict[str, Any]:
    if scope == "pkm.read":
        return {domain: copy.deepcopy(domain_data)}

    prefix = f"attr.{domain}."
    if not scope.startswith(prefix):
        return {domain: {}}

    raw_path = scope[len(prefix) :].removesuffix(".*")
    normalized_path = _normalize_projection_path(raw_path)
    eligible_paths = [
        path
        for path in (_normalize_projection_path(path) for path in (approved_paths or []))
        if path
        and (
            not normalized_path or path == normalized_path or path.startswith(f"{normalized_path}.")
        )
    ]
    if not eligible_paths:
        return {domain: {}}

    projected: Any = {}
    for eligible_path in eligible_paths:
        segments = eligible_path.split(".")
        extracted = _extract_path_value(domain_data, segments)
        if extracted is None:
            continue
        projected = _merge_projected_values(
            projected,
            _rebuild_projected_value(segments, extracted),
        )
    return {domain: projected}


def narrow_decrypted_export(payload: dict[str, Any], expected_scope: str | None) -> dict[str, Any]:
    if not expected_scope:
        return copy.deepcopy(payload)
    export_metadata = payload.get("__export_metadata")
    source_domain = None
    approved_paths: list[str] = []
    if isinstance(export_metadata, dict):
        source_domain = str(export_metadata.get("source_domain") or "").strip() or None
        raw_approved_paths = export_metadata.get("approved_paths")
        if isinstance(raw_approved_paths, list):
            approved_paths = [str(path).strip() for path in raw_approved_paths if str(path).strip()]
    if not source_domain and expected_scope.startswith("attr."):
        parts = expected_scope.split(".")
        if len(parts) >= 2:
            source_domain = parts[1]
    if not source_domain:
        return copy.deepcopy(payload)
    domain_data = payload.get(source_domain)
    if not isinstance(domain_data, dict):
        return copy.deepcopy(payload)
    narrowed = project_domain_data_for_scope(
        source_domain,
        expected_scope,
        domain_data,
        approved_paths=approved_paths,
    )
    if "__export_metadata" in payload:
        narrowed["__export_metadata"] = copy.deepcopy(payload["__export_metadata"])
    return narrowed
