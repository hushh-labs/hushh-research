import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_public_person_reference_is_random_stable_and_unique() -> None:
    sql = (ROOT / "db/migrations/182_public_person_profiles.sql").read_text()
    assert "public_person_ref UUID" in sql
    assert "gen_random_uuid()" in sql
    assert "SET NOT NULL" in sql
    assert "CREATE UNIQUE INDEX" in sql
    assert "prevent_public_person_ref_change" in sql
    assert "BEFORE UPDATE OF public_person_ref" in sql
    update = sql.split("UPDATE actor_profiles", 1)[1].split("ALTER TABLE", 1)[0]
    assert "gen_random_uuid()" in update
    assert "user_id" not in update


def test_information_request_tables_are_correlation_not_value_storage() -> None:
    sql = (ROOT / "db/migrations/183_one_information_request_bundles.sql").read_text()
    assert "consent lifecycle authority" in sql.lower()
    assert "idempotency_hash" in sql
    assert "request_fingerprint" in sql
    assert "scope_ref" in sql
    assert "plaintext" not in sql.lower()
    assert "encrypted_value" not in sql.lower()


def test_adk_session_payload_has_no_plaintext_columns() -> None:
    sql = (ROOT / "db/migrations/184_encrypted_one_adk_sessions.sql").read_text().lower()
    assert "payload_ciphertext" in sql
    assert "payload_iv" in sql
    assert "payload_tag" in sql
    assert "message_text" not in sql
    assert "state_json" not in sql


def test_person_profile_and_adk_session_migrations_are_release_authority() -> None:
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    ordered = manifest["ordered_migrations"]
    expected = [
        "182_public_person_profiles.sql",
        "183_one_information_request_bundles.sql",
        "184_encrypted_one_adk_sessions.sql",
        "185_internal_access_request_id_text.sql",
    ]
    assert all(name in ordered for name in expected)
    assert [ordered.index(name) for name in expected] == sorted(
        ordered.index(name) for name in expected
    )
    assert set(expected).issubset(set(manifest["groups"]["iam"]))

    for contract_name in (
        "uat_integrated_schema.json",
        "prod_core_schema.json",
        "dev_minimum_schema.json",
    ):
        contract = json.loads((ROOT / "db/contracts" / contract_name).read_text())
        assert contract["expected_migration_version"] >= 185
        assert "one_adk_sessions" in contract["required_tables"]
        assert "public_person_ref" in contract["required_tables"]["actor_profiles"]


def test_information_request_receipt_ids_are_not_legacy_length_bounded() -> None:
    sql = (ROOT / "db/migrations/185_internal_access_request_id_text.sql").read_text().lower()
    assert "alter table internal_access_events" in sql
    assert "alter column request_id type text" in sql
