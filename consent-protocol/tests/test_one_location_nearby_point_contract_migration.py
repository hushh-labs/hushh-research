import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "consent-protocol" / "db" / "migrations"
MANIFEST = ROOT / "consent-protocol" / "db" / "release_migration_manifest.json"
CONTRACTS = ROOT / "consent-protocol" / "db" / "contracts"


def test_point_contract_migration_is_registered_and_updates_current_comments():
    name = "131_one_location_nearby_point_contract.sql"
    sql = (MIGRATIONS / name).read_text(encoding="utf-8")
    rollback = (MIGRATIONS / "rollback" / f"{name[:-4]}_down.sql").read_text(encoding="utf-8")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    # Membership, not last-position: the intent is that this migration is
    # registered for release, and asserting it is *last* makes every subsequent
    # migration fail this unrelated test.
    assert name in manifest["ordered_migrations"]
    assert name in manifest["groups"]["iam"]
    assert "final captured check-in point" in sql
    assert "decrypted captured check-in points" in sql
    assert "selected public-place anchors" in rollback


def test_current_schema_contracts_require_point_contract_migration():
    for name in (
        "dev_minimum_schema.json",
        "uat_integrated_schema.json",
        "prod_core_schema.json",
    ):
        contract = json.loads((CONTRACTS / name).read_text(encoding="utf-8"))
        # Floor, not equality: every later migration bumps this number, so an
        # exact assertion turns an unrelated migration into a false failure.
        assert contract["expected_migration_version"] >= 131
