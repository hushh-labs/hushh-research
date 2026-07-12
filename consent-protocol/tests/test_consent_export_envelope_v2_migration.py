from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_export_envelope_v2_migration_and_checked_contract_move_together() -> None:
    sql = (ROOT / "db" / "migrations" / "088_consent_export_envelope_v2.sql").read_text()
    contract = json.loads((ROOT / "db" / "contracts" / "uat_integrated_schema.json").read_text())
    manifest = json.loads((ROOT / "db" / "release_migration_manifest.json").read_text())
    export_columns = set(contract["required_tables"]["consent_exports"])
    job_columns = set(contract["required_tables"]["consent_export_refresh_jobs"])

    assert {
        "export_id",
        "envelope_version",
        "envelope_aad",
        "ciphertext_sha256",
        "refresh_policy",
    } <= export_columns
    assert {"claim_id", "claim_expires_at", "expected_export_revision"} <= job_columns
    assert "claim_consent_export_refresh_jobs_v2" in contract["required_functions"]
    assert "complete_consent_export_refresh_v2" in contract["required_functions"]
    assert "FOR UPDATE OF jobs SKIP LOCKED" in sql
    assert "export_revision = p_expected_export_revision" in sql
    assert "088_consent_export_envelope_v2.sql" in manifest["ordered_migrations"]
    assert contract["expected_migration_version"] >= 88
