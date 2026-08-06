from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"


def test_named_circle_migrations_are_registered_in_release_order() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))
    migrations = [
        "134_one_location_named_circles.sql",
        "135_one_location_circle_connection_origins.sql",
        "136_one_location_circle_member_invites.sql",
    ]

    assert manifest["ordered_migrations"][-3:] == migrations
    assert all(migration in manifest["groups"]["iam"] for migration in migrations)
    assert schema["expected_migration_version"] == 136
    for migration in migrations:
        assert (MIGRATIONS_DIR / migration).exists()
        stem = migration.removesuffix(".sql")
        assert (MIGRATIONS_DIR / "rollback" / f"{stem}_down.sql").exists()


def test_named_circle_base_schema_is_hash_only_and_additive() -> None:
    migration = (MIGRATIONS_DIR / "134_one_location_named_circles.sql").read_text(encoding="utf-8")
    schema = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))
    required = schema["required_tables"]

    assert "CREATE TABLE IF NOT EXISTS one_location_circles" in migration
    assert "CREATE TABLE IF NOT EXISTS one_location_circle_memberships" in migration
    assert "CREATE TABLE IF NOT EXISTS one_location_circle_invite_codes" in migration
    assert "code_hash CHAR(64) NOT NULL UNIQUE" in migration
    assert "raw_code" not in migration
    assert "invite_code TEXT" not in migration
    assert migration.count("REFERENCES actor_profiles(user_id) ON DELETE CASCADE") >= 3
    assert "UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_active_invite" in migration
    assert "UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_active_owner" in migration
    assert "ADD COLUMN IF NOT EXISTS source_circle_id UUID" in migration
    assert "REFERENCES one_location_circles(id) ON DELETE CASCADE" in migration
    assert "REFERENCES one_location_circles(id) ON DELETE SET NULL" not in migration
    assert "INSERT INTO connections" not in migration
    assert "INSERT INTO trusted_connections" not in migration
    assert "one_location_circles" in required
    assert "one_location_circle_memberships" in required
    assert "one_location_circle_invite_codes" in required
    assert "source_circle_id" in required["one_location_share_grants"]


def test_named_circle_connection_origins_are_source_aware_and_access_neutral() -> None:
    migration = (MIGRATIONS_DIR / "135_one_location_circle_connection_origins.sql").read_text(
        encoding="utf-8"
    )
    schema = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))

    assert "CREATE TABLE IF NOT EXISTS connection_origins" in migration
    assert "origin_kind IN (" in migration
    assert "'direct_request'" in migration
    assert "'named_circle'" in migration
    assert "'legacy_invite'" in migration
    assert "'import'" in migration
    assert "origin_key TEXT NOT NULL" in migration
    assert "REFERENCES connections(id) ON DELETE CASCADE" in migration
    assert "REFERENCES one_location_circles(id) ON DELETE RESTRICT" in migration
    assert "UNIQUE INDEX IF NOT EXISTS ux_connection_origins_key" in migration
    assert "WITH active_circle_pairs AS" in migration
    assert "INSERT INTO connections" in migration
    assert "JOIN one_location_circle_memberships first_member" in migration
    assert "JOIN one_location_circle_memberships second_member" in migration
    assert "circle.status = 'active'" in migration
    assert "first_member.status = 'active'" in migration
    assert "second_member.status = 'active'" in migration
    assert "first_member.user_id < second_member.user_id" in migration
    assert "ON CONFLICT (user_a_id, user_b_id) DO UPDATE" in migration
    assert migration.count("INSERT INTO connection_origins") >= 2
    assert "'named_circle:' || circle.id::text" in migration
    assert "INSERT INTO trusted_connections" not in migration
    assert "INSERT INTO one_location_share_grants" not in migration
    assert "INSERT INTO one_location_sms_contacts" not in migration
    assert set(schema["required_tables"]["connection_origins"]) >= {
        "connection_id",
        "origin_kind",
        "origin_key",
        "source_circle_id",
        "status",
    }


