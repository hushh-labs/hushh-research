"""Migration 080: drop the legacy one_location_network_connections table.

All One Location trust reads/writes now go through trusted_connections (real
rows were migrated in 079).  Migration 080 retires the old SOS table.

Static tests (no DB) mirror the approach used in
tests/test_unify_location_connections_migration.py — check file content,
manifest registration, and the UAT contract.

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

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACT_PATH = REPO_ROOT / "db" / "contracts" / "uat_integrated_schema.json"
MIGRATION_FILE = "080_drop_one_location_network_connections.sql"

# ---------------------------------------------------------------------------
# Static (file-level) tests
# ---------------------------------------------------------------------------


def test_080_migration_file_exists_and_is_idempotent():
    sql = (MIGRATIONS_DIR / MIGRATION_FILE).read_text(encoding="utf-8")
    assert "BEGIN;" in sql
    assert "COMMIT;" in sql
    assert "DROP TABLE IF EXISTS one_location_network_connections" in sql


def test_080_migration_registered_in_manifest_after_079():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    ordered = manifest["ordered_migrations"]
    assert MIGRATION_FILE in ordered
    assert ordered.index(MIGRATION_FILE) == ordered.index("079_unify_location_connections.sql") + 1
    assert len(ordered) == len(set(ordered))


def test_080_uat_contract_bumped_and_table_removed():
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    assert contract["expected_migration_version"] == 80
    # The dropped table must no longer be contract-required.
    assert "one_location_network_connections" not in contract["required_tables"]
    # trusted_connections remains the single source of truth.
    assert "trusted_connections" in contract["required_tables"]


# ---------------------------------------------------------------------------
# DB-backed test
# ---------------------------------------------------------------------------

_ENV_PATH = REPO_ROOT / ".env"


def _build_db_url() -> str:
    from dotenv import load_dotenv

    load_dotenv(_ENV_PATH)
    user = os.environ["DB_USER"]
    password = os.environ["DB_PASSWORD"]
    host = os.environ.get("DB_HOST", "127.0.0.1")
    port = os.environ.get("DB_PORT", "5432")
    name = os.environ.get("DB_NAME", "postgres")
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


async def _run_080_db_test() -> None:
    """Apply migration 080 inside a rolled-back transaction and assert the
    legacy table is gone afterwards.  The DROP is idempotent, so this works
    whether or not the table currently exists in the live DB."""
    import asyncpg

    url = _build_db_url()
    conn = await asyncpg.connect(url)

    migration_path = MIGRATIONS_DIR / MIGRATION_FILE
    migration_sql = migration_path.read_text(encoding="utf-8")
    migration_sql = migration_sql.replace("BEGIN;", "").replace("COMMIT;", "").strip()

    tr = conn.transaction()
    await tr.start()
    try:
        # Ensure the table exists first so the drop is a meaningful assertion
        # even on a DB that has already advanced past 080.
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS one_location_network_connections (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              user_a_id TEXT NOT NULL,
              user_b_id TEXT NOT NULL
            )
            """
        )

        await conn.execute(migration_sql)

        exists = await conn.fetchval(
            "SELECT to_regclass('public.one_location_network_connections')"
        )
        assert exists is None, "one_location_network_connections must be dropped by migration 080"
    finally:
        await tr.rollback()

    await conn.close()


@pytest.mark.db
def test_080_drops_legacy_network_connections_table():
    """DB-backed end-to-end test for migration 080.

    Requires the Cloud SQL Auth-Proxy tunnel at 127.0.0.1:6543.
    All changes are wrapped in a rolled-back transaction.
    """
    asyncio.run(_run_080_db_test())
