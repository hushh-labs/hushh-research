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
    assert contract["expected_migration_version"] == 71
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
