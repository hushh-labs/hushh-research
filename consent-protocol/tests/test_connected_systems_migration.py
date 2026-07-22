import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_connected_systems_migration_is_registered_before_current_release_head():
    migration = ROOT / "db" / "migrations" / "067_connected_systems.sql"
    assert migration.exists()

    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]
    # Invariant (not a tail snapshot): 067 is registered, ordered immediately
    # after 066, and before the migrations that follow it. Asserting the
    # relationship rather than a fixed [-3:] slice keeps this stable as new
    # migrations land at the head.
    idx = ordered.index("067_connected_systems.sql")
    assert ordered[idx - 1] == "066_marketplace_visibility_posture.sql"
    assert ordered[idx + 1] == "068_one_location_circle_invites.sql"
    assert "067_connected_systems.sql" in manifest["groups"]["iam"]

    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    assert contract["expected_migration_version"] >= 82
    assert contract["migration_version_policy"] == "exact"


def test_connected_systems_tables_are_contract_required_and_secret_free():
    sql = (ROOT / "db" / "migrations" / "067_connected_systems.sql").read_text()
    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    required_tables = contract["required_tables"]

    intent_columns = set(required_tables["connected_system_intents"])
    binding_columns = set(required_tables["connected_system_record_bindings"])
    audit_columns = set(required_tables["connected_system_audit_events"])

    assert "CREATE TABLE IF NOT EXISTS connected_system_intents" in sql
    assert "CREATE TABLE IF NOT EXISTS connected_system_record_bindings" in sql
    assert "CREATE TABLE IF NOT EXISTS connected_system_audit_events" in sql
    assert {
        "request_payload_json",
        "readback_payload_json",
        "result_payload_json",
    } <= intent_columns
    assert {"binding_id", "record_id", "status", "last_intent_id"} <= binding_columns
    assert {"field_names_json", "metadata_json", "mcp_result_class"} <= audit_columns
    all_columns = intent_columns | binding_columns | audit_columns
    assert "email" not in all_columns
    assert "phone" not in all_columns
    assert "endpoint" not in all_columns
    assert "token" not in all_columns
    assert "credential" not in all_columns


def test_response_contract_migration_is_registered_and_fail_closed_by_default():
    migration = ROOT / "db" / "migrations" / "102_crm_operation_response_contract.sql"
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    uat_contract = json.loads(
        (ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text()
    )

    assert migration.exists()
    ordered = manifest["ordered_migrations"]
    response_contract_index = ordered.index("102_crm_operation_response_contract.sql")
    assert ordered[response_contract_index : response_contract_index + 3] == [
        "102_crm_operation_response_contract.sql",
        "103_demo_crm_response_contracts.sql",
        "104_crm_schema_mapping_cache.sql",
    ]
    assert "102_crm_operation_response_contract.sql" in manifest["groups"]["iam"]
    assert "response_contract JSONB NOT NULL DEFAULT '{}'::jsonb" in migration.read_text()
    migration_text = migration.read_text()
    assert "AND operation = 'schema'" in migration_text
    assert "'objectPath'" in migration_text
    assert "'requireFieldAccess', true" in migration_text
    assert "response_contract" in uat_contract["required_tables"]["crm_operation_endpoints"]
    assert uat_contract["expected_migration_version"] >= 104


def test_demo_crm_response_mappings_and_schema_mapper_cache_are_release_registered():
    response_migration = ROOT / "db" / "migrations" / "103_demo_crm_response_contracts.sql"
    cache_migration = ROOT / "db" / "migrations" / "104_crm_schema_mapping_cache.sql"
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    uat_contract = json.loads(
        (ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text()
    )

    assert response_migration.exists()
    assert cache_migration.exists()
    assert "103_demo_crm_response_contracts.sql" in manifest["groups"]["iam"]
    assert "104_crm_schema_mapping_cache.sql" in manifest["groups"]["iam"]
    assert "mcp_is_error_false" in response_migration.read_text()
    assert "CREATE TABLE IF NOT EXISTS crm_schema_mapping_cache" in cache_migration.read_text()
    assert {
        "crm_id",
        "object_type",
        "schema_fingerprint",
        "model_name",
        "mapping_json",
        "expires_at",
    } <= set(uat_contract["required_tables"]["crm_schema_mapping_cache"])


def test_active_macys_registry_row_has_verified_response_contract_backfill():
    migration = ROOT / "db" / "migrations" / "111_macys_crm_response_contracts.sql"
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())

    assert migration.exists()
    ordered = manifest["ordered_migrations"]
    assert "111_macys_crm_response_contracts.sql" in ordered
    assert ordered.index("111_macys_crm_response_contracts.sql") < ordered.index(
        "112_dynamic_crm_registry_cache.sql"
    )
    assert "111_macys_crm_response_contracts.sql" in manifest["groups"]["iam"]
    sql = migration.read_text()
    assert "crm_id = 'crm_001'" in sql
    assert "crm-record-collection.v1" in sql
    assert "crm-mutation-result.v1" in sql
    assert "mcp_is_error_false" in sql


def test_dynamic_crm_registry_cache_is_platform_migration():
    migration = ROOT / "db" / "migrations" / "112_dynamic_crm_registry_cache.sql"
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    uat_contract = json.loads(
        (ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text()
    )

    sql = migration.read_text()
    assert migration.name in manifest["ordered_migrations"]
    assert migration.name in manifest["groups"]["iam"]
    assert "configuration_revision BIGINT NOT NULL DEFAULT 1" in sql
    assert "CREATE TABLE IF NOT EXISTS crm_schema_catalog_cache" in sql
    assert "CREATE TABLE IF NOT EXISTS crm_registry_audit_events" in sql
    assert "credential" not in " ".join(
        uat_contract["required_tables"]["crm_registry_audit_events"]
    )
