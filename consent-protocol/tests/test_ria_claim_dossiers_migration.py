from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = REPO_ROOT / "db" / "contracts"
MIGRATION = "137_ria_claim_dossiers.sql"

DOSSIER_STATUSES = (
    "queued",
    "scanning",
    "generated",
    "sent",
    "scan_failed",
    "send_failed",
    "blocked_no_email",
    "send_blocked_test_unset",
)


def test_ria_claim_dossiers_migration_is_registered_in_the_release_lane() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert MIGRATION in manifest["ordered_migrations"]
    assert MIGRATION in manifest["groups"]["iam"]
    assert manifest["ordered_migrations"].index(MIGRATION) > manifest["ordered_migrations"].index(
        "136_one_location_circle_member_invites.sql"
    )
    assert (MIGRATIONS_DIR / MIGRATION).exists()
    assert (MIGRATIONS_DIR / "rollback" / "137_ria_claim_dossiers_down.sql").exists()


def test_ria_claim_dossiers_schema_is_idempotent_and_best_effort() -> None:
    migration = (MIGRATIONS_DIR / MIGRATION).read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS ria_claim_dossiers" in migration
    assert "REFERENCES ria_profiles(id) ON DELETE CASCADE" in migration
    # The dispatch idempotency key: one dossier per claimed (profile, CRD).
    assert "UNIQUE (ria_profile_id, crd_number)" in migration
    assert "DEFAULT 'queued'" in migration
    for status in DOSSIER_STATUSES:
        assert f"'{status}'" in migration
    assert "requested_at TIMESTAMPTZ NOT NULL DEFAULT now()" in migration
    assert "completed_at TIMESTAMPTZ" in migration
    # A dossier row grants nothing and never writes into other planes.
    assert "INSERT INTO" not in migration
    assert "ALTER TABLE ria_profiles" not in migration


def test_ria_claim_dossiers_is_covered_by_the_schema_contracts() -> None:
    for contract_name in ("uat_integrated_schema.json", "prod_core_schema.json"):
        contract = json.loads((CONTRACTS_DIR / contract_name).read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 137
        assert set(contract["required_tables"]["ria_claim_dossiers"]) >= {
            "ria_profile_id",
            "crd_number",
            "user_id",
            "status",
            "scan_id",
            "result_markdown",
            "mail_message_id",
            "requested_at",
            "completed_at",
        }

    dev_contract = json.loads(
        (CONTRACTS_DIR / "dev_minimum_schema.json").read_text(encoding="utf-8")
    )
    assert dev_contract["expected_migration_version"] >= 137


def test_ria_claim_dossiers_rollback_drops_only_the_dossier_table() -> None:
    rollback = (MIGRATIONS_DIR / "rollback" / "137_ria_claim_dossiers_down.sql").read_text(
        encoding="utf-8"
    )

    assert "DROP TABLE IF EXISTS ria_claim_dossiers" in rollback
    assert "DROP TABLE IF EXISTS ria_profiles" not in rollback
    assert "actor_profiles" not in rollback
