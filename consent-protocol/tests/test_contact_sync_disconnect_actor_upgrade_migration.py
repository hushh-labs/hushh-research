from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_NAME = "206_contact_sync_disconnect_actor_upgrade.sql"


def test_disconnect_actor_upgrade_is_registered_in_every_release_contract() -> None:
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())

    assert MIGRATION_NAME in manifest["ordered_migrations"]
    assert manifest["ordered_migrations"].index(MIGRATION_NAME) > manifest[
        "ordered_migrations"
    ].index("205_contact_sync_disconnect_actor.sql")
    assert MIGRATION_NAME in manifest["groups"]["iam"]
    assert manifest["rollback_migrations"][MIGRATION_NAME] == (
        "rollback/206_contact_sync_disconnect_actor_upgrade.rollback.sql"
    )

    for contract_name in (
        "dev_minimum_schema.json",
        "prod_core_schema.json",
        "uat_integrated_schema.json",
    ):
        contract = json.loads((ROOT / "db/contracts" / contract_name).read_text())
        assert contract["expected_migration_version"] >= 206


def test_disconnect_actor_upgrade_translates_only_verified_current_episodes() -> None:
    migration = (ROOT / "db/migrations" / MIGRATION_NAME).read_text()

    assert "column_name = 'revoked_by_user_id'" in migration
    assert "revoked_by_at = revoked_at" in migration
    assert "revoked_by_user_id IN (user_a_id, user_b_id)" in migration
    assert "WHEN user_a_id = revoked_by_user_id THEN 'a'" in migration
    assert "WHEN user_b_id = revoked_by_user_id THEN 'b'" in migration
    assert "DROP CONSTRAINT IF EXISTS connections_revocation_actor_pair" in migration
    assert "CHECK (revoked_by_side IS NULL OR revoked_by_side IN ('a', 'b'))" in migration
