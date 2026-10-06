import json
from pathlib import Path


def test_direct_message_migration_has_database_authorization_gates_not_circle_membership():
    sql = (
        Path(__file__).resolve().parents[1] / "db" / "migrations" / "264_direct_messages.sql"
    ).read_text(encoding="utf-8")
    normalized = sql.lower()

    assert "create table if not exists public.conversations" in normalized
    assert "create table if not exists public.messages" in normalized
    assert "create table if not exists public.direct_message_blocks" in normalized
    assert "require_active_direct_message_connection" in normalized
    # The trigger reads `connection.status` into a local variable while it
    # holds the canonical connection-row lock, then rejects every non-active
    # state.  Assert that semantic check rather than tying this guard to one
    # particular SQL expression spelling.
    assert "v_connection_status <> 'active'" in normalized
    assert "direct_message_blocked" in normalized
    assert "guard_direct_message_message_write" in normalized
    assert "enable row level security" in normalized
    assert "one_location_circle_memberships" not in normalized


def test_direct_message_migration_has_a_non_destructive_rollback_guard():
    rollback = (
        Path(__file__).resolve().parents[1]
        / "db"
        / "migrations"
        / "rollback"
        / "264_direct_messages.rollback.sql"
    ).read_text(encoding="utf-8")
    assert "Cannot rollback direct messages while message history exists" in rollback


def test_direct_message_actions_preserve_encrypted_bodies_and_participant_boundaries():
    root = Path(__file__).resolve().parents[1]
    migration_name = "282_direct_message_actions.sql"
    migration = (root / "db" / "migrations" / migration_name).read_text(encoding="utf-8")
    rollback = (
        root / "db" / "migrations" / "rollback" / "282_direct_message_actions.rollback.sql"
    ).read_text(encoding="utf-8")
    manifest = json.loads((root / "db" / "release_migration_manifest.json").read_text())
    normalized = migration.lower()

    assert "reply_to_message_id" in normalized
    assert "deleted_for_everyone_at" in normalized
    assert "create table if not exists public.direct_message_reactions" in normalized
    assert "enable row level security" in normalized
    assert (
        "revoke all privileges on table public.direct_message_reactions from public" in normalized
    )
    assert "direct_message_reaction_forbidden" in normalized
    assert "remove_direct_message_feed_event" in normalized
    assert "perform public.install_account_deletion_write_guards();" in normalized
    assert migration_name in manifest["ordered_migrations"]
    assert manifest["rollback_migrations"][migration_name] == (
        "rollback/282_direct_message_actions.rollback.sql"
    )
    assert "drop table if exists public.direct_message_reactions" in rollback.lower()
