#!/usr/bin/env python3
"""Read-only active PKM shape audit with redacted output.

This script is intentionally privacy-preserving:
- Reads the env-wired reviewer or an explicit user id.
- Decrypts active `pkm_blobs` locally in memory using the passphrase wrapper.
- Never writes to PKM tables.
- Never prints plaintext values.
- Emits only structural shape, counts, redacted paths, and presentation painpoints.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"

if str(CONSENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_ROOT))

from db.db_client import get_db  # noqa: E402
from hushh_mcp.types import EncryptedPayload  # noqa: E402
from hushh_mcp.vault.encrypt import decrypt_data  # noqa: E402

_NOISY_KEY_TOKENS = {
    "artifact",
    "debug",
    "deterministic",
    "enrichment",
    "hash",
    "internal",
    "metadata",
    "parser",
    "provenance",
    "raw",
    "schema",
    "source",
    "trace",
    "workflow",
}
_STRUCTURAL_ENTITY_KEYS = {"entities", "items", "_items", "records", "statements"}
_MAX_PATHS = 240
_MAX_FINDINGS = 80
_UID_ENV_KEYS = (
    "REVIEWER_UID",
    "UAT_SMOKE_USER_ID",
    "KAI_TEST_USER_ID",
    "HUSHH_SMOKE_USER_ID",
)
_PASSPHRASE_ENV_KEYS = (
    "REVIEWER_VAULT_PASSPHRASE",
    "KAI_TEST_PASSPHRASE",
    "UAT_SMOKE_PASSPHRASE",
    "HUSHH_REVIEWER_PASSPHRASE",
)


def _decode_bytes_compat(value: str) -> bytes:
    raw = str(value or "").strip()
    if not raw:
        return b""
    normalized = raw.replace("-", "+").replace("_", "/")
    while len(normalized) % 4 != 0:
        normalized += "="
    try:
        return base64.b64decode(normalized, validate=False)
    except Exception:
        return bytes.fromhex(raw)


def _derive_wrapper_key(passphrase: str, salt_bytes: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt_bytes,
        iterations=100000,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def _unwrap_vault_key(passphrase: str, wrapper_row: dict[str, Any]) -> str:
    encrypted = _decode_bytes_compat(str(wrapper_row.get("encrypted_vault_key") or ""))
    salt = _decode_bytes_compat(str(wrapper_row.get("salt") or ""))
    iv = _decode_bytes_compat(str(wrapper_row.get("iv") or ""))
    if not encrypted or not salt or not iv:
        raise RuntimeError("Passphrase wrapper is incomplete.")
    wrapper_key = _derive_wrapper_key(passphrase, salt)
    vault_key_raw = AESGCM(wrapper_key).decrypt(iv, encrypted, None)
    return vault_key_raw.hex()


def _query_all(db: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    result = db.execute_raw(sql, params)
    return result.data or []


def _query_one(db: Any, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
    rows = _query_all(db, sql, params)
    return rows[0] if rows else None


def _redact_segment(segment: str, parent: str | None) -> str:
    text = str(segment or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    if parent in _STRUCTURAL_ENTITY_KEYS:
        return "{item}"
    if "@" in text:
        return "{email}"
    if re.fullmatch(r"[a-f0-9]{8,}", lowered):
        return "{id}"
    if re.search(r"\d{4,}", lowered):
        return "{id}"
    if len(text) > 40:
        return "{key}"
    return lowered


def _redacted_path(path: tuple[str, ...]) -> str:
    parts: list[str] = []
    parent: str | None = None
    for segment in path:
        redacted = _redact_segment(segment, parent)
        if redacted:
            parts.append(redacted)
        parent = segment.lower()
    return ".".join(parts) or "root"


def _bucket_string_length(value: str) -> str:
    length = len(value)
    if length <= 32:
        return "short"
    if length <= 160:
        return "medium"
    if length <= 1000:
        return "long"
    return "very_long"


def summarize_payload_shape(payload: Any) -> dict[str, Any]:
    """Return structural PKM shape only; never include scalar values."""

    summary: dict[str, Any] = {
        "max_depth": 0,
        "object_count": 0,
        "array_count": 0,
        "scalar_count": 0,
        "string_count": 0,
        "number_count": 0,
        "boolean_count": 0,
        "null_count": 0,
        "paths": [],
        "large_arrays": [],
        "wide_objects": [],
        "long_strings": [],
        "noisy_paths": [],
        "entity_collections": [],
        "string_length_buckets": {
            "short": 0,
            "medium": 0,
            "long": 0,
            "very_long": 0,
        },
    }
    seen_paths: set[str] = set()

    def add_path(path: tuple[str, ...]) -> str:
        redacted = _redacted_path(path)
        if redacted not in seen_paths and len(summary["paths"]) < _MAX_PATHS:
            seen_paths.add(redacted)
            summary["paths"].append(redacted)
        return redacted

    def add_finding(name: str, value: dict[str, Any]) -> None:
        if len(summary[name]) < _MAX_FINDINGS:
            summary[name].append(value)

    def walk(value: Any, path: tuple[str, ...] = ()) -> None:
        summary["max_depth"] = max(summary["max_depth"], len(path))
        redacted = add_path(path)
        key = path[-1].lower() if path else ""

        if isinstance(value, dict):
            summary["object_count"] += 1
            if key in _STRUCTURAL_ENTITY_KEYS:
                add_finding(
                    "entity_collections",
                    {"path": redacted, "item_count": len(value)},
                )
            if len(value) >= 16:
                add_finding(
                    "wide_objects",
                    {"path": redacted, "key_count": len(value)},
                )
            if any(token in key for token in _NOISY_KEY_TOKENS):
                add_finding("noisy_paths", {"path": redacted, "key": key})
            for child_key, child_value in value.items():
                walk(child_value, (*path, str(child_key)))
            return

        if isinstance(value, list):
            summary["array_count"] += 1
            if len(value) >= 16:
                add_finding(
                    "large_arrays",
                    {"path": redacted, "item_count": len(value)},
                )
            for index, child_value in enumerate(value[:100]):
                walk(
                    child_value, (*path, "_items" if isinstance(child_value, dict) else str(index))
                )
            return

        summary["scalar_count"] += 1
        if value is None:
            summary["null_count"] += 1
        elif isinstance(value, bool):
            summary["boolean_count"] += 1
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            summary["number_count"] += 1
        elif isinstance(value, str):
            summary["string_count"] += 1
            bucket = _bucket_string_length(value)
            summary["string_length_buckets"][bucket] += 1
            if bucket in {"long", "very_long"}:
                add_finding("long_strings", {"path": redacted, "length_bucket": bucket})
        else:
            summary["scalar_count"] += 1

        if any(token in key for token in _NOISY_KEY_TOKENS):
            add_finding("noisy_paths", {"path": redacted, "key": key})

    walk(payload)
    summary["paths"] = sorted(summary["paths"])
    return summary


def _painpoints_for_shape(shape: dict[str, Any]) -> list[str]:
    painpoints: list[str] = []
    if shape.get("max_depth", 0) >= 7:
        painpoints.append("deep_nesting")
    if shape.get("wide_objects"):
        painpoints.append("wide_objects")
    if shape.get("large_arrays"):
        painpoints.append("large_arrays")
    if shape.get("long_strings"):
        painpoints.append("long_text_values")
    noisy_paths = shape.get("noisy_paths") or []
    if noisy_paths:
        painpoints.append("developer_metadata_paths")
    if any("changes" in item.get("path", "") for item in noisy_paths):
        painpoints.append("changes_branch_noise")
    return sorted(set(painpoints))


def _decrypt_blob(row: dict[str, Any], vault_key_hex: str) -> Any:
    payload = EncryptedPayload(
        ciphertext=str(row.get("ciphertext") or ""),
        iv=str(row.get("iv") or ""),
        tag=str(row.get("tag") or ""),
        encoding="base64",
        algorithm=str(row.get("algorithm") or "aes-256-gcm"),
    )
    decrypted = decrypt_data(payload, vault_key_hex)
    return json.loads(decrypted)


def _first_env_value(keys: tuple[str, ...]) -> str:
    for key in keys:
        value = str(os.getenv(key) or "").strip()
        if value:
            return value
    return ""


def _read_gcp_secret(project: str, secret_name: str, version: str = "latest") -> str:
    if not project or not secret_name:
        return ""
    result = subprocess.run(  # noqa: S603 - fixed gcloud invocation; inputs are secret names/project ids.
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            version,
            "--secret",
            secret_name,
            "--project",
            project,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


def _first_gcp_secret_value(
    project: str,
    secret_names: tuple[str, ...],
    *,
    version: str,
) -> tuple[str, str]:
    if not project:
        return "", ""
    for secret_name in secret_names:
        value = _read_gcp_secret(project, secret_name, version)
        if value:
            return value, secret_name
    return "", ""


def _resolve_sensitive_input(
    explicit_value: str | None,
    env_keys: tuple[str, ...],
    *,
    gcp_secret_project: str,
    gcp_secret_version: str,
) -> tuple[str, str]:
    if explicit_value is not None and str(explicit_value).strip():
        return str(explicit_value).strip(), "cli"
    env_value = _first_env_value(env_keys)
    if env_value:
        return env_value, "env"
    secret_value, secret_name = _first_gcp_secret_value(
        gcp_secret_project,
        env_keys,
        version=gcp_secret_version,
    )
    if secret_value:
        return secret_value, f"secret_manager:{secret_name}"
    return "", "missing"


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read-only redacted audit of active PKM payload shape for upgrade readiness."
    )
    parser.add_argument("--env-file", default=str(CONSENT_ROOT / ".env"))
    parser.add_argument("--user-id", default="")
    parser.add_argument("--passphrase", default=None)
    parser.add_argument("--wrapper-method", default="passphrase")
    parser.add_argument("--json-out", default="")
    parser.add_argument(
        "--gcp-secret-project",
        default="",
        help=(
            "Optional Secret Manager project for reviewer smoke credentials. "
            "Used only when --user-id/--passphrase and local env keys are absent."
        ),
    )
    parser.add_argument("--gcp-secret-version", default="latest")
    args = parser.parse_args()

    load_dotenv(args.env_file, override=True)
    user_id, user_id_source = _resolve_sensitive_input(
        args.user_id,
        _UID_ENV_KEYS,
        gcp_secret_project=args.gcp_secret_project,
        gcp_secret_version=args.gcp_secret_version,
    )
    passphrase, passphrase_source = _resolve_sensitive_input(
        args.passphrase,
        _PASSPHRASE_ENV_KEYS,
        gcp_secret_project=args.gcp_secret_project,
        gcp_secret_version=args.gcp_secret_version,
    )
    if not user_id:
        raise RuntimeError(
            "Missing user id. Pass --user-id, set REVIEWER_UID in a maintainer env, "
            "or pass --gcp-secret-project for Secret Manager resolution."
        )
    if not passphrase:
        raise RuntimeError(
            "Missing passphrase. Pass --passphrase, set REVIEWER_VAULT_PASSPHRASE in a "
            "maintainer env, or pass --gcp-secret-project for Secret Manager resolution."
        )

    db = get_db()
    wrapper = _query_one(
        db,
        """
        select user_id, method, encrypted_vault_key, salt, iv, created_at
        from vault_key_wrappers
        where user_id = :user_id and method = :method
        order by created_at desc
        limit 1
        """,
        {"user_id": user_id, "method": args.wrapper_method},
    )
    if not wrapper:
        raise RuntimeError("No passphrase wrapper found for the target user.")

    vault_key_hex = _unwrap_vault_key(passphrase, wrapper)
    blob_rows = _query_all(
        db,
        """
        select user_id, domain, segment_id, ciphertext, iv, tag, algorithm,
               content_revision, manifest_revision, size_bytes, updated_at
        from pkm_blobs
        where user_id = :user_id
        order by domain, segment_id
        """,
        {"user_id": user_id},
    )
    manifest_rows = _query_all(
        db,
        """
        select domain, manifest_version, domain_contract_version,
               readable_summary_version, path_count, externalizable_path_count,
               top_level_scope_paths, externalizable_paths, segment_ids, upgraded_at
        from pkm_manifests
        where user_id = :user_id
        order by domain
        """,
        {"user_id": user_id},
    )
    scope_rows = _query_all(
        db,
        """
        select domain, scope_handle, scope_label, exposure_enabled, segment_ids
        from pkm_scope_registry
        where user_id = :user_id
        order by domain, scope_handle
        """,
        {"user_id": user_id},
    )

    domains: list[dict[str, Any]] = []
    for row in blob_rows:
        parsed = _decrypt_blob(row, vault_key_hex)
        shape = summarize_payload_shape(parsed)
        domains.append(
            {
                "domain": row.get("domain"),
                "segment_id": row.get("segment_id") or "root",
                "content_revision": row.get("content_revision"),
                "manifest_revision": row.get("manifest_revision"),
                "updated_at": str(row.get("updated_at") or ""),
                "size_bytes": row.get("size_bytes"),
                "shape": shape,
                "presentation_painpoints": _painpoints_for_shape(shape),
            }
        )

    report = {
        "user_id": user_id,
        "read_only": True,
        "plaintext_logged": False,
        "source": "active_pkm_blobs",
        "credential_sources": {
            "user_id": user_id_source,
            "passphrase": passphrase_source,
        },
        "domain_count": len({row.get("domain") for row in blob_rows}),
        "segment_count": len(blob_rows),
        "manifest_count": len(manifest_rows),
        "scope_count": len(scope_rows),
        "manifests": manifest_rows,
        "scope_registry_summary": [
            {
                "domain": row.get("domain"),
                "scope_handle": row.get("scope_handle"),
                "scope_label": row.get("scope_label"),
                "exposure_enabled": row.get("exposure_enabled"),
                "segment_ids": row.get("segment_ids") or [],
            }
            for row in scope_rows
        ],
        "domains": domains,
    }
    if args.json_out:
        out_path = Path(args.json_out).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main())
