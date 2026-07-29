from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_trusted_device_migration_is_release_ordered_and_metadata_only() -> None:
    manifest = json.loads(
        (ROOT / "db" / "release_migration_manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["ordered_migrations"][-1] == "123_pkm_device_sync.sql"
    assert "122_trusted_device_repair.sql" in manifest["groups"]["iam"]

    sql = (ROOT / "db" / "migrations" / "121_trusted_devices.sql").read_text(encoding="utf-8")
    repair_sql = (ROOT / "db" / "migrations" / "122_trusted_device_repair.sql").read_text(
        encoding="utf-8"
    )
    for table in (
        "trusted_device_authorizations",
        "trusted_devices",
        "trusted_device_challenges",
        "trusted_device_audit_events",
    ):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql
    lowered = sql.lower()
    assert "firebase_refresh_token" not in lowered
    assert "vault_passphrase" not in lowered
    assert "vault_key " not in lowered
    assert "add column if not exists replaces_device_id" in repair_sql.lower()

    expected_columns = {
        "trusted_device_authorizations": {
            "authorization_id",
            "device_id",
            "user_id",
            "code_hash",
            "redirect_uri",
            "code_challenge",
            "device_public_key",
            "device_name",
            "platform",
            "created_at",
            "expires_at",
            "consumed_at",
            "replaces_device_id",
        },
        "trusted_devices": {
            "device_id",
            "user_id",
            "device_public_key",
            "device_name",
            "platform",
            "status",
            "created_at",
            "last_used_at",
            "revoked_at",
        },
        "trusted_device_challenges": {
            "challenge_id",
            "device_id",
            "user_id",
            "nonce_hash",
            "created_at",
            "expires_at",
            "consumed_at",
        },
        "trusted_device_audit_events": {
            "event_id",
            "user_id",
            "device_id",
            "event_type",
            "created_at",
            "metadata",
        },
    }
    for contract_name in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        contract = json.loads(
            (ROOT / "db" / "contracts" / contract_name).read_text(encoding="utf-8")
        )
        assert contract["expected_migration_version"] == 123
        for table, columns in expected_columns.items():
            assert set(contract["required_tables"][table]) == columns
