from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_action_directive_ledger_is_in_release_and_schema_contracts():
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    uat = json.loads((ROOT / "db/contracts/uat_integrated_schema.json").read_text())
    dev = json.loads((ROOT / "db/contracts/dev_minimum_schema.json").read_text())

    assert "114_one_action_directive_ledger.sql" in manifest["ordered_migrations"]
    assert uat["expected_migration_version"] >= 114
    assert dev["expected_migration_version"] >= 114
    assert "one_action_directive_ledger" in uat["required_tables"]
    assert "one_action_directive_ledger" in dev["required_tables"]


def test_replayed_212_cannot_re_narrow_checks_that_231_widened():
    """Every replayed check must still admit later document and ADK channels."""
    migration = (ROOT / "db/migrations/212_location_command_runtime.sql").read_text()
    for name in ("one_action_directive_ledger_channel_check", "one_action_directive_ledger_check"):
        match = re.search(rf"ADD CONSTRAINT {name}\b", migration)
        assert match, name
        statement = migration[match.start() : migration.index(";", match.start())]
        assert statement.rstrip().endswith("NOT VALID"), name
        assert "'document_review'" in statement
        assert "'adk_chat'" in statement
    document_migration = (ROOT / "db/migrations/231_document_review_authority.sql").read_text()
    for name in ("one_action_directive_ledger_channel_check", "one_action_directive_ledger_check"):
        match = re.search(rf"ADD CONSTRAINT {name}\b", document_migration)
        assert match, name
        statement = document_migration[
            match.start() : document_migration.index(",\n  ADD CONSTRAINT", match.start())
        ]
        assert "'adk_chat'" in statement


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
