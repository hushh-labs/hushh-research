"""Migration 079: real network connections migrate into trusted_connections
(both directions), seeded pairs are excluded, and source='seed' trusted rows
are purged.  The source CHECK is also widened to allow 'circle_invite'.

Static tests (no DB) mirror the approach used in
tests/test_one_location_public_invite_migration.py — check file content and
manifest registration.

The DB-backed test (pytest.mark.db) connects to the local Cloud SQL Auth-Proxy
tunnel at 127.0.0.1:6543 (credentials from consent-protocol/.env).  It wraps
everything in a rolled-back transaction so the live database is not permanently
modified.  Skip with `pytest -m "not db"` if the tunnel is unavailable.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"
MIGRATION_FILE = "079_unify_location_connections.sql"

# ---------------------------------------------------------------------------
# Static (file-level) tests
# ---------------------------------------------------------------------------


def test_079_migration_file_exists_and_is_idempotent():
    sql = (MIGRATIONS_DIR / MIGRATION_FILE).read_text(encoding="utf-8")
    assert "BEGIN;" in sql
    assert "COMMIT;" in sql
    assert "ON CONFLICT (owner_user_id, trusted_user_id) DO NOTHING" in sql
    assert "IF EXISTS" in sql  # idempotent constraint drop


def test_079_migration_widens_source_check_to_circle_invite():
    sql = (MIGRATIONS_DIR / MIGRATION_FILE).read_text(encoding="utf-8")
    assert "circle_invite" in sql
    assert "trusted_connections_source_check" in sql
    assert "DROP CONSTRAINT IF EXISTS trusted_connections_source_check" in sql
    assert "ADD CONSTRAINT trusted_connections_source_check" in sql


def test_079_migration_copies_both_directions_and_purges_seeds():
    sql = (MIGRATIONS_DIR / MIGRATION_FILE).read_text(encoding="utf-8")
    # Both directed copies
    assert "nc.user_a_id, nc.user_b_id" in sql
    assert "nc.user_b_id, nc.user_a_id" in sql
    # Seed exclusion in SELECT
    assert "sos_seed" in sql
    # Seed purge DELETE
    assert "DELETE FROM trusted_connections WHERE source = 'seed'" in sql


def test_079_migration_registered_in_manifest():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    assert MIGRATION_FILE in manifest["ordered_migrations"]
    ordered = manifest["ordered_migrations"]
    assert ordered.index(MIGRATION_FILE) > ordered.index("078_trusted_connections.sql")


def test_079_uat_contract_updated():
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    assert contract["expected_migration_version"] == 79
    assert "trusted_connections" in contract["required_tables"]


# ---------------------------------------------------------------------------
# DB-backed test
# ---------------------------------------------------------------------------

_ENV_PATH = REPO_ROOT / ".env"


def _build_db_url() -> str:
    """Build a postgresql:// URL from DB_* env vars (same as db/connection.py)."""
    from dotenv import load_dotenv

    load_dotenv(_ENV_PATH)
    user = os.environ["DB_USER"]
    password = os.environ["DB_PASSWORD"]
    host = os.environ.get("DB_HOST", "127.0.0.1")
    port = os.environ.get("DB_PORT", "5432")
    name = os.environ.get("DB_NAME", "postgres")
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


