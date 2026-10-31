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


def _offline_vault_service():
    from db.db_client import get_db
    from hushh_mcp.services.vault_keys_service import VaultKeysService

    service = VaultKeysService()
    service._db = get_db()
    return service


@pytest.mark.parametrize("offline,dialect", [("0", "sqlite"), ("1", "postgresql"), ("1", None)])
def test_initial_contacts_projection_fallback_requires_offline_sqlite(
    monkeypatch, offline, dialect
):
    from types import SimpleNamespace

    from hushh_mcp.services.vault_keys_service import VaultKeysService

    monkeypatch.setenv("DB_OFFLINE", offline)
    service = VaultKeysService()
    # There is deliberately no execute_raw: neither case may inspect SQLite.
    service._db = (
        SimpleNamespace(engine=SimpleNamespace(dialect=SimpleNamespace(name=dialect)))
        if dialect is not None
        else SimpleNamespace()
    )
    assert service._offline_initial_contacts_columns() is None
    projection = service._user_entry_projection().split(",")
    assert "initial_contacts_source" in projection
    assert "initial_contacts_welcome_acknowledged" in projection
    assert "initial_contacts_circle_id" in projection


def test_legacy_offline_vault_bootstrap_and_setup_preserve_metadata(offline_env):
    service = _offline_vault_service()
    projection = service._user_entry_projection().split(",")
    assert not any(column.startswith("initial_contacts_") for column in projection)

    first = service._get_pre_vault_state_sync("legacy-offline-owner")
    returning = service._get_pre_vault_state_sync("legacy-offline-owner")
    assert returning["loginCount"] == first["loginCount"] + 1
    for state in (first, returning):
        assert state["initialContactsSource"] is None
        assert state["initialContactsWelcomeAcknowledged"] is None
        assert state["initialContactsCircleId"] is None

    finished = service._update_pre_vault_state_sync(
        user_id="legacy-offline-owner", setup_completed=True
    )
    assert finished["setupCompleted"] is True
    assert finished["initialContactsCircleId"] is None


@pytest.mark.parametrize(
    "payload",
    [
        {"initial_contacts_source": "device"},
        {"initial_contacts_welcome_acknowledged": True},
    ],
)
def test_legacy_offline_vault_refuses_initial_contacts_writes(offline_env, payload):
    service = _offline_vault_service()
    before = service._get_pre_vault_state_sync("legacy-offline-owner")
    with pytest.raises(ValueError, match="initial contacts unavailable in offline schema"):
        service._update_pre_vault_state_sync(user_id="legacy-offline-owner", **payload)
    row = service._db.table("vault_keys").select("*").execute().data[0]
    assert row["login_count"] == before["loginCount"]
    assert row["setup_completed"] == 0


def test_partial_offline_initial_contacts_schema_reads_only_present_columns(offline_env):
    service = _offline_vault_service()
    service._db.execute_raw("ALTER TABLE vault_keys ADD COLUMN initial_contacts_source TEXT")
    projection = service._user_entry_projection().split(",")
    assert "initial_contacts_source" in projection
    assert "initial_contacts_welcome_acknowledged" not in projection
    assert "initial_contacts_circle_id" not in projection
    service._get_pre_vault_state_sync("partial-offline-owner")
    service._db.table("vault_keys").update({"initial_contacts_source": "device"}).eq(
        "user_id", "partial-offline-owner"
    ).execute()
    state = service._get_pre_vault_state_sync("partial-offline-owner")
    assert state["initialContactsSource"] == "device"
    assert state["initialContactsWelcomeAcknowledged"] is None
    assert state["initialContactsCircleId"] is None
    with pytest.raises(ValueError, match="initial contacts unavailable in offline schema"):
        service._update_pre_vault_state_sync(
            user_id="partial-offline-owner", initial_contacts_source="device"
        )


def test_current_offline_initial_contacts_metadata_roundtrips(offline_env):
    service = _offline_vault_service()
    # Only this test database is upgraded; the generated snapshot stays untouched.
    for column, column_type in (
        ("initial_contacts_source", "TEXT"),
        ("initial_contacts_welcome_acknowledged", "INTEGER"),
        ("initial_contacts_circle_id", "TEXT"),
    ):
        service._db.execute_raw(f"ALTER TABLE vault_keys ADD COLUMN {column} {column_type}")
    service._get_pre_vault_state_sync("current-offline-owner")
    enrolled = service._update_pre_vault_state_sync(
        user_id="current-offline-owner", initial_contacts_source="device"
    )
    assert enrolled["initialContactsSource"] == "device"
    assert enrolled["initialContactsWelcomeAcknowledged"] is False
    circle_id = "00000000-0000-0000-0000-000000000001"
    service._db.table("vault_keys").update(
        {"vault_status": "active", "initial_contacts_circle_id": circle_id}
    ).eq("user_id", "current-offline-owner").execute()
    service._update_pre_vault_state_sync(user_id="current-offline-owner", setup_completed=True)
    acknowledged = service._update_pre_vault_state_sync(
        user_id="current-offline-owner", initial_contacts_welcome_acknowledged=True
    )
    assert acknowledged["initialContactsWelcomeAcknowledged"] is True
    assert acknowledged["initialContactsCircleId"] == circle_id
