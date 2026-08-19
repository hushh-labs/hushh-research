"""Migration 159 raises the invite-code use ceiling to match 100-member Circles.

158 raised `one_location_circles.member_limit` to 100 but left
`one_location_circle_invite_codes.max_uses` bound to 134's old
CHECK (max_uses BETWEEN 1 AND 20). `create_code` computes
`max_uses = member_limit - 1`, so every code created for a Circle at the new
100 default violated that stale CHECK -- an IntegrityError that
`_safe_db_failure` turned into "Circle service is temporarily unavailable" on
every invite-code creation. This migration is the other half of 158.

These assertions are deliberately about SHAPE rather than a live database: the
release-migration gate reads these same files, and a migration that silently
stops widening the bound, stops raising the default, or reintroduces the old
20-use ceiling is exactly the drift worth failing on.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = REPO_ROOT / "db" / "contracts"
SERVICE_PATH = REPO_ROOT / "hushh_mcp" / "services" / "one_location_circle_service.py"

MIGRATION = "159_one_location_circle_invite_max_uses_100.sql"
ROLLBACK = "159_one_location_circle_invite_max_uses_100.rollback.sql"


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


def test_max_uses_migration_is_registered_in_release_order() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert (MIGRATIONS_DIR / MIGRATION).exists()
    assert (MIGRATIONS_DIR / "rollback" / ROLLBACK).exists()
    # Registered and ordered, NOT "is the last entry". Being the release head
    # is a fact with a shelf life of exactly one migration -- 160 displaced this
    # the day it landed, exactly as this migration displaced 158's identical
    # assertion. Both of those were corrected the same way.
    ordered = manifest["ordered_migrations"]
    assert MIGRATION in ordered
    assert ordered.index("158_one_location_circle_member_limit_100.sql") < ordered.index(MIGRATION)
    # Structural One Location migrations belong to the iam group, as 158 does.
    assert MIGRATION in manifest["groups"]["iam"]


def test_schema_contracts_advance_to_the_new_migration_head() -> None:
    for name in (
        "prod_core_schema.json",
        "uat_integrated_schema.json",
        "dev_minimum_schema.json",
    ):
        contract = json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 159, name


def test_migration_widens_the_bound_and_the_default_together() -> None:
    migration = _migration()

    assert "DROP CONSTRAINT IF EXISTS one_location_circle_invite_codes_max_uses_check" in migration
    assert "one_location_circle_invite_codes_max_uses_bounds" in migration
    assert "CHECK (max_uses BETWEEN 1 AND 100)" in migration
    assert "ALTER COLUMN max_uses SET DEFAULT 100" in migration
    assert "BETWEEN 1 AND 20" not in _statements(migration)


def test_migration_is_replay_safe_against_itself() -> None:
    """UAT and prod both run the full migration set in `replay` mode on every
    deploy, so a migration must survive running twice against a database
    where it already applied cleanly once.

    158 shipped without that property and took down the very next UAT
    deploy: `DuplicateObjectError: constraint
    "one_location_circles_member_limit_bounds" ... already exists`, because
    its DO block deliberately leaves a constraint already carrying the final
    name untouched, and nothing dropped it before the ADD tried to recreate
    it. This migration was written by copying that same shape, so it carried
    the identical bug into a second file before ever running once. The fix
    is the drop-then-add-by-the-same-name idiom the rest of this migration
    set already follows (see 134, 155): a DROP CONSTRAINT IF EXISTS for the
    bounds constraint, immediately before the ADD that recreates it.
    """
    migration = _migration()

    drop = "DROP CONSTRAINT IF EXISTS one_location_circle_invite_codes_max_uses_bounds"
    add = "ADD CONSTRAINT one_location_circle_invite_codes_max_uses_bounds"
    assert drop in migration
    assert migration.index(drop) < migration.index(add)


def test_migration_never_touches_use_count_or_membership_rows() -> None:
    migration = _migration()
    statements = _statements(migration)

    # This is a bound-and-default fix, not a data rewrite -- no existing code's
    # use_count, no membership, no grant.
    assert "UPDATE one_location_circle_invite_codes" not in statements
    assert "INSERT INTO one_location_circle_memberships" not in migration
    assert "INSERT INTO one_location_share_grants" not in migration


def test_rollback_restores_the_ceiling_without_truncating_live_codes() -> None:
    rollback = _rollback()

    assert "ALTER COLUMN max_uses SET DEFAULT 20" in rollback
    # NOT VALID is the load-bearing word: codes already issued above 20 uses
    # (from Circles at the 100-member default) are left alone rather than
    # silently shrinking how many people they can still admit.
    assert "CHECK (max_uses BETWEEN 1 AND 20) NOT VALID" in rollback
    assert "UPDATE one_location_circle_invite_codes" not in rollback


def test_service_computes_max_uses_from_the_same_ceiling_migration_159_covers() -> None:
    service = SERVICE_PATH.read_text(encoding="utf-8")

    # The line this migration exists to unblock: max_uses derived from
    # member_limit, which can now legitimately reach 99.
    assert "member_limit" in service
    assert "CIRCLE_DEFAULT_MEMBER_LIMIT = 100" in service
