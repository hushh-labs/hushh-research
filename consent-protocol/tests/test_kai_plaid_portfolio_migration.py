from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "113_kai_plaid_portfolio_tables.sql"
MIGRATION = ROOT / "db" / "migrations" / MIGRATION_NAME
CONTRACTS = ROOT / "db" / "contracts"
DATA_PLANE_CONTRACT = (
    ROOT.parent / "docs" / "reference" / "architecture" / ("runtime-db-data-plane-contract.json")
)


def _json(path: Path) -> dict:
    return json.loads(path.read_text())


def _release_versions(manifest: dict) -> list[int]:
    return [
        int(name.split("_", 1)[0]) for name in manifest["ordered_migrations"] if name[:3].isdigit()
    ]


def test_kai_plaid_tables_are_registered_in_release_manifest_and_contracts():
    manifest = _json(ROOT / "db" / "release_migration_manifest.json")
    base_versions = _release_versions(manifest)
    uat_versions = base_versions + [
        int(name.split("_", 1)[0])
        for name in manifest["environment_overlays"]["uat"]
        if name[:3].isdigit()
    ]

    assert MIGRATION.exists()
    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert len(manifest["ordered_migrations"]) == len(set(manifest["ordered_migrations"]))

    expected_heads = {
        "dev_minimum_schema.json": max(base_versions),
        "prod_core_schema.json": max(base_versions),
        "uat_integrated_schema.json": max(uat_versions),
    }
    for contract_name, expected_head in expected_heads.items():
        contract = _json(CONTRACTS / contract_name)
        assert contract["expected_migration_version"] == expected_head
        required_tables = contract["required_tables"]
        for table in (
            "kai_plaid_items",
            "kai_plaid_refresh_runs",
            "kai_plaid_link_sessions",
            "kai_portfolio_source_preferences",
        ):
            assert table in required_tables, f"{table} missing from {contract_name}"


def test_kai_plaid_migration_subsumes_unmanifested_table_shape():
    sql = MIGRATION.read_text()

    for required in (
        "CREATE TABLE IF NOT EXISTS kai_plaid_items",
        "CREATE TABLE IF NOT EXISTS kai_plaid_refresh_runs",
        "CREATE TABLE IF NOT EXISTS kai_plaid_link_sessions",
        "CREATE TABLE IF NOT EXISTS kai_portfolio_source_preferences",
        "access_token_ciphertext",
        "access_token_iv",
        "access_token_tag",
        "access_token_algorithm",
        "latest_accounts_json",
        "latest_holdings_json",
        "latest_securities_json",
        "latest_transactions_json",
        "latest_summary_json",
        "latest_portfolio_json",
        "latest_metadata_json",
        "resume_session_id",
        "'canceled'",
    ):
        assert required in sql

    assert "DROP TABLE" not in sql
    assert "DROP COLUMN" not in sql


def test_kai_plaid_provider_cache_stays_in_data_plane_contract():
    contract = _json(DATA_PLANE_CONTRACT)
    provider_cache = next(
        entry
        for entry in contract["table_families"]
        if entry["id"] == "kai_brokerage_provider_cache"
    )

    assert "kai_plaid_*" in provider_cache["glob_tables"]
    assert "kai_portfolio_source_preferences" in provider_cache["glob_tables"]
    assert provider_cache["data_class"] == "provider_cache"
    assert provider_cache["plaintext_posture"] == "encrypted_tokens_and_cache_metadata"
