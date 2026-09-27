"""Migration 255 replays cleanly and acceptance is idempotent on real PostgreSQL.

Applies the migration twice (every deploy replays it), records the same version
twice, then a newer one, and proves the rollback refuses to drop recorded
acceptances. Runs when ONE_COMMAND_TEST_DATABASE_URL points at an isolated
PostgreSQL database; the migration's guards address the public schema, so it
uses that schema and drops only its own table.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest

from hushh_mcp.services import legal_acceptance_service

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "255_account_legal_acceptances.sql"
ROLLBACK = "255_account_legal_acceptances.rollback.sql"
TABLE = "account_legal_acceptances"


def _postgres_url() -> str:
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    # CI hands a SQLAlchemy URL; asyncpg takes the plain libpq form.
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


def test_migration_replays_and_acceptance_is_idempotent_on_postgres(monkeypatch) -> None:
    import asyncpg

    url = _postgres_url()
    migration = (ROOT / "db/migrations" / MIGRATION).read_text()
    rollback = (ROOT / "db/migrations/rollback" / ROLLBACK).read_text()
    documents = [
        legal_acceptance_service.AcceptedDocument("terms", "2.0", "2026-09-27"),
        legal_acceptance_service.AcceptedDocument("privacy", "2.0", "2026-09-27"),
    ]

    async def scenario() -> None:
        pool = await asyncpg.create_pool(url, min_size=1, max_size=2)

        async def _pool() -> Any:
            return pool

        monkeypatch.setattr(legal_acceptance_service, "get_pool", _pool)
        try:
            await pool.execute(f"DROP TABLE IF EXISTS {TABLE}")
            await pool.execute(migration)
            await pool.execute(migration)  # every deploy replays it

            first = await legal_acceptance_service.record_acceptances(
                user_id="u1", documents=documents, surface="web"
            )
            again = await legal_acceptance_service.record_acceptances(
                user_id="u1", documents=documents, surface="native"
            )
            assert again == first  # same version: no new row, first accepted_at kept
            assert await pool.fetchval(f"SELECT COUNT(*) FROM {TABLE}") == 2

            await asyncio.sleep(0.01)
            newer = [
                legal_acceptance_service.AcceptedDocument("terms", "2.1", "2026-10-15"),
                documents[1],
            ]
            latest = await legal_acceptance_service.record_acceptances(
                user_id="u1", documents=newer, surface="native"
            )
            by_doc = {row["document_id"]: row for row in latest}
            assert by_doc["terms"]["document_version"] == "2.1"
            assert by_doc["privacy"]["surface"] == "web"
            assert await pool.fetchval(f"SELECT COUNT(*) FROM {TABLE}") == 3
            assert await legal_acceptance_service.list_latest_acceptances(user_id="u2") == []

            with pytest.raises(asyncpg.RaiseError, match="rollback_refused_nonempty_table"):
                await pool.execute(rollback)
            await pool.execute(f"DELETE FROM {TABLE}")
            await pool.execute(rollback)
            assert await pool.fetchval("SELECT to_regclass($1)", f"public.{TABLE}") is None
        finally:
            await pool.execute(f"DROP TABLE IF EXISTS {TABLE}")
            await pool.close()

    asyncio.run(scenario())
