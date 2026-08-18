"""Migration 158 raises the per-Circle member ceiling from 20 to 100.

The number lived in two places in 134 -- the column default and an inline
`CHECK (member_limit BETWEEN 2 AND 20)` -- and a third, implicit one: the
value already frozen onto every Circle row. Raising only the first two would
ship "Circles hold 100" to accounts whose existing Circles all still stop at
20, so the backfill is part of the contract, not an optimisation.

These assertions are deliberately about SHAPE rather than a live database:
the release-migration gate reads these same files, and a migration that
silently stops widening the bound, stops raising the default, or starts
rewriting Circles whose ceiling was set deliberately is exactly the drift
worth failing on.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = REPO_ROOT / "db" / "contracts"
SERVICE_PATH = REPO_ROOT / "hushh_mcp" / "services" / "one_location_circle_service.py"

MIGRATION = "158_one_location_circle_member_limit_100.sql"
ROLLBACK = "158_one_location_circle_member_limit_100.rollback.sql"


def _migration() -> str:
    return (MIGRATIONS_DIR / MIGRATION).read_text(encoding="utf-8")


def _rollback() -> str:
    return (MIGRATIONS_DIR / "rollback" / ROLLBACK).read_text(encoding="utf-8")


def _statements(sql: str) -> str:
    """The executable half of a migration, with `--` commentary stripped.

    These files explain themselves at length, and the commentary necessarily
    quotes the old shape it is replacing. Asserting "the old bound is gone"
    against the raw text would therefore fail on the sentence describing why
    it went.
    """
    lines = [
        line.split("--", 1)[0] for line in sql.splitlines() if not line.lstrip().startswith("--")
    ]
    return chr(10).join(lines)


def test_member_limit_migration_is_registered_in_release_order() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert (MIGRATIONS_DIR / MIGRATION).exists()
    assert (MIGRATIONS_DIR / "rollback" / ROLLBACK).exists()
    # Present and in order, not necessarily last -- 159 supersedes it as the
    # migration head once the invite-code ceiling catches up to this one.
    assert MIGRATION in manifest["ordered_migrations"]
    # Structural One Location migrations belong to the iam group, as 155 does.
    assert MIGRATION in manifest["groups"]["iam"]


def test_schema_contracts_advance_to_the_new_migration_head() -> None:
    for name in (
        "prod_core_schema.json",
        "uat_integrated_schema.json",
        "dev_minimum_schema.json",
    ):
        contract = json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 158, name

    # No new table or column, so the required-table shape must be untouched:
    # this migration only moves a bound, a default and the rows carrying it.
    prod = json.loads((CONTRACTS_DIR / "prod_core_schema.json").read_text(encoding="utf-8"))
    assert "member_limit" in prod["required_tables"]["one_location_circles"]


def test_migration_widens_the_bound_and_the_default_together() -> None:
    migration = _migration()

    # Both halves of 134's cap, or the ceiling only appears to move.
    assert "DROP CONSTRAINT IF EXISTS one_location_circles_member_limit_check" in migration
    assert "one_location_circles_member_limit_bounds" in migration
    assert "CHECK (member_limit BETWEEN 2 AND 100)" in migration
    assert "ALTER COLUMN member_limit SET DEFAULT 100" in migration
    assert "BETWEEN 2 AND 20" not in _statements(migration)


def test_migration_lifts_only_circles_still_on_the_old_default() -> None:
    migration = _migration()

    assert "SET member_limit = 100" in migration
    # A hand-set ceiling is the one case where the stored number carries
    # intent; a blanket UPDATE would erase it.
    assert "WHERE member_limit = 20" in migration
    statements = _statements(migration)
    assert "WHERE member_limit <" not in statements
    assert "WHERE TRUE" not in statements


def test_migration_grants_no_access_of_its_own() -> None:
    migration = _migration()

    # Raising a ceiling must not add a member, a connection, a grant or an SMS
    # selection. Membership is still something a person does.
    assert "INSERT INTO one_location_circle_memberships" not in migration
    assert "INSERT INTO connections" not in migration
    assert "INSERT INTO trusted_connections" not in migration
    assert "INSERT INTO one_location_share_grants" not in migration
    assert "INSERT INTO one_location_sms_contacts" not in migration


def test_rollback_restores_the_ceiling_without_stranding_grown_circles() -> None:
    rollback = _rollback()

    assert "ALTER COLUMN member_limit SET DEFAULT 20" in rollback
    # NOT VALID is the load-bearing word: it still governs every future INSERT
    # and UPDATE while declining to re-scan the Circles that legitimately grew
    # past 20 while the higher ceiling was live.
    assert "CHECK (member_limit BETWEEN 2 AND 20) NOT VALID" in rollback
    # Only Circles that can actually live inside the restored ceiling are
    # lowered; the rest keep theirs rather than becoming rows that violate
    # their own invariant.
    assert "FROM one_location_circle_memberships m" in rollback
    assert "<= 20" in rollback
    assert "DELETE FROM one_location_circle_memberships" not in rollback


def test_service_default_matches_the_migrated_ceiling() -> None:
    service = SERVICE_PATH.read_text(encoding="utf-8")

    # The constant is stamped onto a Circle at INSERT, so a service still
    # saying 20 would keep writing the old ceiling onto every new Circle no
    # matter what the column default says.
    assert "CIRCLE_DEFAULT_MEMBER_LIMIT = 100" in service
    assert "CIRCLE_DEFAULT_MEMBER_LIMIT = 20" not in service
