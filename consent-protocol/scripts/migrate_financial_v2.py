#!/usr/bin/env python3
"""Migrate financial PKM data to Kai V2 canonical structure.

Modes:
1. Index-only migration (default): updates `pkm_index.domain_summaries.financial`
   with V2 counters/fields where possible without decrypting user blobs.
2. Deep migration (user-scoped): with --user-id and --passphrase, decrypts the user's
   PKM blob, ensures `financial.portfolio` and `financial.analytics` are present,
   then re-encrypts and persists updated blob + index summary.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"

load_dotenv(CONSENT_ROOT / ".env")
if str(CONSENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_ROOT))

from db.db_client import get_db  # noqa: E402
from hushh_mcp.kai_import.normalize_v2 import (  # noqa: E402
    build_financial_analytics_v2,
    build_financial_portfolio_canonical_v2,
)
from hushh_mcp.types import EncryptedPayload  # noqa: E402
from hushh_mcp.vault.encrypt import decrypt_data, encrypt_data  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_num(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace(",", "").strip()
        if cleaned:
            try:
                return float(cleaned)
            except Exception:
                return 0.0
    return 0.0


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


def _first_statement_snapshot(financial: dict[str, Any]) -> dict[str, Any] | None:
    documents = financial.get("documents")
    if not isinstance(documents, dict):
        return None
    statements = documents.get("statements")
    if not isinstance(statements, list) or not statements:
        return None
    sorted_rows = sorted(
        [row for row in statements if isinstance(row, dict)],
        key=lambda row: str(row.get("imported_at") or row.get("updated_at") or ""),
        reverse=True,
    )
    return sorted_rows[0] if sorted_rows else None


def _derive_portfolio_v2_from_financial(
    financial: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    portfolio = financial.get("portfolio")
    if isinstance(portfolio, dict) and isinstance(portfolio.get("holdings"), list):
        raw_extract = {}
        statement = _first_statement_snapshot(financial)
        if isinstance(statement, dict) and isinstance(statement.get("raw_extract_v2"), dict):
            raw_extract = statement.get("raw_extract_v2") or {}
        return portfolio, raw_extract

    statement = _first_statement_snapshot(financial)
    if not isinstance(statement, dict):
        return None, {}

    canonical = statement.get("canonical_v2")
    if isinstance(canonical, dict) and isinstance(canonical.get("holdings"), list):
        raw_extract = statement.get("raw_extract_v2")
        return canonical, raw_extract if isinstance(raw_extract, dict) else {}

    account_info = (
        statement.get("account_info") if isinstance(statement.get("account_info"), dict) else {}
    )
    account_summary = (
        statement.get("account_summary")
        if isinstance(statement.get("account_summary"), dict)
        else {}
    )
    holdings = statement.get("holdings") if isinstance(statement.get("holdings"), list) else []
    asset_allocation = statement.get("asset_allocation")
    quality = (
        statement.get("quality_report") if isinstance(statement.get("quality_report"), dict) else {}
    )
    quality_v2 = {
        "schema_version": 2,
        "raw_count": int(quality.get("raw") or quality.get("raw_count") or len(holdings)),
        "validated_count": int(
            quality.get("validated") or quality.get("validated_count") or len(holdings)
        ),
        "aggregated_count": int(
            quality.get("aggregated") or quality.get("aggregated_count") or len(holdings)
        ),
        "holdings_count": len(holdings),
        "investable_positions_count": sum(
            1 for h in holdings if isinstance(h, dict) and h.get("is_investable")
        ),
        "cash_positions_count": sum(
            1 for h in holdings if isinstance(h, dict) and h.get("is_cash_equivalent")
        ),
        "allocation_coverage_pct": 1.0 if asset_allocation else 0.0,
        "symbol_trust_coverage_pct": 0.0,
        "parser_quality_score": float(quality.get("average_confidence") or 0.0),
        "quality_gate": quality.get("quality_gate")
        if isinstance(quality.get("quality_gate"), dict)
        else {},
        "dropped_reasons": quality.get("dropped_reasons") or {},
        "diagnostics": {},
    }
    total_value = _to_num(statement.get("total_value") or account_summary.get("ending_value"))
    cash_balance = _to_num(statement.get("cash_balance") or account_summary.get("cash_balance"))
    canonical_v2 = build_financial_portfolio_canonical_v2(
        raw_extract_v2={},
        account_info=account_info,
        account_summary=account_summary,
        holdings=holdings,
        asset_allocation=asset_allocation,
        total_value=total_value,
        cash_balance=cash_balance,
        quality_report_v2=quality_v2,
    )
    return canonical_v2, {}


def _build_summary_from_financial(financial: dict[str, Any]) -> dict[str, Any]:
    portfolio = financial.get("portfolio") if isinstance(financial.get("portfolio"), dict) else {}
    holdings = portfolio.get("holdings") if isinstance(portfolio.get("holdings"), list) else []
    quality = (
        portfolio.get("quality_report_v2")
        if isinstance(portfolio.get("quality_report_v2"), dict)
        else {}
    )
    statement_period = (
        portfolio.get("statement_period")
        if isinstance(portfolio.get("statement_period"), dict)
        else {}
    )

    holdings_count = len(holdings)
    investable_positions_count = sum(
        1 for h in holdings if isinstance(h, dict) and h.get("is_investable")
    )
    cash_positions_count = sum(
        1 for h in holdings if isinstance(h, dict) and h.get("is_cash_equivalent")
    )

    parser_quality_score = quality.get("parser_quality_score")
    if not isinstance(parser_quality_score, (int, float)):
        parser_quality_score = 0.0

    allocation_coverage_pct = quality.get("allocation_coverage_pct")
    if not isinstance(allocation_coverage_pct, (int, float)):
        allocation_coverage_pct = 0.0

    last_statement_end = (
        statement_period.get("end") if isinstance(statement_period.get("end"), str) else None
    )
    last_statement_total_value = _to_num(portfolio.get("total_value"))

    return {
        "holdings_count": holdings_count,
        "investable_positions_count": investable_positions_count,
        "cash_positions_count": cash_positions_count,
        "allocation_coverage_pct": round(float(allocation_coverage_pct), 4),
        "parser_quality_score": round(float(parser_quality_score), 4),
        "last_statement_total_value": round(float(last_statement_total_value), 2),
        "last_statement_end": last_statement_end,
        "domain_contract_version": 2,
        "intent_map": [
            "portfolio",
            "analytics",
            "documents",
            "profile",
            "analysis_history",
            "analysis.decisions",
            "runtime",
        ],
        "last_updated": _now_iso(),
    }


def _update_index_summary_v2(index_row: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    domain_summaries = index_row.get("domain_summaries")
    if not isinstance(domain_summaries, dict):
        domain_summaries = {}
    fin = domain_summaries.get("financial")
    fin = fin if isinstance(fin, dict) else {}
    fin.update(summary)
    domain_summaries["financial"] = fin
    index_row["domain_summaries"] = domain_summaries

    available = index_row.get("available_domains")
    if not isinstance(available, list):
        available = []
    if "financial" not in available:
        available.append("financial")
    index_row["available_domains"] = available
    return index_row


async def _deep_migrate_user(
    *,
    db: Any,
    user_id: str,
    passphrase: str,
    wrapper_method: str | None,
    dry_run: bool,
) -> dict[str, Any]:
    wrapper_query = db.table("vault_key_wrappers").select("*").eq("user_id", user_id)
    if wrapper_method:
        wrapper_query = wrapper_query.eq("method", wrapper_method)
    elif passphrase:
        wrapper_query = wrapper_query.eq("method", "passphrase")
    wrapper_rows = wrapper_query.order("created_at", desc=True).execute().data or []
    if not wrapper_rows:
        return {
            "user_id": user_id,
            "status": "skipped",
            "reason": "no_wrapper",
            "wrapper_method": wrapper_method or "passphrase",
        }

    vault_key_hex = _unwrap_vault_key(passphrase, wrapper_rows[0])

    blob_rows = db.table("pkm_data").select("*").eq("user_id", user_id).execute().data or []
    index_rows = db.table("pkm_index").select("*").eq("user_id", user_id).execute().data or []
    if not blob_rows:
        return {"user_id": user_id, "status": "skipped", "reason": "no_pkm_blob"}

    blob_row = blob_rows[0]
    payload = EncryptedPayload(
        ciphertext=blob_row["encrypted_data_ciphertext"],
        iv=blob_row["encrypted_data_iv"],
        tag=blob_row["encrypted_data_tag"],
        encoding="base64",
        algorithm=blob_row.get("algorithm", "aes-256-gcm"),
    )
    decrypted = decrypt_data(payload, vault_key_hex)
    pkm_blob = json.loads(decrypted)
    if not isinstance(pkm_blob, dict):
        return {"user_id": user_id, "status": "skipped", "reason": "invalid_blob"}

    financial = pkm_blob.get("financial")
    if not isinstance(financial, dict):
        return {"user_id": user_id, "status": "skipped", "reason": "no_financial_domain"}

    canonical_v2, raw_extract_v2 = _derive_portfolio_v2_from_financial(financial)
    if not canonical_v2:
        return {"user_id": user_id, "status": "skipped", "reason": "no_portfolio_source"}

    analytics = financial.get("analytics")
    if not isinstance(analytics, dict):
        analytics = build_financial_analytics_v2(
            canonical_portfolio_v2=canonical_v2,
            raw_extract_v2=raw_extract_v2,
        )

    financial["portfolio"] = canonical_v2
    financial["analytics"] = analytics
    financial["schema_version"] = max(int(financial.get("schema_version") or 0), 3)
    financial["updated_at"] = _now_iso()
    pkm_blob["financial"] = financial

    summary = _build_summary_from_financial(financial)

    if not dry_run:
        encrypted = encrypt_data(json.dumps(pkm_blob), vault_key_hex)
        db.table("pkm_data").update(
            {
                "encrypted_data_ciphertext": encrypted.ciphertext,
                "encrypted_data_iv": encrypted.iv,
                "encrypted_data_tag": encrypted.tag,
                "algorithm": encrypted.algorithm,
                "updated_at": _now_iso(),
            }
        ).eq("user_id", user_id).execute()

        if index_rows:
            next_index = _update_index_summary_v2(index_rows[0], summary)
            db.table("pkm_index").update(
                {
                    "domain_summaries": next_index.get("domain_summaries") or {},
                    "available_domains": next_index.get("available_domains") or [],
                    "updated_at": _now_iso(),
                }
            ).eq("user_id", user_id).execute()

    return {
        "user_id": user_id,
        "status": "migrated",
        "holdings_count": summary["holdings_count"],
        "investable_positions_count": summary["investable_positions_count"],
        "cash_positions_count": summary["cash_positions_count"],
    }


def _index_only_migration(db: Any, *, user_id: str | None, dry_run: bool) -> dict[str, Any]:
    query = db.table("pkm_index").select("*")
    if user_id:
        query = query.eq("user_id", user_id)
    rows = query.execute().data or []

    updated = 0
    scanned = 0
    for row in rows:
        scanned += 1
        uid = row.get("user_id")
        summaries = row.get("domain_summaries")
        if not isinstance(summaries, dict):
            continue
        fin = summaries.get("financial")
        if not isinstance(fin, dict):
            continue
        next_summary = dict(fin)
        next_summary.setdefault("domain_contract_version", 2)
        next_summary.setdefault(
            "intent_map",
            [
                "portfolio",
                "analytics",
                "documents",
                "profile",
                "analysis_history",
                "analysis.decisions",
                "runtime",
            ],
        )
        summaries["financial"] = next_summary

        available_domains = row.get("available_domains")
        if not isinstance(available_domains, list):
            available_domains = []
        if "financial" not in available_domains:
            available_domains.append("financial")

        if not dry_run and uid:
            db.table("pkm_index").update(
                {
                    "domain_summaries": summaries,
                    "available_domains": available_domains,
                    "updated_at": _now_iso(),
                }
            ).eq("user_id", uid).execute()
        updated += 1

    return {"scanned": scanned, "updated": updated}


async def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate financial domain to V2 canonical shape")
    parser.add_argument("--user-id", type=str, default=None, help="Target user id (optional)")
    parser.add_argument(
        "--passphrase", type=str, default=None, help="Passphrase for deep migration"
    )
    parser.add_argument(
        "--wrapper-method",
        type=str,
        default=None,
        help="Explicit wrapper method to use for unwrapping (defaults to passphrase when --passphrase is provided).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not persist updates")
    parser.add_argument(
        "--index-only",
        action="store_true",
        help="Run only index summary migration (no decrypt/re-encrypt)",
    )
    args = parser.parse_args()

    db = get_db()
    index_result = _index_only_migration(db, user_id=args.user_id, dry_run=args.dry_run)
    print(json.dumps({"stage": "index_only", **index_result}, indent=2))

    if args.index_only:
        return

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
                    "stage": "deep_migration",
                    "status": "skipped",
                    "reason": "missing_user_or_passphrase",
                    "hint": "Provide --user-id and --passphrase (or REVIEWER_UID/REVIEWER_VAULT_PASSPHRASE; KAI_TEST_* aliases are deprecated).",
                },
                indent=2,
            )
        )
        return

    result = await _deep_migrate_user(
        db=db,
        user_id=user_id,
        passphrase=passphrase,
        wrapper_method=args.wrapper_method,
        dry_run=args.dry_run,
    )
    print(json.dumps({"stage": "deep_migration", **result}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
