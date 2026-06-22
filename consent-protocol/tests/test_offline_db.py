"""Offline mode (DB_OFFLINE=1) end-to-end behavior for the db layer.

Verifies the SQLite-backed db_client engine and the asyncpg-compatible offline
pool work against the real consent-path tables, so the air-gapped offline mode
actually serves the consent connector + PKM flows.
"""

import asyncio
import importlib

import pytest


@pytest.fixture()
def offline_env(tmp_path, monkeypatch):
    db_file = tmp_path / "offline-test.db"
    monkeypatch.setenv("DB_OFFLINE", "1")
    monkeypatch.setenv("OFFLINE_DB_PATH", str(db_file))
    # Reset module singletons so the engine/pool rebuild under offline env.
    import db.connection as connection
    import db.db_client as db_client
    import db.offline_db as offline_db

    importlib.reload(offline_db)
    db_client._engine = None
    db_client._db_client = None
    connection._pool = None
    yield
    db_client._engine = None
    db_client._db_client = None
    connection._pool = None


def test_db_client_uses_sqlite_offline(offline_env):
    from db.db_client import get_db

    db = get_db()
    assert db.engine.dialect.name == "sqlite"

    # consent_audit is the real table the consent path writes to.
    inserted = (
        db.table("consent_audit")
        .insert(
            {
                "token_id": "tok_test",
                "user_id": "u1",
                "agent_id": "developer:app_test",
                "scope": "pkm.read",
                "action": "requested",
                "issued_at": 1781000000000,
                "request_id": "req_test_1",
            }
        )
        .execute()
    )
    assert len(inserted.data) == 1

    rows = db.table("consent_audit").select("*").eq("request_id", "req_test_1").execute()
    assert rows.data[0]["action"] == "requested"


def test_db_client_upsert_and_json_offline(offline_env):
    from db.db_client import get_db

    db = get_db()
    # UPSERT (ON CONFLICT ... RETURNING) is used by the consent-export grant path.
    first = (
        db.table("consent_exports")
        .upsert(
            {
                "consent_token": "HCT:test",
                "user_id": "u1",
                "encrypted_data": "ab",
                "iv": "i",
                "tag": "t",
                "scope": "pkm.read",
                "expires_at": "2099-01-01",
                "export_revision": 1,
                "refresh_status": "fresh",
            },
            on_conflict="consent_token",
        )
        .execute()
    )
    assert first.data[0]["export_revision"] == 1

    # JSON value round-trips (stored as TEXT in SQLite).
    updated = (
        db.table("consent_audit")
        .insert(
            {
                "token_id": "tok_json",
                "user_id": "u1",
                "agent_id": "a",
                "scope": "pkm.read",
                "action": "requested",
                "issued_at": 1,
                "request_id": "req_json",
                "metadata": {"k": "v"},
            }
        )
        .execute()
    )
    assert updated.data[0]["metadata"]


def test_offline_pool_is_asyncpg_compatible(offline_env):
    from db.connection import get_pool

    async def _run():
        pool = await get_pool()
        # asyncpg-style surface the peripheral services rely on.
        assert hasattr(pool, "acquire")
        assert hasattr(pool, "fetchrow")
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO consent_audit "
                "(token_id,user_id,agent_id,scope,action,issued_at,request_id) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                "tok_pool",
                "u2",
                "a",
                "pkm.read",
                "requested",
                1,
                "req_pool",
            )
            row = await conn.fetchrow(
                "SELECT token_id FROM consent_audit WHERE request_id = $1", "req_pool"
            )
            assert row["token_id"] == "tok_pool"  # noqa: S105
            count = await conn.fetchval(
                "SELECT count(*) FROM consent_audit WHERE user_id = $1", "u2"
            )
            assert count == 1

    asyncio.run(_run())
