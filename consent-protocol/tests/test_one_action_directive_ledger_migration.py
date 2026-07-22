from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_action_directive_ledger_is_in_release_and_schema_contracts():
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    uat = json.loads((ROOT / "db/contracts/uat_integrated_schema.json").read_text())
    dev = json.loads((ROOT / "db/contracts/dev_minimum_schema.json").read_text())

    ordered = manifest["ordered_migrations"]
    assert ordered.index("114_one_action_directive_ledger.sql") < ordered.index(
        "115_one_location_connection_visibility.sql"
    )
    assert uat["expected_migration_version"] == 115
    assert dev["expected_migration_version"] == 115
    assert "one_action_directive_ledger" in uat["required_tables"]
    assert "one_action_directive_ledger" in dev["required_tables"]


def test_action_directive_ledger_stores_metadata_not_protected_payloads():
    migration = (ROOT / "db/migrations/114_one_action_directive_ledger.sql").read_text()
    lowered = migration.lower()

    for prohibited_column_declaration in (
        "\n  prompt_ciphertext ",
        "\n  prompt_plaintext ",
        "\n  slots_json ",
        "\n  credential ",
        "\n  export_payload ",
        "\n  protected_information ",
    ):
        assert prohibited_column_declaration not in lowered
    assert "slots_hmac" in lowered
    assert "resource_binding_hmac" in lowered
    assert "receipt_hash" in lowered
