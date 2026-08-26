"""Release contract for migration 165 -- the Hushh One referral program plane.

A referral count is only worth having if it is hard to inflate. Most of that
defence is written as database constraints rather than service logic, because
the ways a referral count gets inflated -- a replayed heartbeat, two callbacks
racing, an admin UPDATE that walks a rejected relationship back to qualified --
are exactly the ways service-level checks lose.

These tests pin the constraints that carry that weight, so removing one is a
deliberate act with a failing test attached rather than a refactor nobody
noticed.

Structural assertions run against the DDL with SQL comments stripped: these
files explain themselves at length, and the commentary names things the
migration deliberately does not touch.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "db" / "migrations"
MANIFEST_PATH = ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = ROOT / "db" / "contracts"

MIGRATION = "165_one_referral_program.sql"
ROLLBACK = "165_one_referral_program.rollback.sql"
PRIOR = "163_one_location_system_circle_kinds.sql"

REFERRAL_TABLES = (
    "one_referral_policies",
    "one_referral_codes",
    "one_referral_attributions",
    "one_referral_relationships",
    "one_agent_engagement_sessions",
    "one_referral_events",
    "one_referral_risk_reviews",
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


# --------------------------------------------------------------------------
# Release plumbing
# --------------------------------------------------------------------------


def test_migration_is_registered_in_release_order() -> None:
    manifest = _manifest()
    ordered = manifest["ordered_migrations"]
    assert MIGRATION in ordered
    assert ordered.index(PRIOR) < ordered.index(MIGRATION)
    assert MIGRATION in manifest["groups"]["iam"]
    assert (MIGRATIONS_DIR / "rollback" / ROLLBACK).exists()


def test_base_and_uat_overlay_ids_are_unique_and_individually_monotonic() -> None:
    # Environment overlays keep their applied IDs forever. New shared
    # migrations can land above them; the release runner performs the stable
    # numeric merge for UAT without broadening the production lane.
    manifest = _manifest()
    ordered = [_version(name) for name in manifest["ordered_migrations"]]
    overlay = [_version(name) for name in manifest["environment_overlays"]["uat"]]
    assert ordered == sorted(ordered)
    assert overlay == sorted(overlay)
    assert len(ordered + overlay) == len(set(ordered + overlay))


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
# The invariants the referral count rests on
# --------------------------------------------------------------------------


def test_every_referral_table_is_created() -> None:
    statements = _statements(_migration())
    for table in REFERRAL_TABLES:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in statements


def test_a_referred_user_can_belong_to_only_one_referrer() -> None:
    # The single load-bearing invariant of the whole program. A unique index
    # rather than a service check, because the failure it prevents -- two
    # authentication callbacks binding at once -- is a concurrent one that a
    # SELECT-then-INSERT loses every time.
    statements = _statements(_migration())
    assert "one_referral_relationships_one_per_referred" in statements
    assert "ON one_referral_relationships (referred_user_id)" in statements


def test_self_referral_is_impossible_at_both_ends() -> None:
    statements = _statements(_migration())
    assert "one_referral_attributions_not_self" in statements
    assert "one_referral_relationships_not_self" in statements
    assert "CHECK (referrer_user_id <> referred_user_id)" in statements


def test_credited_time_cannot_exceed_the_session_it_belongs_to() -> None:
    # Plain addition would happily credit a replayed or out-of-order heartbeat.
    # Bounding credited seconds by the session's own wall-clock span is what
    # turns that from extra time into a constraint violation.
    statements = _statements(_migration())
    assert "one_agent_engagement_sessions_credit_non_negative" in statements
    assert "one_agent_engagement_sessions_credit_within_span" in statements


def test_replayed_events_cannot_be_credited_twice() -> None:
    statements = _statements(_migration())
    assert "one_referral_events_idempotency_key" in statements
    assert "ON one_referral_events (idempotency_key)" in statements


def test_a_terminal_relationship_cannot_return_to_an_active_one() -> None:
    # Rejected -> qualified is the most expensive bug this feature can have,
    # and it is the kind an admin UPDATE or a future refactor writes by
    # accident. The guard lives in the database so neither can.
    statements = _statements(_migration())
    assert "one_referral_relationships_guard_transition" in statements
    assert "BEFORE UPDATE ON one_referral_relationships" in statements
    for terminal in ("ineligible", "rejected", "expired", "revoked"):
        # Matched on meaning, not column alignment: a terminal status maps to an
        # empty set of allowed next states, however the CASE arm is spaced.
        assert re.search(rf"WHEN\s+'{terminal}'\s+THEN\s+ARRAY\[\]::TEXT\[\]", statements), (
            f"{terminal} is not a terminal state in the transition guard"
        )

    # And the one exit that must exist: a qualified referral can be revoked.
    assert re.search(r"WHEN\s+'qualified'\s+THEN\s+ARRAY\['revoked'\]", statements)


def test_only_one_policy_can_be_live_at_a_time() -> None:
    statements = _statements(_migration())
    assert "one_referral_policies_single_active" in statements
    assert "WHERE activated_at IS NOT NULL AND retired_at IS NULL" in statements


def test_the_v1_policy_is_seeded_at_fifteen_active_minutes() -> None:
    # 900 seconds is v1's answer, not a constant: the column exists so the bar
    # can move to 20 minutes through a new policy version, without a client
    # release and without changing what an in-flight referral must do.
    statements = _statements(_migration())
    assert "INSERT INTO one_referral_policies" in statements
    assert "900, 3," in statements
    assert "required_active_seconds        INTEGER NOT NULL" in statements


def test_a_referral_is_evaluated_against_the_policy_it_started_under() -> None:
    statements = _statements(_migration())
    assert (
        "policy_version        INTEGER NOT NULL REFERENCES one_referral_policies(version)"
        in statements
    )


def test_one_active_slug_per_owner_and_global_slug_uniqueness() -> None:
    statements = _statements(_migration())
    assert "one_referral_codes_one_active_per_owner" in statements
    assert "one_referral_codes_normalized_slug_key" in statements
    assert "ON one_referral_codes (normalized_slug)" in statements


def test_a_risk_decision_must_name_who_made_it() -> None:
    statements = _statements(_migration())
    assert "one_referral_risk_reviews_decided_is_attributed" in statements


# --------------------------------------------------------------------------
# What the migration must NOT do
# --------------------------------------------------------------------------


def test_no_existing_table_is_altered() -> None:
    # The feature is additive by construction. Sign-in, onboarding, the agents
    # and Profile must behave identically whether these tables exist or not --
    # that is what makes the program safe to switch off under load.
    statements = _statements(_migration())
    assert "ALTER TABLE" not in statements
    assert "DROP TABLE" not in statements
    assert "DROP COLUMN" not in statements


def test_the_location_referral_tables_are_untouched() -> None:
    # `one_location_referrals` (migration 061) is a different concept entirely
    # -- referring a person to a location share. Nothing here extends it.
    statements = _statements(_migration())
    assert "one_location_referrals" not in statements
    assert "one_location_circles" not in statements


def test_no_reward_or_balance_is_invented() -> None:
    # A qualified referral is a count and an audit trail. Money has not been
    # specified, and guessing at a financial contract is worse than not having
    # one.
    statements = _statements(_migration()).lower()
    for word in ("reward", "balance", "points", "payout", "credit_amount", "wallet"):
        assert word not in statements


def test_no_raw_device_or_network_identifier_is_stored() -> None:
    statements = _statements(_migration()).lower()
    assert "installation_reference_hash" in statements
    for word in ("ip_address", "device_id", "user_agent", "fingerprint"):
        assert word not in statements


def test_rollback_drops_every_table_and_leaves_pgcrypto_alone() -> None:
    rollback = _statements(_rollback())
    for table in REFERRAL_TABLES:
        assert f"DROP TABLE IF EXISTS {table}" in rollback
    assert "DROP TRIGGER IF EXISTS one_referral_relationships_guard_transition" in rollback
    assert "DROP EXTENSION" not in rollback


# --------------------------------------------------------------------------
# 167 -- the live stream's doorbell
# --------------------------------------------------------------------------

REALTIME_MIGRATION = "167_one_referral_realtime_notify.sql"
REALTIME_ROLLBACK = "167_one_referral_realtime_notify.rollback.sql"


def _realtime() -> str:
    return (MIGRATIONS_DIR / REALTIME_MIGRATION).read_text(encoding="utf-8")


def test_the_notify_migration_is_registered_and_reversible() -> None:
    manifest = _manifest()
    assert REALTIME_MIGRATION in manifest["ordered_migrations"]
    assert REALTIME_MIGRATION in manifest["groups"]["iam"]
    assert (MIGRATIONS_DIR / "rollback" / REALTIME_ROLLBACK).exists()


def test_the_notify_payload_carries_no_referred_user() -> None:
    # The payload travels to EVERY listening connection on the database, so it
    # is a doorbell and nothing else: the referrer id and a reason. What that
    # referrer may see is decided once, by the authenticated summary endpoint;
    # copying that decision into a trigger would mean maintaining it twice.
    statements = _statements(_realtime())
    assert "'referrer_user_id', row_data.referrer_user_id" in statements
    assert "'referrer_user_id', referrer" in statements
    assert "referred_user_id," not in statements.split("pg_notify")[1]
    for leak in ("credited_active_seconds'", "meaningful_event_count'", "agent_key'"):
        assert leak not in statements


def test_a_no_op_write_wakes_nobody() -> None:
    # A bulk UPDATE that changes nothing must not wake every open stream, and a
    # heartbeat that earned no credit changes no number on the screen.
    statements = _statements(_realtime())
    assert "NEW.status = OLD.status" in statements
    assert "NEW.credited_active_seconds = OLD.credited_active_seconds" in statements


def test_the_engagement_trigger_has_its_index() -> None:
    # It looks the relationship up by referred user on every credited
    # heartbeat -- the hot path of the whole program.
    statements = _statements(_realtime())
    assert "one_referral_relationships_referred_lookup" in statements
    assert "ON one_referral_relationships (referred_user_id)" in statements
