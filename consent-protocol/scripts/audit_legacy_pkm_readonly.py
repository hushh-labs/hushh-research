#!/usr/bin/env python3
"""Read-only legacy PKM/world-model audit with redacted output.

This script is intentionally privacy-preserving:
- Reads encrypted PKM / wrapper rows only
- Decrypts locally in memory
- Never writes back to the database
- Never prints plaintext field values
- Emits only structural metadata, counts, versions, and readiness signals

Use this for upgrade-edge-case audits where a user may still carry legacy
`pkm_data` / world-model-era storage and we need to verify decryptability and
upgrade readiness without exposing PII.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"

if str(CONSENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_ROOT))

from db.db_client import get_db  # noqa: E402
from hushh_mcp.kai_import.normalize_v2 import (  # noqa: E402
    build_financial_analytics_v2,
    build_financial_portfolio_canonical_v2,
)
from hushh_mcp.services.domain_contracts import (  # noqa: E402
    CURRENT_PKM_MODEL_VERSION,
    CURRENT_READABLE_SUMMARY_VERSION,
    current_domain_contract_version,
)
from hushh_mcp.services.personal_knowledge_model_service import (  # noqa: E402
    PersonalKnowledgeModelService,
)
from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService  # noqa: E402
from hushh_mcp.types import EncryptedPayload  # noqa: E402
from hushh_mcp.vault.encrypt import decrypt_data, encrypt_data  # noqa: E402


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


def _legacy_blob_summary(blob: dict[str, Any]) -> dict[str, Any]:
    top_level_domains = sorted(
        key for key, value in blob.items() if isinstance(value, dict) and not key.startswith("__")
    )
    financial = blob.get("financial") if isinstance(blob.get("financial"), dict) else {}
    portfolio = financial.get("portfolio") if isinstance(financial.get("portfolio"), dict) else {}
    documents = financial.get("documents") if isinstance(financial.get("documents"), dict) else {}
    statements = (
        documents.get("statements") if isinstance(documents.get("statements"), list) else []
    )
    holdings = portfolio.get("holdings") if isinstance(portfolio.get("holdings"), list) else []
    analysis_history = (
        financial.get("analysis_history")
        if isinstance(financial.get("analysis_history"), dict)
        else {}
    )

    history_ticker_count = 0
    history_entry_count = 0
    if isinstance(analysis_history, dict):
        history_ticker_count = len(analysis_history)
        history_entry_count = sum(
            len(entries) for entries in analysis_history.values() if isinstance(entries, list)
        )

    canonical_v2, raw_extract_v2 = _derive_portfolio_v2_from_financial(financial)
    can_materialize_v2 = canonical_v2 is not None
    canonical_v2_holdings_count = (
        len(canonical_v2.get("holdings") or [])
        if isinstance(canonical_v2, dict) and isinstance(canonical_v2.get("holdings"), list)
        else 0
    )
    analytics_v2 = (
        build_financial_analytics_v2(
            canonical_portfolio_v2=canonical_v2,
            raw_extract_v2=raw_extract_v2,
        )
        if isinstance(canonical_v2, dict)
        else None
    )

    return {
        "top_level_domains": top_level_domains,
        "financial": {
            "schema_version": int(financial.get("schema_version") or 0),
            "has_portfolio": isinstance(financial.get("portfolio"), dict),
            "has_analytics": isinstance(financial.get("analytics"), dict),
            "statement_count": len(statements),
            "holdings_count": len(holdings),
            "analysis_history_ticker_count": history_ticker_count,
            "analysis_history_entry_count": history_entry_count,
            "can_materialize_canonical_v2": can_materialize_v2,
            "canonical_v2_holdings_count": canonical_v2_holdings_count,
            "analytics_v2_sections": sorted(analytics_v2.keys())
            if isinstance(analytics_v2, dict)
            else [],
        },
    }


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
        "domain_contract_version": current_domain_contract_version("financial"),
        "readable_summary_version": CURRENT_READABLE_SUMMARY_VERSION,
        "intent_map": [
            "portfolio",
            "analytics",
            "documents",
            "profile",
            "analysis_history",
            "analysis.decisions",
            "runtime",
        ],
    }


class _StubSupabaseTable:
    def __init__(self, rows: list[dict[str, Any]] | None = None):
        self.rows = list(rows or [])
        self.last_upsert_data = None
        self.last_insert_data = None
        self.last_delete_filters: list[tuple[str, Any]] = []
        self.filters: list[tuple[str, Any]] = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, column: str, value: Any):
        self.filters.append((column, value))
        return self

    def limit(self, _count: int):
        return self

    def delete(self):
        self.last_delete_filters = list(self.filters)
        self.rows = []
        return self

    def insert(self, data: Any):
        self.last_insert_data = data
        return self

    def upsert(self, data: Any, on_conflict: str | None = None):
        self.last_upsert_data = {"data": data, "on_conflict": on_conflict}
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self.last_upsert_data is not None or self.last_insert_data is not None:
            return SimpleNamespace(data=[{}], error=None)
        filtered = self.rows
        for column, value in self.filters:
            filtered = [row for row in filtered if row.get(column) == value]
        return SimpleNamespace(data=filtered, error=None)


class _StubSupabase:
    def __init__(self):
        self.tables = {
            "pkm_blobs": _StubSupabaseTable(),
            "pkm_manifests": _StubSupabaseTable(),
            "pkm_manifest_paths": _StubSupabaseTable(),
            "pkm_scope_registry": _StubSupabaseTable(),
            "pkm_migration_state": _StubSupabaseTable(),
        }

    def table(self, name: str):
        table = self.tables.get(name)
        if table is None:
            table = _StubSupabaseTable()
            self.tables[name] = table
        table.filters = []
        return table


async def _rehearse_current_pkm_write(
    *,
    user_id: str,
    parsed_blob: dict[str, Any],
    current_domains: list[str],
    vault_key_hex: str,
) -> dict[str, Any]:
    financial = (
        parsed_blob.get("financial") if isinstance(parsed_blob.get("financial"), dict) else {}
    )
    if not financial:
        return {"rehearsal_success": False, "reason": "no_financial_domain"}

    canonical_v2, raw_extract_v2 = _derive_portfolio_v2_from_financial(financial)
    if not canonical_v2:
        return {"rehearsal_success": False, "reason": "no_portfolio_source"}

    analytics = financial.get("analytics")
    if not isinstance(analytics, dict):
        analytics = build_financial_analytics_v2(
            canonical_portfolio_v2=canonical_v2,
            raw_extract_v2=raw_extract_v2,
        )

    rehearse_financial = dict(financial)
    rehearse_financial["portfolio"] = canonical_v2
    rehearse_financial["analytics"] = analytics
    rehearse_financial["schema_version"] = max(
        int(rehearse_financial.get("schema_version") or 0), 3
    )

    structure_decision = PKMAgentLabService._fallback_structure_decision(
        message="Repartition legacy financial world model into current PKM financial domain.",
        current_domains=current_domains,
        intent_frame={
            "mutation_intent": "create",
            "intent_class": "financial_event",
            "save_class": "durable",
            "confidence": 0.99,
            "candidate_domain_choices": [{"domain_key": "financial", "recommended": True}],
        },
        target_domain="financial",
        candidate_payload=rehearse_financial,
    )
    manifest = PKMAgentLabService._build_manifest_from_payload(
        user_id=user_id,
        domain="financial",
        payload=rehearse_financial,
        structure_decision=structure_decision,
    )
    summary = _build_summary_from_financial(rehearse_financial)
    encrypted = encrypt_data(json.dumps(rehearse_financial), vault_key_hex)

    service = PersonalKnowledgeModelService()
    service._supabase = _StubSupabase()
    service.get_encrypted_data = AsyncMock(return_value=None)
    service.get_domain_manifest = AsyncMock(return_value=None)
    service.update_domain_summary = AsyncMock(return_value=True)
    service._queue_consent_export_refreshes_for_domain_write = AsyncMock(return_value=None)
    service.record_mutation_event = AsyncMock(return_value=True)

    result = await service.store_domain_data(
        user_id=user_id,
        domain="financial",
        encrypted_blob={
            "ciphertext": encrypted.ciphertext,
            "iv": encrypted.iv,
            "tag": encrypted.tag,
            "algorithm": encrypted.algorithm,
        },
        summary=summary,
        manifest=manifest,
        structure_decision=structure_decision,
        upgrade_context={
            "mode": "legacy_world_model_rehearsal",
            "target_model_version": CURRENT_PKM_MODEL_VERSION,
            "target_domain_contract_version": current_domain_contract_version("financial"),
            "target_readable_summary_version": CURRENT_READABLE_SUMMARY_VERSION,
        },
        return_result=True,
    )

    stub = service._supabase
    blob_upsert = stub.tables["pkm_blobs"].last_upsert_data or {}
    manifest_upsert = stub.tables["pkm_manifests"].last_upsert_data or {}
    scope_upsert = stub.tables["pkm_scope_registry"].last_upsert_data or {}

    return {
        "rehearsal_success": bool(result.get("success")),
        "target_model_version": CURRENT_PKM_MODEL_VERSION,
        "target_domain_contract_version": current_domain_contract_version("financial"),
        "target_readable_summary_version": CURRENT_READABLE_SUMMARY_VERSION,
        "would_write_domain": "financial",
        "would_write_segments": sorted(
            {row.get("segment_id") for row in blob_upsert.get("data", []) if isinstance(row, dict)}
        ),
        "would_write_content_revision": (
            blob_upsert.get("data", [{}])[0].get("content_revision")
            if isinstance(blob_upsert.get("data"), list) and blob_upsert.get("data")
            else None
        ),
        "would_write_manifest_version": (
            manifest_upsert.get("data", {}).get("manifest_version")
            if isinstance(manifest_upsert.get("data"), dict)
            else None
        ),
        "path_count": manifest.get("path_count"),
        "externalizable_path_count": manifest.get("externalizable_path_count"),
        "scope_registry_count": (
            len(scope_upsert.get("data", [])) if isinstance(scope_upsert.get("data"), list) else 0
        ),
        "summary_preview": {
            "holdings_count": summary.get("holdings_count"),
            "investable_positions_count": summary.get("investable_positions_count"),
            "cash_positions_count": summary.get("cash_positions_count"),
            "domain_contract_version": summary.get("domain_contract_version"),
            "readable_summary_version": summary.get("readable_summary_version"),
        },
    }


def _query_one(db: Any, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
    result = db.execute_raw(sql, params)
    return result.data[0] if result.data else None


def _query_all(db: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    result = db.execute_raw(sql, params)
    return result.data or []


def _table_exists(db: Any, table_name: str) -> bool:
    row = _query_one(
        db,
        """
        select table_name
        from information_schema.tables
        where table_schema = 'public' and table_name = :table_name
        limit 1
        """,
        {"table_name": table_name},
    )
    return row is not None


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read-only redacted audit for legacy PKM/world-model upgrade readiness."
    )
    parser.add_argument("--env-file", default=str(CONSENT_ROOT / ".env"))
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--passphrase", default=None)
    parser.add_argument("--wrapper-method", default="passphrase")
    args = parser.parse_args()

    load_dotenv(args.env_file, override=True)
    db = get_db()
    user_id = str(args.user_id).strip()
    passphrase = str(args.passphrase or os.getenv("KAI_TEST_PASSPHRASE") or "").strip()
    if not passphrase:
        raise RuntimeError("Missing passphrase. Pass --passphrase or set KAI_TEST_PASSPHRASE.")

    has_pkm_data = _table_exists(db, "pkm_data")
    has_world_model_data = _table_exists(db, "world_model_data")
    has_pkm_index = _table_exists(db, "pkm_index")
    has_world_model_index_v2 = _table_exists(db, "world_model_index_v2")
    has_pkm_manifests = _table_exists(db, "pkm_manifests")
    has_pkm_blobs = _table_exists(db, "pkm_blobs")

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

    legacy_blob_source = "none"
    legacy_blob_row = None
    if has_pkm_data:
        legacy_blob_source = "pkm_data"
        legacy_blob_row = _query_one(
            db,
            """
            select user_id, encrypted_data_ciphertext, encrypted_data_iv, encrypted_data_tag, algorithm, updated_at
            from pkm_data
            where user_id = :user_id
            order by updated_at desc nulls last
            limit 1
            """,
            {"user_id": user_id},
        )
    elif has_world_model_data:
        legacy_blob_source = "world_model_data"
        legacy_blob_row = _query_one(
            db,
            """
            select user_id, encrypted_data_ciphertext, encrypted_data_iv, encrypted_data_tag, algorithm, updated_at
            from world_model_data
            where user_id = :user_id
            order by updated_at desc nulls last
            limit 1
            """,
            {"user_id": user_id},
        )

    index_source = "none"
    index_rows: list[dict[str, Any]] = []
    if has_pkm_index:
        index_source = "pkm_index"
        index_rows = _query_all(
            db,
            """
            select user_id, model_version, last_upgraded_at, available_domains
            from pkm_index
            where user_id = :user_id
            """,
            {"user_id": user_id},
        )
    elif has_world_model_index_v2:
        index_source = "world_model_index_v2"
        index_rows = _query_all(
            db,
            """
            select user_id, model_version, updated_at as last_upgraded_at, available_domains
            from world_model_index_v2
            where user_id = :user_id
            """,
            {"user_id": user_id},
        )

    manifest_rows: list[dict[str, Any]] = []
    if has_pkm_manifests:
        manifest_rows = _query_all(
            db,
            """
            select user_id, domain, manifest_version, domain_contract_version, readable_summary_version, upgraded_at
            from pkm_manifests
            where user_id = :user_id
            order by domain
            """,
            {"user_id": user_id},
        )

    blob_rows: list[dict[str, Any]] = []
    if has_pkm_blobs:
        blob_rows = _query_all(
            db,
            """
            select user_id, domain, content_revision, updated_at
            from pkm_blobs
            where user_id = :user_id
            order by domain
            """,
            {"user_id": user_id},
        )

    storage_mode = (
        "hybrid"
        if legacy_blob_row and (manifest_rows or blob_rows)
        else f"legacy_{legacy_blob_source}"
        if legacy_blob_row
        else "manifest_domain"
        if (manifest_rows or blob_rows)
        else "none"
    )

    audit: dict[str, Any] = {
        "user_id": user_id,
        "read_only": True,
        "plaintext_logged": False,
        "storage_mode": storage_mode,
        "legacy_blob_source": legacy_blob_source,
        "index_source": index_source,
        "wrapper_present": wrapper is not None,
        "legacy_blob_present": legacy_blob_row is not None,
        "pkm_index_rows": len(index_rows),
        "pkm_manifest_rows": len(manifest_rows),
        "pkm_blob_rows": len(blob_rows),
        "current_index": index_rows[0] if index_rows else None,
        "current_manifests": manifest_rows,
        "current_blob_domains": [
            {"domain": row.get("domain"), "content_revision": row.get("content_revision")}
            for row in blob_rows
        ],
        "decryptable": False,
        "legacy_shape": None,
        "pkm_rehearsal": None,
        "notes": [],
    }

    if not wrapper:
        audit["notes"].append("No passphrase wrapper found for the target user.")
        print(json.dumps(audit, indent=2, default=str))
        return

    if not legacy_blob_row:
        audit["notes"].append(
            f"No legacy encrypted blob row present for the target user in {legacy_blob_source}."
        )
        print(json.dumps(audit, indent=2, default=str))
        return

    vault_key_hex = _unwrap_vault_key(passphrase, wrapper)
    payload = EncryptedPayload(
        ciphertext=legacy_blob_row["encrypted_data_ciphertext"],
        iv=legacy_blob_row["encrypted_data_iv"],
        tag=legacy_blob_row["encrypted_data_tag"],
        encoding="base64",
        algorithm=legacy_blob_row.get("algorithm", "aes-256-gcm"),
    )
    decrypted = decrypt_data(payload, vault_key_hex)
    parsed = json.loads(decrypted)
    if not isinstance(parsed, dict):
        raise RuntimeError("Legacy PKM blob decrypted but was not a JSON object.")

    audit["decryptable"] = True
    audit["legacy_shape"] = _legacy_blob_summary(parsed)
    current_domains = (
        list(index_rows[0].get("available_domains") or [])
        if index_rows and isinstance(index_rows[0], dict)
        else []
    )
    audit["pkm_rehearsal"] = await _rehearse_current_pkm_write(
        user_id=user_id,
        parsed_blob=parsed,
        current_domains=current_domains,
        vault_key_hex=vault_key_hex,
    )
    audit["notes"].append(
        "Decryption succeeded locally and only structural upgrade-readiness metadata was emitted."
    )

    print(json.dumps(audit, indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main())