def test_targeted_circle_member_invites_require_acceptance_and_are_bounded() -> None:
    migration = (MIGRATIONS_DIR / "136_one_location_circle_member_invites.sql").read_text(
        encoding="utf-8"
    )
    schema = json.loads(SCHEMA_CONTRACT_PATH.read_text(encoding="utf-8"))

    assert "CREATE TABLE IF NOT EXISTS one_location_circle_member_invites" in migration
    assert "REFERENCES one_location_circles(id) ON DELETE CASCADE" in migration
    assert migration.count("REFERENCES actor_profiles(user_id) ON DELETE CASCADE") == 2
    assert (
        "CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired'))" in migration
    )
    assert "CHECK (inviter_user_id <> invitee_user_id)" in migration
    assert "CHECK (expires_at > created_at)" in migration
    assert "UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_member_invites_pending" in migration
    assert "WHERE status = 'pending'" in migration
    assert "INSERT INTO one_location_circle_memberships" not in migration
    assert "INSERT INTO connections" not in migration
    assert "INSERT INTO trusted_connections" not in migration
    assert "INSERT INTO one_location_share_grants" not in migration
    assert "INSERT INTO one_location_sms_contacts" not in migration
    assert set(schema["required_tables"]["one_location_circle_member_invites"]) >= {
        "circle_id",
        "inviter_user_id",
        "invitee_user_id",
        "status",
        "expires_at",
    }


def test_named_circle_rollback_removes_only_the_additive_shape() -> None:
    rollback = (MIGRATIONS_DIR / "rollback" / "134_one_location_named_circles_down.sql").read_text(
        encoding="utf-8"
    )

    assert "DROP COLUMN IF EXISTS source_circle_id" in rollback
    assert "DROP TABLE IF EXISTS one_location_circle_invite_codes" in rollback
    assert "DROP TABLE IF EXISTS one_location_circle_memberships" in rollback
    assert "DROP TABLE IF EXISTS one_location_circles" in rollback
    assert "DROP TABLE IF EXISTS connections" not in rollback
    assert "DROP TABLE IF EXISTS trusted_connections" not in rollback

    provenance_rollback = (
        MIGRATIONS_DIR / "rollback" / "135_one_location_circle_connection_origins_down.sql"
    ).read_text(encoding="utf-8")
    invite_rollback = (
        MIGRATIONS_DIR / "rollback" / "136_one_location_circle_member_invites_down.sql"
    ).read_text(encoding="utf-8")

    assert "DROP TABLE IF EXISTS connection_origins" in provenance_rollback
    assert "DROP TABLE IF EXISTS connections" not in provenance_rollback
    assert "ranked_superseded_requests AS" in provenance_rollback
    assert "request.metadata->>'supersededByConnectionId'" in provenance_rollback
    assert "candidate.request_rank = 1" in provenance_rollback
    assert "SET status = 'pending'" in provenance_rollback
    assert "metadata = request.metadata - 'supersededByConnectionId'" in provenance_rollback
    assert "DROP TABLE IF EXISTS one_location_circle_member_invites" in invite_rollback
    assert "DROP TABLE IF EXISTS one_location_circles" not in invite_rollback


def test_connection_origin_rollback_handles_leave_before_rollback() -> None:
    rollback = (
        MIGRATIONS_DIR / "rollback" / "135_one_location_circle_connection_origins_down.sql"
    ).read_text(encoding="utf-8")
    circle_only_candidates = rollback.split("ranked_superseded_requests AS", maxsplit=1)[0]
    aggregate_revoke = rollback.split(
        "-- Connections backed only by named Circles",
        maxsplit=1,
    )[1].split("DROP TABLE IF EXISTS connection_origins", maxsplit=1)[0]

    # A leave/removal revokes the named-Circle origin and recomputes source to
    # request before rollback. Historical Circle provenance must still qualify.
    assert "origin.origin_kind = 'named_circle'" in circle_only_candidates
    assert "origin.status = 'active'\n        AND origin.origin_kind = 'named_circle'" not in (
        circle_only_candidates
    )
    assert "origin.origin_kind = 'named_circle'" in aggregate_revoke
    assert "origin.status = 'active'\n         AND origin.origin_kind = 'named_circle'" not in (
        aggregate_revoke
    )

    # An active direct/import/legacy origin still prevents request restoration
    # and keeps the aggregate connection alive.
    assert "origin.status = 'active'" in circle_only_candidates
    assert "origin.origin_kind <> 'named_circle'" in circle_only_candidates
    assert "origin.status = 'active'" in aggregate_revoke
    assert "origin.origin_kind <> 'named_circle'" in aggregate_revoke
