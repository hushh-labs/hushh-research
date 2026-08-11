import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "consent-protocol" / "db" / "migrations"
MANIFEST = ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
UAT_CONTRACT = ROOT / "consent-protocol" / "db" / "contracts" / "uat_integrated_schema.json"
PROD_CONTRACT = ROOT / "consent-protocol" / "db" / "contracts" / "prod_core_schema.json"


def test_nearby_presence_migration_encrypts_anchor_and_clears_terminal_rows():
    name = "126_one_location_nearby_presence.sql"
    sql = (MIGRATIONS / name).read_text(encoding="utf-8")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    uat = json.loads(UAT_CONTRACT.read_text(encoding="utf-8"))
    prod = json.loads(PROD_CONTRACT.read_text(encoding="utf-8"))

    assert name in manifest["ordered_migrations"]
    assert name in manifest["groups"]["iam"]
    assert "CREATE TABLE IF NOT EXISTS one_location_nearby_presences" in sql
    assert "participant_alias UUID" in sql
    assert "allow_connection_requests BOOLEAN NOT NULL DEFAULT FALSE" in sql
    assert "anchor_ciphertext TEXT" in sql
    assert "anchor_cell_token TEXT" in sql
    assert "radius_meters SMALLINT NOT NULL DEFAULT 500" in sql
    assert "latitude DOUBLE" not in sql.upper()
    assert "longitude DOUBLE" not in sql.upper()
    assert "place_id TEXT" not in sql.lower()
    assert "event_code" not in sql.lower()
    assert "one_location_nearby_presences" in uat["required_tables"]
    assert "one_location_nearby_presences" in prod["required_tables"]
    assert uat["expected_migration_version"] >= 126
    assert prod["expected_migration_version"] >= 126


def test_nearby_presence_rollback_is_explicitly_unshipped_only():
    rollback = (MIGRATIONS / "rollback" / "126_one_location_nearby_presence_down.sql").read_text(
        encoding="utf-8"
    )

    assert "unshipped environments only" in rollback
    assert "DROP TABLE IF EXISTS one_location_nearby_presences" in rollback
