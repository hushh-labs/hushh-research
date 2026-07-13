from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_onboarding_journey_migration_is_registered_and_contract_backed() -> None:
    migration = (ROOT / "db/migrations/092_one_onboarding_journey_v1.sql").read_text()
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    contract = json.loads((ROOT / "db/contracts/uat_integrated_schema.json").read_text())

    expected_columns = {
        "onboarding_journey_version",
        "onboarding_phase",
        "onboarding_active_capability",
        "onboarding_resume_route",
        "onboarding_callback_state",
        "onboarding_journey_updated_at",
    }

    assert "092_one_onboarding_journey_v1.sql" in manifest["ordered_migrations"]
    assert contract["expected_migration_version"] >= 92
    assert expected_columns <= set(contract["required_tables"]["vault_keys"])
    assert "vault_keys_onboarding_phase_check" in migration
    assert "raw voice turns" in migration.lower()
    assert "oauth tokens never" in migration.lower()


def test_onboarding_callback_attempt_migration_is_registered_and_redacted() -> None:
    migration = (ROOT / "db/migrations/094_one_onboarding_callback_attempt_v1.sql").read_text()
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    contract = json.loads((ROOT / "db/contracts/uat_integrated_schema.json").read_text())

    assert manifest["ordered_migrations"][-1] == "094_one_onboarding_callback_attempt_v1.sql"
    assert "094_one_onboarding_callback_attempt_v1.sql" in manifest["groups"]["iam"]
    assert contract["expected_migration_version"] == 94
    assert "onboarding_callback_attempt_id" in contract["required_tables"]["vault_keys"]
    assert "oauth codes" in migration.lower()
    assert "provider tokens" in migration.lower()