async def _run_079_db_test() -> None:
    """
    Core async logic for the DB-backed migration test.

    Uses a rolled-back transaction so no permanent changes occur.  Test user
    IDs are prefixed with a unique hex token so they never collide with real
    data even if a rollback is somehow missed.
    """
    import asyncpg

    url = _build_db_url()
    conn = await asyncpg.connect(url)

    # Unique token per test run
    uid = "t79_" + os.urandom(4).hex()

    # one_location_network_connections requires user_a_id < user_b_id (ordered pair).
    # Using _aa/_bb / _dx/_zz suffixes guarantees lexicographic ordering.
    user_a = uid + "_aa"  # < user_b
    user_b = uid + "_bb"
    dev_x = uid + "_dx"  # < user_z  (seeded pair)
    user_z = uid + "_zz"
    dev_seed = uid + "_s0"  # appears only in trusted_connections as source='seed'

    migration_path = MIGRATIONS_DIR / MIGRATION_FILE
    # Strip the outer BEGIN/COMMIT so we can run inside our own transaction.
    migration_sql = migration_path.read_text(encoding="utf-8")
    migration_sql = migration_sql.replace("BEGIN;", "").replace("COMMIT;", "").strip()

    tr = conn.transaction()
    await tr.start()
    try:
        # ── 1. Seed: a real invite-claimed pair ──────────────────────────────
        await conn.execute(
            """
            INSERT INTO one_location_network_connections
              (user_a_id, user_b_id, inviter_user_id, invitee_user_id,
               status, connected_at, created_at, updated_at, metadata)
            VALUES
              ($1, $2, $1, $2, 'active', NOW(), NOW(), NOW(),
               '{"source":"invite_to_one"}'::jsonb)
            """,
            user_a,
            user_b,
        )

        # ── 2. Seed: a dev-seeded pair that must NOT migrate ─────────────────
        await conn.execute(
            """
            INSERT INTO one_location_network_connections
              (user_a_id, user_b_id, inviter_user_id, invitee_user_id,
               status, connected_at, created_at, updated_at, metadata)
            VALUES
              ($1, $2, $2, $1, 'active', NOW(), NOW(), NOW(),
               '{"source":"sos_seed"}'::jsonb)
            """,
            dev_x,
            user_z,
        )

        # ── 3. Seed: a preseeded trusted row that must be purged ─────────────
        await conn.execute(
            """
            INSERT INTO trusted_connections
              (owner_user_id, trusted_user_id, status, source, resolved_via)
            VALUES ($1, $2, 'active', 'seed', 'user_id')
            """,
            user_a,
            dev_seed,
        )

        # ── 4. Apply the 079 migration (inside our transaction) ──────────────
        await conn.execute(migration_sql)

        # ── 5. Assert — scoped to our test user IDs ──────────────────────────
        rows = await conn.fetch(
            """
            SELECT owner_user_id, trusted_user_id, source
            FROM trusted_connections
            WHERE owner_user_id LIKE $1
               OR trusted_user_id LIKE $1
            """,
            uid + "%",
        )
        edges = {(r["owner_user_id"], r["trusted_user_id"]) for r in rows}

        # Real pair migrated in both directions
        assert (user_a, user_b) in edges, f"Expected edge {user_a} -> {user_b}"
        assert (user_b, user_a) in edges, f"Expected edge {user_b} -> {user_a}"

        # Seeded network pair must NOT have been migrated
        assert (dev_x, user_z) not in edges, "sos_seed pair must not be migrated (a→b)"
        assert (user_z, dev_x) not in edges, "sos_seed pair must not be migrated (b→a)"

        # Preseeded trusted row must be purged (source='seed' deleted)
        seed_rows = [r for r in rows if r["source"] == "seed"]
        assert not seed_rows, f"Expected no seed rows, found: {seed_rows}"

        # Migrated rows use circle_invite provenance
        migrated = [
            r
            for r in rows
            if (r["owner_user_id"], r["trusted_user_id"]) in {(user_a, user_b), (user_b, user_a)}
        ]
        assert all(r["source"] == "circle_invite" for r in migrated), (
            "Migrated rows must have source='circle_invite'"
        )

    finally:
        # Always rollback — test must not permanently affect the live database.
        await tr.rollback()

    await conn.close()


@pytest.mark.db
def test_079_migrates_real_pairs_both_directions_and_drops_seeds():
    """DB-backed end-to-end test for migration 079.

    Requires the Cloud SQL Auth-Proxy tunnel at 127.0.0.1:6543.
    All changes are wrapped in a rolled-back transaction.
    """
    asyncio.run(_run_079_db_test())
