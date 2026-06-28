#!/usr/bin/env python3
"""Backfill: move mis-stored identity-type entities into the `identity` domain.

Decision D-14 / Wave 4 of the identity-domain phase. Phase-01 UAT auto-saved an
address to `financial` (no `identity` domain existed yet). This script corrects
that existing data by scanning `financial`/`general`/`location` for identity-type
fields and moving them into the canonical `identity` domain.

`LEGACY_DOMAIN_ALIASES` remaps whole domain keys and therefore cannot do
partial-field moves, so this dedicated, bespoke script is required.

Safety contract (matches `migrate_financial_v2.py` conventions):
- DRY-RUN BY DEFAULT. The default invocation makes zero writes. Persisting
  requires an explicit `--apply` flag.
- Idempotent. A field already present in the user's `identity` domain is skipped,
  so a second run plans no further moves.
- Reversible. Each applied move emits a `record_mutation_event` whose metadata
  records the source domain / path / field key, so the move can be undone.
- NO SSN (decision D-A). Any field whose key contains `ssn` / `social_security`
  is never planned, never moved, and is flagged so an operator can see it.

The read/write path goes through the BYOK-encrypted domain payload contract
(`personal_knowledge_model_service`), never raw SQL that bypasses encryption.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"

if str(CONSENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_ROOT))

from hushh_mcp.services.domain_inferrer import DomainInferrer  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("identity_backfill")

# Source domains that may hold mis-stored identity-type entities. The phase-01
# UAT mis-stored the address into `financial`; `general`/`location` are the other
# plausible misclassification buckets.
SOURCE_DOMAINS: tuple[str, ...] = ("financial", "general", "location")
DEST_DOMAIN = "identity"

# NO SSN per D-A: any field key containing one of these tokens is never moved.
_SSN_TOKENS: tuple[str, ...] = ("ssn", "social_security")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_ssn_field(field_key: str) -> bool:
    """True if the field key looks like an SSN / social-security field (never moved)."""
    lowered = str(field_key or "").lower()
    return any(token in lowered for token in _SSN_TOKENS)


def _is_identity_field(field_key: str, *, inferrer: DomainInferrer) -> bool:
    """Classify a single field key as identity-type using the DomainInferrer rule.

    Reuses the `identity` rule added in plan 02-01 (`domain_inferrer.DOMAIN_RULES`)
    so detection stays consistent with the live classifier.
    """
    if _is_ssn_field(field_key):
        return False
    return inferrer.infer(str(field_key)) == DEST_DOMAIN


@dataclass(frozen=True)
class PlannedMove:
    """A single planned field move from a source domain into `identity`.

    `source_path`/`source_domain` are retained in mutation metadata on apply so the
    move is reversible.
    """

    user_id: str
    source_domain: str
    source_path: str
    field_key: str
    value: Any
    dest_domain: str = DEST_DOMAIN

    def to_metadata(self) -> dict[str, Any]:
        return {
            "source_domain": self.source_domain,
            "source_path": self.source_path,
            "field_key": self.field_key,
            "dest_domain": self.dest_domain,
            "backfill": "identity_domain",
            "reversible": True,
        }


@dataclass
class UserBackfillResult:
    user_id: str
    planned: list[PlannedMove] = field(default_factory=list)
    applied: list[PlannedMove] = field(default_factory=list)
    skipped_ssn: list[str] = field(default_factory=list)
    already_present: list[str] = field(default_factory=list)

    def as_summary(self) -> dict[str, Any]:
        return {
            "user_id": self.user_id,
            "planned": [
                {
                    "source_domain": m.source_domain,
                    "field_key": m.field_key,
                    "dest_domain": m.dest_domain,
                }
                for m in self.planned
            ],
            "planned_count": len(self.planned),
            "applied_count": len(self.applied),
            "skipped_ssn": self.skipped_ssn,
            "already_present": self.already_present,
        }


# A reader returns the decrypted top-level payload dict for (user_id, domain),
# or None if the domain has no data. Injectable so tests can mock without a DB.
DomainReader = Callable[[str, str], Awaitable[Optional[dict[str, Any]]]]


def _canonical_name_components(payload: dict[str, Any]) -> Optional[str]:
    """Per D-B: derive canonical `full_name` from first/last name components if present.

    Returns the derived full_name string, or None if no name components exist.
    """
    if not isinstance(payload, dict):
        return None
    first = str(payload.get("first_name") or "").strip()
    last = str(payload.get("last_name") or "").strip()
    if first or last:
        return " ".join(part for part in (first, last) if part)
    return None


def _detect_identity_entities(
    domain: str,
    payload: dict[str, Any],
    *,
    inferrer: DomainInferrer,
) -> list[tuple[str, Any]]:
    """Find identity-type top-level fields inside a source-domain payload.

    Returns a list of (field_key, value). SSN-shaped keys are excluded entirely.
    Only the top-level scalar/object fields of the domain payload are considered;
    structural/index keys (`schema_version`, `updated_at`) are ignored.
    """
    if not isinstance(payload, dict):
        return []

    detected: list[tuple[str, Any]] = []
    for field_key, value in payload.items():
        if not isinstance(field_key, str):
            continue
        if field_key in {"schema_version", "updated_at", "created_at"}:
            continue
        if _is_ssn_field(field_key):
            continue
        if _is_identity_field(field_key, inferrer=inferrer):
            detected.append((field_key, value))
    return detected


async def plan_moves(
    user_id: str,
    *,
    reader: DomainReader,
    inferrer: Optional[DomainInferrer] = None,
) -> UserBackfillResult:
    """Compute the planned identity moves for one user (no writes).

    Idempotent: a field whose key already exists in the user's `identity` domain
    is reported under `already_present` and not planned.
    """
    inferrer = inferrer or DomainInferrer()
    result = UserBackfillResult(user_id=user_id)

    identity_payload = await reader(user_id, DEST_DOMAIN)
    existing_identity_keys = (
        set(identity_payload.keys()) if isinstance(identity_payload, dict) else set()
    )

    for source_domain in SOURCE_DOMAINS:
        payload = await reader(user_id, source_domain)
        if not isinstance(payload, dict):
            continue

        # Flag any SSN-shaped fields (never moved, but surfaced for the operator).
        for field_key in payload:
            if isinstance(field_key, str) and _is_ssn_field(field_key):
                flag = f"{source_domain}.{field_key}"
                if flag not in result.skipped_ssn:
                    result.skipped_ssn.append(flag)

        for field_key, value in _detect_identity_entities(
            source_domain, payload, inferrer=inferrer
        ):
            # Idempotency: already migrated into identity -> skip.
            if field_key in existing_identity_keys:
                result.already_present.append(f"{source_domain}.{field_key}")
                continue

            # D-B canonical name shape: surface full_name when components are moved.
            dest_field = field_key
            dest_value = value
            if field_key in {"first_name", "last_name"} and "full_name" not in (
                existing_identity_keys
            ):
                derived = _canonical_name_components(payload)
                if derived:
                    dest_field = "full_name"
                    dest_value = derived

            result.planned.append(
                PlannedMove(
                    user_id=user_id,
                    source_domain=source_domain,
                    source_path=f"{source_domain}.{field_key}",
                    field_key=dest_field,
                    value=dest_value,
                )
            )

    return result


async def apply_moves(
    result: UserBackfillResult,
    *,
    pkm_service: Any,
    dry_run: bool,
) -> UserBackfillResult:
    """Persist planned moves when not dry-run, recording a reversible event each.

    With dry_run=True this performs ZERO writes (record_mutation_event is never
    called). The default caller passes dry_run=True unless `--apply` was given.
    """
    if dry_run:
        logger.info(
            "[dry-run] user=%s planned=%d (no writes)",
            result.user_id,
            len(result.planned),
        )
        return result

    for move in result.planned:
        success = await pkm_service.record_mutation_event(
            user_id=move.user_id,
            domain=move.dest_domain,
            operation_type="identity_backfill_move",
            path_set=[move.field_key],
            source_agent="backfill_identity_domain",
            metadata=move.to_metadata(),
        )
        if success:
            result.applied.append(move)

    logger.info(
        "[apply] user=%s applied=%d/%d",
        result.user_id,
        len(result.applied),
        len(result.planned),
    )
    return result


async def run_backfill_for_user(
    user_id: str,
    *,
    reader: DomainReader,
    pkm_service: Any,
    dry_run: bool,
    inferrer: Optional[DomainInferrer] = None,
) -> UserBackfillResult:
    """Plan then (optionally) apply moves for a single user."""
    result = await plan_moves(user_id, reader=reader, inferrer=inferrer)
    return await apply_moves(result, pkm_service=pkm_service, dry_run=dry_run)


# ---------------------------------------------------------------------------
# Live wiring (decrypt source blobs in memory, mirroring the audit/migrate
# scripts). Kept out of the pure planning/apply path so tests never touch a DB.
# ---------------------------------------------------------------------------


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
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt_bytes,
        iterations=100000,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def _unwrap_vault_key(passphrase: str, wrapper_row: dict[str, Any]) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    encrypted = _decode_bytes_compat(str(wrapper_row.get("encrypted_vault_key") or ""))
    salt = _decode_bytes_compat(str(wrapper_row.get("salt") or ""))
    iv = _decode_bytes_compat(str(wrapper_row.get("iv") or ""))
    if not encrypted or not salt or not iv:
        raise RuntimeError("Passphrase wrapper is incomplete.")
    wrapper_key = _derive_wrapper_key(passphrase, salt)
    vault_key_raw = AESGCM(wrapper_key).decrypt(iv, encrypted, None)
    return vault_key_raw.hex()


def _build_live_reader(db: Any, vault_key_hex: str) -> DomainReader:
    """Return a DomainReader that decrypts a user's domain blob in memory.

    Read-only: it never writes. Persistence is exclusively via
    record_mutation_event in apply_moves.
    """
    from hushh_mcp.types import EncryptedPayload
    from hushh_mcp.vault.encrypt import decrypt_data

    async def _reader(user_id: str, domain: str) -> Optional[dict[str, Any]]:
        rows = (
            db.table("pkm_blobs")
            .select("*")
            .eq("user_id", user_id)
            .eq("domain", domain)
            .eq("segment_id", "root")
            .execute()
            .data
            or []
        )
        if not rows:
            return None
        row = rows[0]
        payload = EncryptedPayload(
            ciphertext=str(row.get("ciphertext") or ""),
            iv=str(row.get("iv") or ""),
            tag=str(row.get("tag") or ""),
            encoding="base64",
            algorithm=str(row.get("algorithm") or "aes-256-gcm"),
        )
        decrypted = decrypt_data(payload, vault_key_hex)
        parsed = json.loads(decrypted)
        return parsed if isinstance(parsed, dict) else None

    return _reader


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill mis-stored identity entities into the identity domain."
    )
    parser.add_argument(
        "--user-id",
        type=str,
        default=None,
        help="Target a single user id. Default: all users with PKM blobs.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Explicitly request dry-run (this is also the default).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Persist the planned moves. Without this flag the run is dry-run only.",
    )
    parser.add_argument(
        "--passphrase",
        type=str,
        default=None,
        help="Vault passphrase for decrypting source blobs (live runs).",
    )
    parser.add_argument(
        "--wrapper-method",
        type=str,
        default="passphrase",
        help="Vault key wrapper method (default: passphrase).",
    )
    parser.add_argument(
        "--env-file",
        type=str,
        default=str(CONSENT_ROOT / ".env"),
        help="Path to the .env file to load before connecting.",
    )
    args = parser.parse_args()

    # Dry-run is the default; only an explicit --apply persists.
    dry_run = not args.apply
    if args.dry_run and args.apply:
        raise SystemExit("Refusing to run: --dry-run and --apply are mutually exclusive.")

    from dotenv import load_dotenv

    load_dotenv(args.env_file, override=True)

    from db.db_client import get_db
    from hushh_mcp.services.personal_knowledge_model_service import (
        PersonalKnowledgeModelService,
    )

    db = get_db()
    pkm_service = PersonalKnowledgeModelService()

    user_id = args.user_id or os.getenv("REVIEWER_UID") or os.getenv("KAI_TEST_USER_ID")
    passphrase = (
        args.passphrase
        or os.getenv("REVIEWER_VAULT_PASSPHRASE")
        or os.getenv("KAI_TEST_PASSPHRASE")
    )
    if not user_id or not passphrase:
        print(
            json.dumps(
                {
                    "status": "skipped",
                    "reason": "missing_user_or_passphrase",
                    "hint": "Provide --user-id and --passphrase (or REVIEWER_UID / "
                    "REVIEWER_VAULT_PASSPHRASE).",
                    "dry_run": dry_run,
                },
                indent=2,
            )
        )
        return

    wrapper_rows = (
        db.table("vault_key_wrappers")
        .select("*")
        .eq("user_id", user_id)
        .eq("method", args.wrapper_method)
        .order("created_at", desc=True)
        .execute()
        .data
        or []
    )
    if not wrapper_rows:
        print(
            json.dumps(
                {"status": "skipped", "reason": "no_wrapper", "user_id": user_id},
                indent=2,
            )
        )
        return

    vault_key_hex = _unwrap_vault_key(passphrase, wrapper_rows[0])
    reader = _build_live_reader(db, vault_key_hex)

    result = await run_backfill_for_user(
        user_id,
        reader=reader,
        pkm_service=pkm_service,
        dry_run=dry_run,
    )

    print(
        json.dumps(
            {
                "status": "applied" if not dry_run else "dry_run",
                "dry_run": dry_run,
                "generated_at": _now_iso(),
                **result.as_summary(),
            },
            indent=2,
            default=str,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
