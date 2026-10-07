"""Release contract for migration 275 -- referral gamification settings v2.

v1 (migration 270) shipped with placeholder milestones and an unset weekly
schedule by design. This pins that v2 actually supplies the real values --
the exact four-reward milestone ladder and the Sunday 23:59 Asia/Kolkata
weekly cutoff -- rather than drifting from what the product surface
advertises, and that the versioning discipline (retire the old row, never
mutate it, never delete it) is followed structurally.

Structural assertions run against the DDL with SQL comments stripped, same
as migration 165's and 270's own tests: no live database in this suite, so
these are static-evidence checks that the guard's branches, exception
messages and invariant assertion exist with the right shape -- not a live
replay against a running Postgres. A live replay (apply, re-apply, apply
against a deliberately mismatched version 2, roll back, re-roll-back) is a
real gap this suite cannot close without a database fixture; see the
migration's own header for the guarantees that replay would exercise.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"
MANIFEST_PATH = ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = ROOT / "db" / "contracts"

MIGRATION = "275_one_referral_program_settings_v2.sql"
ROLLBACK = "275_one_referral_program_settings_v2.rollback.sql"
PRIOR = "274_one_referral_weekly_awards.sql"

EXPECTED_MILESTONES = (
    ("voucher_10", 10, "₹250 Amazon voucher"),
    ("earbuds_100", 100, "Wireless earbuds, worth ₹10,000"),
    ("airpods_500", 500, "Apple AirPods, worth ₹30,000"),
    ("iphone_10000", 10000, "iPhone"),
)


def _migration() -> str:
    return (MIGRATIONS_DIR / MIGRATION).read_text(encoding="utf-8")


def _rollback() -> str:
    return (MIGRATIONS_DIR / "rollback" / ROLLBACK).read_text(encoding="utf-8")


def _manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _statements(sql: str) -> str:
    lines = [
        line.split("--", 1)[0] for line in sql.splitlines() if not line.lstrip().startswith("--")
    ]
    return chr(10).join(lines)


def _version(name: str) -> int:
    return int(name.split("_", 1)[0])


def _milestones_json(statements: str) -> list[dict]:
    match = re.search(r"'(\[\s*\{.*?\}\s*\])'::JSONB", statements, re.DOTALL)
    assert match, "could not find the milestones JSONB literal"
    return json.loads(match.group(1))


def _weekly_schedule_json(statements: str) -> dict:
    match = re.search(r"'(\{\"timezone\".*?\})'::JSONB", statements)
    assert match, "could not find the weekly_schedule JSONB literal"
    return json.loads(match.group(1))


# --------------------------------------------------------------------------
# Release plumbing
# --------------------------------------------------------------------------


def test_migration_is_registered_in_release_order() -> None:
    manifest = _manifest()
    ordered = manifest["ordered_migrations"]
    assert MIGRATION in ordered
    assert ordered.index(PRIOR) < ordered.index(MIGRATION)
    assert (MIGRATIONS_DIR / "rollback" / ROLLBACK).exists()


def test_rollback_is_registered() -> None:
    manifest = _manifest()
    assert manifest["rollback_migrations"][MIGRATION] == f"rollback/{ROLLBACK}"


def test_schema_contracts_track_the_new_head() -> None:
    prod = json.loads((CONTRACTS_DIR / "prod_core_schema.json").read_text(encoding="utf-8"))
    dev = json.loads((CONTRACTS_DIR / "dev_minimum_schema.json").read_text(encoding="utf-8"))
    uat = json.loads((CONTRACTS_DIR / "uat_integrated_schema.json").read_text(encoding="utf-8"))
    manifest = _manifest()
    production_head = max(_version(n) for n in manifest["ordered_migrations"])
    uat_head = max(
        _version(n)
        for n in manifest["ordered_migrations"] + manifest["environment_overlays"]["uat"]
    )
    assert prod["expected_migration_version"] == production_head
    assert dev["expected_migration_version"] == production_head
    assert uat["expected_migration_version"] == uat_head


# --------------------------------------------------------------------------
# The configuration itself
# --------------------------------------------------------------------------


def test_v1_is_retired_before_v2_is_activated() -> None:
    statements = _statements(_migration())
    retire_index = statements.index("UPDATE one_referral_program_settings")
    insert_index = statements.index("INSERT INTO one_referral_program_settings")
    assert retire_index < insert_index
    assert "SET retired_at = NOW()" in statements
    assert "WHERE version = 1" in statements


def test_milestone_ladder_matches_the_published_rewards() -> None:
    statements = _statements(_migration())
    milestones = _milestones_json(statements)
    actual = tuple(
        (entry["milestone_key"], entry["threshold"], entry["reward"]) for entry in milestones
    )
    assert actual == EXPECTED_MILESTONES


def test_milestones_are_strictly_increasing_thresholds() -> None:
    thresholds = [threshold for _key, threshold, _reward in EXPECTED_MILESTONES]
    assert thresholds == sorted(thresholds)
    assert len(thresholds) == len(set(thresholds))


def test_weekly_cutoff_is_sunday_2359_kolkata() -> None:
    statements = _statements(_migration())
    schedule = _weekly_schedule_json(statements)
    assert schedule["timezone"] == "Asia/Kolkata"
    assert schedule["cutoff_day_of_week"] == 7  # ISO 8601: 7 = Sunday
    assert schedule["cutoff_time"] == "23:59:00"


def test_points_and_streak_rules_are_unchanged_from_v1() -> None:
    v1_statements = _statements(
        (MIGRATIONS_DIR / "270_one_referral_gamification_settings.sql").read_text(encoding="utf-8")
    )
    v2_statements = _statements(_migration())
    v1_points = re.search(r"'(\{\"qualified_referral_points\".*?\})'::JSONB", v1_statements)
    v2_points = re.search(r"'(\{\"qualified_referral_points\".*?\})'::JSONB", v2_statements)
    assert v1_points and v2_points
    assert json.loads(v1_points.group(1)) == json.loads(v2_points.group(1))


def test_feature_active_stays_off() -> None:
    statements = _statements(_migration())
    insert_clause = statements[statements.index("INSERT INTO one_referral_program_settings") :]
    assert "FALSE, NOW()" in insert_clause


# --------------------------------------------------------------------------
# Guard: serialization, idempotency-on-exact-match, refuse-on-mismatch,
# single-active-version invariant. Static evidence only -- see module
# docstring; a live-database replay is the real proof these branches take.
# --------------------------------------------------------------------------


def test_migration_locks_both_candidate_rows_before_reading_either() -> None:
    statements = _statements(_migration())
    lock_index = statements.index("FOR UPDATE")
    read_v2_index = statements.index("SELECT * INTO v2_row")
    assert lock_index < read_v2_index, (
        "the row lock must happen before version 2 is read, or two concurrent "
        "replays can both read a pre-transition snapshot and race to write"
    )
    assert "version IN (1, 2)" in statements


def test_migration_checks_every_configuration_field_for_an_existing_v2() -> None:
    statements = _statements(_migration())
    mismatch_guard = statements[
        statements.index("IF v2_row.qualification_policy_version") : statements.index(
            "RAISE EXCEPTION 'migration 275: version 2 exists and is active, but"
        )
    ]
    for column in (
        "qualification_policy_version",
        "points",
        "milestones",
        "streak_rules",
        "flash_windows",
        "weekly_schedule",
        "prize_catalogue",
        "tie_break_rules",
        "fulfillment_config",
        "feature_active",
    ):
        assert f"v2_row.{column} IS DISTINCT FROM" in mismatch_guard, (
            f"an existing version 2 must be compared on {column} before this "
            "migration treats it as a matching, idempotent no-op"
        )


def test_migration_mismatch_guard_covers_the_previously_omitted_fields() -> None:
    # Regression: an earlier revision of this guard compared 7 of the 10
    # columns this migration actually writes, silently skipping
    # flash_windows, tie_break_rules and fulfillment_config -- a version 2
    # row that diverged only on one of those three would have been accepted
    # as a matching idempotent no-op. Each must appear compared against its
    # own expected-value variable, not merely present anywhere in the guard.
    statements = _statements(_migration())
    mismatch_guard = statements[
        statements.index("IF v2_row.qualification_policy_version") : statements.index(
            "RAISE EXCEPTION 'migration 275: version 2 exists and is active, but"
        )
    ]
    assert "v2_row.flash_windows IS DISTINCT FROM expected_flash_windows" in mismatch_guard
    assert "v2_row.tie_break_rules IS DISTINCT FROM expected_tie_break_rules" in mismatch_guard
    assert (
        "v2_row.fulfillment_config IS DISTINCT FROM expected_fulfillment_config" in mismatch_guard
    )


def test_migration_rejects_a_retired_or_unactivated_existing_v2() -> None:
    statements = _statements(_migration())
    assert "v2_row.activated_at IS NULL OR v2_row.retired_at IS NOT NULL" in statements
    assert "version 2 exists but is not the active settings version" in statements


def test_migration_never_retires_v1_when_v2_already_exists() -> None:
    statements = _statements(_migration())
    found_index = statements.index("IF FOUND THEN")
    else_index = statements.index("ELSE", found_index)
    retire_v1_index = statements.index(
        "UPDATE one_referral_program_settings\n       SET retired_at = NOW()\n     WHERE version = 1"
    )
    assert else_index < retire_v1_index, (
        "the only UPDATE ... SET retired_at = NOW() WHERE version = 1 must sit "
        "inside the ELSE branch (version 2 does not exist yet) -- never "
        "reachable while a version 2 row (matching or not) already exists"
    )


def test_migration_validates_v1_is_the_expected_starting_point() -> None:
    statements = _statements(_migration())
    else_index = statements.index("ELSE")
    tail = statements[else_index:]
    assert "v1_row.activated_at IS NULL OR v1_row.retired_at IS NOT NULL" in tail
    assert "version 1 is not the current active settings version" in tail
    assert "version 1 does not exist" in tail


def test_migration_asserts_exactly_one_active_version_before_commit() -> None:
    statements = _statements(_migration())
    assert "activated_at IS NOT NULL AND retired_at IS NULL" in statements
    assert "active_count <> 1" in statements
    assert "invariant violated" in statements
    # The assertion must be the last meaningful check before COMMIT.
    invariant_index = statements.index("invariant violated")
    commit_index = statements.rindex("COMMIT")
    assert invariant_index < commit_index


def test_migration_is_idempotent_only_when_v2_exactly_matches() -> None:
    statements = _statements(_migration())
    assert "idempotent no-op" in statements
    notice_index = statements.index("idempotent no-op")
    mismatch_check_index = statements.index("IS DISTINCT FROM")
    assert mismatch_check_index < notice_index, (
        "the idempotent-success path must be reachable only after every "
        "field has been compared, not merely because a row with version=2 "
        "exists"
    )


# --------------------------------------------------------------------------
# Rollback: version-preserving (never DELETE), same guard discipline,
# restoring settings is explicitly distinguished from reversing rewards.
# --------------------------------------------------------------------------


def test_rollback_never_deletes_version_2() -> None:
    statements = _statements(_rollback())
    assert "DELETE" not in statements.upper(), (
        "the rollback must preserve version 2's row -- a settings version is "
        "retired, never removed, so score_events/entitlements provenance and "
        "the historical record both survive a rollback"
    )


def test_rollback_reactivates_v1_and_retires_v2_in_place() -> None:
    statements = _statements(_rollback())
    assert (
        "UPDATE one_referral_program_settings SET retired_at = NOW() WHERE version = 2"
        in statements
    )
    assert (
        "UPDATE one_referral_program_settings SET retired_at = NULL WHERE version = 1" in statements
    )


def test_rollback_documents_that_earned_records_are_not_reversed() -> None:
    text = _rollback()
    assert "one_referral_score_events" in text
    assert "one_referral_milestone_entitlements" in text
    assert "not reverse" in text.lower() or "untouched" in text.lower()


def test_rollback_locks_both_rows_before_reading_either() -> None:
    statements = _statements(_rollback())
    lock_index = statements.index("FOR UPDATE")
    read_index = statements.index("SELECT * INTO v1_row")
    assert lock_index < read_index
    assert "version IN (1, 2)" in statements


def test_rollback_is_idempotent_when_already_rolled_back() -> None:
    statements = _statements(_rollback())
    assert "version 1 already active and version 2 already retired" in statements
    assert "idempotent no-op" in statements


def test_rollback_rejects_an_unexpected_starting_state() -> None:
    statements = _statements(_rollback())
    assert "unexpected starting state" in statements
    assert "RAISE EXCEPTION" in statements


def test_rollback_asserts_exactly_one_active_version_before_commit() -> None:
    statements = _statements(_rollback())
    assert "active_count <> 1" in statements
    assert "invariant violated" in statements
