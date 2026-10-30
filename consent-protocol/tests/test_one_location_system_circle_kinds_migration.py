"""Migration 163 makes room for a second product-managed Circle.

160 marked the Circles the product provisions with one boolean and allowed one
per owner. Trusted (#5458) is a second, so the boolean alone cannot express it.

The interesting decisions here are what 163 does NOT do. It does not re-key
160's index, and it does not make Trusted `is_system`. Both fall out of the
same two facts, and the assertions below exist to stop either being
"simplified" back:

  * `_find_system_circle_id` is `WHERE is_system AND status='active' LIMIT 1`
    with no ORDER BY. An older image running against a database that already
    holds Trusted rows could pick the Trusted Circle, and
    `ensure_sms_system_circle` would then rename it, drop its member_limit to
    10, and hand SOS its roster -- an emergency alert, with an address, to
    everyone the owner is connected to.
  * Every environment deploys with `--migration-mode replay`, and
    `CREATE UNIQUE INDEX IF NOT EXISTS <name>` matches on NAME ONLY. Recreating
    an index under an existing name with a different predicate is a silent
    no-op that reports success.

Shape assertions, like 160's, because the release-migration gate reads these
same files. The runtime behaviour was exercised against Postgres while writing
the migration.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = REPO_ROOT / "db" / "contracts"

MIGRATION = "163_one_location_system_circle_kinds.sql"
ROLLBACK = "163_one_location_system_circle_kinds.rollback.sql"
PRIOR = "160_one_location_system_circles.sql"
CO_MEMBER_BACKFILL = "135_one_location_circle_connection_origins.sql"


def _migration() -> str:
    return (MIGRATIONS_DIR / MIGRATION).read_text(encoding="utf-8")


def _rollback() -> str:
    return (MIGRATIONS_DIR / "rollback" / ROLLBACK).read_text(encoding="utf-8")


def _manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _statements(sql: str) -> str:
    """The executable half, with `--` commentary stripped.

    These files explain themselves at length and the commentary names the
    things they deliberately do not touch, so asserting absence against the raw
    text fails on the sentence explaining the absence.
    """
    lines = [
        line.split("--", 1)[0] for line in sql.splitlines() if not line.lstrip().startswith("--")
    ]
    return chr(10).join(lines)


def _version(name: str) -> int:
    return int(name.split("_", 1)[0])


def test_kind_migration_is_registered_in_release_order() -> None:
    manifest = _manifest()
    ordered = manifest["ordered_migrations"]
    assert MIGRATION in ordered
    assert ordered.index(PRIOR) < ordered.index(MIGRATION)
    assert MIGRATION in manifest["groups"]["iam"]
    assert (MIGRATIONS_DIR / "rollback" / ROLLBACK).exists()


def test_base_and_uat_overlay_ids_are_unique_and_individually_monotonic() -> None:
    # UAT-only migrations retain their applied IDs. The release runner merges
    # them numerically with newer shared migrations at execution time.
    manifest = _manifest()
    ordered = [_version(name) for name in manifest["ordered_migrations"]]
    overlay = [_version(name) for name in manifest["environment_overlays"]["uat"]]

    assert ordered == sorted(ordered)
    assert overlay == sorted(overlay)
    assert len(ordered + overlay) == len(set(ordered + overlay))


def test_all_three_schema_contracts_move_together() -> None:
    # 160's test checked two. The gate version-pins all three, and a missed bump
    # fails Governance on a file the author did not knowingly touch.
    for name in ("prod_core_schema.json", "uat_integrated_schema.json"):
        contract = json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] >= 163
        assert "system_kind" in contract["required_tables"]["one_location_circles"]

    dev = json.loads((CONTRACTS_DIR / "dev_minimum_schema.json").read_text(encoding="utf-8"))
    assert dev["expected_migration_version"] >= 163


def test_the_old_single_slot_index_is_left_alone() -> None:
    # Re-keying it would mean recreating under a name Postgres already knows,
    # and `IF NOT EXISTS` matches on name alone -- a replay keeps the old
    # definition and reports success. The new index carries a new name and the
    # old one is never touched.
    statements = _statements(_migration())
    assert "DROP INDEX" not in statements
    assert "uq_one_location_circles_owner_system_kind" in statements
    assert "(owner_user_id, system_kind)" in statements


def test_the_migration_never_writes_is_system() -> None:
    # The reason the second kind is a column rather than the boolean. A Trusted
    # row wearing is_system could be picked by pre-163 code's ORDER BY-less
    # lookup and renamed into the SMS Circle.
    statements = _statements(_migration())
    assert "SET is_system" not in statements
    assert "INSERT INTO one_location_circles" not in statements


def test_the_backfill_cannot_overwrite_a_kind_on_a_replay() -> None:
    statements = _statements(_migration())
    assert "SET system_kind = 'sms'" in statements
    assert "system_kind IS NULL" in statements


def test_the_delete_guard_now_covers_both_kinds() -> None:
    statements = _statements(_migration())
    # Both the hard DELETE and the soft `active -> deleted` transition.
    assert statements.count("OLD.system_kind IS NOT NULL") >= 2
    assert "restrict_violation" in statements
    # 160's trigger is replaced in place, never dropped and left off.
    assert "DROP TRIGGER" not in statements


def test_the_migration_never_touches_the_member_ceiling() -> None:
    """The one thing this file must NOT do, and the reason is replay order.

    A Trusted Circle mirrors the connection graph and connections are not
    capped, so 158's 2..100 reads like the wrong bound for it, and an earlier
    draft of this migration widened the CHECK to allow SMALLINT's ceiling for
    `system_kind = 'trusted'`.

    Every environment deploys with `--migration-mode replay`, which runs every
    file in the manifest on every deploy in manifest order -- and 158 sits at
    index 135, ahead of this file at 139. 158 ends with a plain DROP/ADD of
    `CHECK (member_limit BETWEEN 2 AND 100)` with no NOT VALID, so the ADD
    validates the whole table. Widening the bound here does not stop 158
    re-narrowing it on the NEXT deploy, by which time Trusted Circles exist:
    158 raises 23514 and every later release fails at the migration step.

    Reproduced on Postgres 16. So a Trusted Circle stores the ordinary default
    instead, and this asserts the widening does not come back.
    """

    statements = _statements(_migration())
    assert "one_location_circles_member_limit_bounds" not in statements
    assert "member_limit BETWEEN" not in statements
    assert "32767" not in statements


def test_the_trusted_circle_stores_a_limit_158_would_still_accept() -> None:
    """The other half of the same rule, on the writing side.

    The migration staying away from the constraint is only safe while nothing
    writes a row that constraint would reject.
    """

    from hushh_mcp.services.one_location_circle_service import (
        CIRCLE_DEFAULT_MEMBER_LIMIT,
        TRUSTED_SYSTEM_CIRCLE_MEMBER_LIMIT,
    )

    assert TRUSTED_SYSTEM_CIRCLE_MEMBER_LIMIT == CIRCLE_DEFAULT_MEMBER_LIMIT
    assert 2 <= TRUSTED_SYSTEM_CIRCLE_MEMBER_LIMIT <= 100


def test_the_co_member_backfill_leaves_a_trusted_circle_alone() -> None:
    """Migration 135 meshes every pair of people who share a Circle.

    That reading -- being put in a Circle together IS the introduction -- holds
    for a Circle somebody curated. A Trusted Circle is a projection of the
    connection graph, so meshing it makes every pair of YOUR connections
    connected to each other having never met: 19,900 rows for an account with
    200 connections, re-asserted on every deploy because replay runs 135 every
    time.

    And these are `connections` rows, so they satisfy the CONNECTION arm of
    location eligibility -- which the Circle-side narrowing deliberately does
    not touch. Reproduced against Postgres 16 before the filter was added.

    Read through `to_jsonb` because 135 runs before this migration adds the
    column on a fresh database, where a missing key yields NULL, and NULL is
    the right answer there because no Trusted Circle can exist yet.
    """

    backfill = _statements((MIGRATIONS_DIR / CO_MEMBER_BACKFILL).read_text(encoding="utf-8"))

    # Both halves: the `connections` rows and the `named_circle` origins.
    assert backfill.count("to_jsonb(circle) ->> 'system_kind' IS DISTINCT FROM 'trusted'") == 2
    # Never as a bare column reference, which does not parse on a fresh database.
    assert "circle.system_kind" not in backfill


def test_migration_provisions_nothing_and_grants_nothing() -> None:
    statements = _statements(_migration())
    assert "INSERT INTO one_location_circle_memberships" not in statements
    assert "one_location_sms_contacts" not in statements
    assert "one_location_share_grants" not in statements
    assert "trusted_connections" not in statements
    assert "GRANT " not in statements
    assert "CREATE POLICY" not in statements
    assert "SECURITY DEFINER" not in statements


def test_rollback_restores_the_guard_before_it_drops_the_column() -> None:
    # The trigger body references system_kind. Dropping the column first leaves
    # a function that raises on the next write to the table.
    rollback = _statements(_rollback())
    assert rollback.index("CREATE OR REPLACE FUNCTION") < rollback.index(
        "DROP COLUMN IF EXISTS system_kind"
    )


def test_rollback_leaves_the_member_ceiling_alone_too() -> None:
    # It has nothing to undo: the forward migration does not touch the bound,
    # so no row it drops can be outside 2..100 and there is nothing to clamp.
    rollback = _statements(_rollback())
    assert "one_location_circles_member_limit_bounds" not in rollback
    assert "SET member_limit" not in rollback


def test_rollback_keeps_every_circle_and_every_membership() -> None:
    rollback = _statements(_rollback())
    assert "DELETE FROM one_location_circles" not in rollback
    assert "DELETE FROM one_location_circle_memberships" not in rollback
    assert "DROP TABLE" not in rollback
