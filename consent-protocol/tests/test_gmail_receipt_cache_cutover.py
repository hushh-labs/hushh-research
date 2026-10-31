"""Regression contract for the non-destructive Gmail receipt privacy cutover."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "267_gmail_receipt_cache_read_only_cutover.sql"
ROLLBACK = "267_gmail_receipt_cache_read_only_cutover.rollback.sql"


def test_receipt_cache_cutover_is_registered_reversible_and_blocks_new_writes() -> None:
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    migration = (ROOT / "db/migrations" / MIGRATION).read_text()
    rollback = (ROOT / "db/migrations/rollback" / ROLLBACK).read_text()

    assert MIGRATION in manifest["ordered_migrations"]
    assert manifest["rollback_migrations"][MIGRATION] == f"rollback/{ROLLBACK}"
    assert "BEFORE INSERT OR UPDATE ON kai_gmail_receipts" in migration
    assert "BEFORE INSERT OR UPDATE ON kai_receipt_memory_artifacts" in migration
    assert "DROP TRIGGER IF EXISTS block_kai_gmail_receipts_writes" in rollback
    assert "DROP TRIGGER IF EXISTS block_kai_receipt_memory_artifact_writes" in rollback

    for contract_name in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        contract = json.loads((ROOT / "db/contracts" / contract_name).read_text())
        assert contract["expected_migration_version"] >= 264
        assert "block_gmail_receipt_cache_writes" in contract["required_functions"]
