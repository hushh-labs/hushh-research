import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "consent-protocol" / "db" / "migrations"
MANIFEST = ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
CONTRACTS = (
    ROOT / "consent-protocol" / "db" / "contracts" / "dev_minimum_schema.json",
    ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json",
    ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json",
)
MIGRATION = "127_explicit_connection_scope_proposals.sql"


def test_explicit_connection_scope_proposals_are_released_and_verified():
    sql = (MIGRATIONS / MIGRATION).read_text(encoding="utf-8")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    assert manifest["ordered_migrations"].index(MIGRATION) < manifest["ordered_migrations"].index(
        "129_ria_pick_legacy_retirement.sql"
    )
    assert MIGRATION in manifest["groups"]["iam"]
    assert "CREATE TABLE IF NOT EXISTS connection_scope_proposals" in sql
    assert "CREATE TABLE IF NOT EXISTS connection_scope_proposal_events" in sql
    assert "expires_at TIMESTAMPTZ NOT NULL" in sql
    assert "REFERENCES connection_requests(id) ON DELETE CASCADE" not in sql
    assert "REFERENCES connection_scope_proposals(id) ON DELETE CASCADE" not in sql

    for contract_path in CONTRACTS:
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 127
        assert "connection_scope_proposals" in contract["required_tables"]
        assert "connection_scope_proposal_events" in contract["required_tables"]
        assert "expires_at" in contract["required_tables"]["connection_scope_proposals"]
        assert (
            "connection_scope_proposal_id"
            in contract["required_tables"]["relationship_share_grants"]
        )
