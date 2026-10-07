"""Release contract for migration 275 -- referral gamification settings v2.

v1 (migration 270) shipped with placeholder milestones and an unset weekly
schedule by design. This pins that v2 actually supplies the real values --
the exact four-reward milestone ladder and the Sunday 23:59 Asia/Kolkata
weekly cutoff -- rather than drifting from what the product surface
advertises, and that the versioning discipline (retire the old row, never
mutate it) is followed structurally.

Structural assertions run against the DDL with SQL comments stripped, same
as migration 165's and 270's own tests: no live database in this suite.
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


def test_rollback_deletes_v2_and_reactivates_v1() -> None:
    statements = _statements(_rollback())
    assert "DELETE FROM one_referral_program_settings WHERE version = 2" in statements
    assert "SET retired_at = NULL" in statements
    assert "WHERE version = 1" in statements
