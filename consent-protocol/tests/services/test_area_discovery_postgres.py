"""Consent-index privacy boundary: small groups never yield identities."""

import asyncio
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest

from db.area_discovery_adoption import area_discovery_qualification_sql
from hushh_mcp.services import area_discovery as service
from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash
from hushh_mcp.services.area_discovery_policy import AreaDiscoveryError, postal_area, result_page


def test_group_floor_precedes_pagination_and_never_discloses_suppressed_count():
    people = [{"userId": str(i), "displayName": f"Example {i}"} for i in range(21)]
    assert (
        result_page(people[:9], 1)
        == result_page([], 1)
        == {"items": [], "hasMore": False, "suppressed": True}
    )
    assert result_page(people[:10], 1)["items"] == people[:10]
    assert result_page(people, 2)["items"] == people[20:]
    assert not result_page(people, 2)["hasMore"]
    with pytest.raises(AreaDiscoveryError):
        result_page(people, 6)


def test_area_accepts_only_coarse_zip_not_coordinates_or_free_text():
    assert postal_area("00501") == "00501"
    for invalid in [" 98033", "98033-1234", "47.67,-122.12", "Kirkland", "１２３４５"]:
        with pytest.raises(AreaDiscoveryError):
            postal_area(invalid)


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "db/migrations/428_one_area_discovery.sql"
ROLLBACK = ROOT / "db/migrations/rollback/428_one_area_discovery.rollback.sql"


@asynccontextmanager
async def isolated_database(url):
    url = url.replace("postgresql+psycopg2://", "postgresql://", 1)
    admin = await asyncpg.connect(url)
    database = "area_test_" + uuid4().hex
    await admin.execute(f'CREATE DATABASE "{database}"')
    pool = await asyncpg.create_pool(dsn=url, database=database, min_size=1, max_size=8)
    try:
        async with pool.acquire() as conn:
            await conn.execute("""CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY,public_profile_status TEXT DEFAULT 'active');
                CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT);
                CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY,vault_status TEXT DEFAULT 'active',environment_enrolled_at TIMESTAMPTZ DEFAULT NOW());
                CREATE TABLE connections(user_a_id TEXT,user_b_id TEXT,status TEXT);
                CREATE TABLE connection_requests(requester_user_id TEXT,addressee_user_id TEXT,status TEXT);
                CREATE TABLE consent_audit(request_id TEXT,user_id TEXT,action TEXT,metadata JSONB,issued_at BIGINT);""")
            await conn.execute(
                (ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text()
            )
            await conn.execute(MIGRATION.read_text())
            await conn.execute(MIGRATION.read_text())
            qualification = area_discovery_qualification_sql()
            await conn.execute(qualification)
            await conn.execute(
                "ALTER TABLE account_deletion_tombstones DISABLE TRIGGER one_area_discovery_erasure"
            )
            with pytest.raises(asyncpg.RaiseError, match="Unqualified area discovery"):
                await conn.execute(qualification)
            await conn.execute(
                "ALTER TABLE account_deletion_tombstones ENABLE TRIGGER one_area_discovery_erasure"
            )
            await conn.execute("""CREATE OR REPLACE FUNCTION public.erase_one_area_discovery()
                RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public
                AS $$ BEGIN RETURN NEW; END $$;""")
            with pytest.raises(asyncpg.RaiseError, match="Unqualified area discovery"):
                await conn.execute(qualification)
            await conn.execute(MIGRATION.read_text())
            await conn.execute(qualification)
            for uid in ["viewer", *(f"person-{i:02}" for i in range(10))]:
                await conn.execute("INSERT INTO actor_profiles(user_id) VALUES($1)", uid)
                await conn.execute(
                    "INSERT INTO actor_identity_cache VALUES($1,$2)", uid, "Example " + uid
                )
                await conn.execute("INSERT INTO vault_keys(user_id) VALUES($1)", uid)
        yield pool
    finally:
        await pool.close()
        await admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
        await admin.close()


async def choose(uid, enabled=True, revision=0):
    return await service.choose_preference(
        uid,
        enabled=enabled,
        postal_code="98033" if enabled else None,
        expected_revision=revision,
        consent_version="one-area-discovery-v1",
        adult_confirmed=enabled,
    )


async def assert_consent_and_floor(pool, monkeypatch, disabled):
    assert not (await service.preference("viewer"))["enabled"]
    with pytest.raises(AreaDiscoveryError, match="Confirm"):
        await service.choose_preference(
            "viewer",
            enabled=True,
            postal_code="98033",
            expected_revision=0,
            consent_version="one-area-discovery-v1",
            adult_confirmed=False,
        )
    for i in range(10):
        await choose(f"person-{i:02}")
    assert len((await service.search("viewer", postal_code="98033", page=1))["items"]) == 10
    disabled.add("person-00")
    assert (await service.search("viewer", postal_code="98033", page=1)) == result_page([], 1)
    disabled.clear()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM actor_identity_cache WHERE user_id='person-00'")
    setting = await service.preference("person-00")
    assert setting["displayName"] == "Recovered Example" and setting["canEnable"]
    writes = await asyncio.gather(
        choose("person-00", False, 1), choose("person-00", True, 1), return_exceptions=True
    )
    assert sum(isinstance(v, AreaDiscoveryError) and v.status_code == 409 for v in writes) == 1
    setting = await service.preference("person-00")
    if not setting["enabled"]:
        await choose("person-00", True, setting["revision"])


async def assert_serialized_search(monkeypatch, mutation):
    held, finish = threading.Event(), threading.Event()

    def held_identity(ids, **kw):
        held.set()
        assert finish.wait(5)
        return set(ids)

    monkeypatch.setattr(service, "active_directory_user_ids", held_identity)
    searching = asyncio.create_task(service.search("viewer", postal_code="98033", page=1))
    assert await asyncio.to_thread(held.wait, 5)
    changing = asyncio.create_task(mutation())
    try:
        await asyncio.sleep(0.05)
        assert not changing.done()
    finally:
        finish.set()
    await searching
    await changing
    monkeypatch.setattr(service, "active_directory_user_ids", lambda ids, **kw: set(ids))
    assert (await service.search("viewer", postal_code="98033", page=1))["suppressed"]


async def assert_off_and_erasure(pool, monkeypatch):
    setting = await service.preference("person-00")
    await assert_serialized_search(
        monkeypatch, lambda: choose("person-00", False, setting["revision"])
    )
    # Off works with no enrolled vault, ZIP, adult choice or identity provider.
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE vault_keys SET environment_enrolled_at=NULL WHERE user_id='person-01'"
        )
    monkeypatch.setattr(
        service,
        "active_directory_user_ids",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("unavailable")),
    )
    await choose("person-01", False, 1)
    monkeypatch.setattr(service, "active_directory_user_ids", lambda ids, **kw: set(ids))
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "SELECT postal_code FROM one_area_discovery_preferences WHERE user_id='person-01'"
            )
            is None
        )
        await conn.execute(
            "UPDATE vault_keys SET environment_enrolled_at=NOW() WHERE user_id='person-01'"
        )
    for uid in ["person-00", "person-01"]:
        await choose(uid, True, (await service.preference(uid))["revision"])

    async def erase():
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO account_deletion_tombstones(user_id_hash) VALUES($1)",
                account_deletion_user_hash("person-02"),
            )

    await assert_serialized_search(monkeypatch, erase)
    async with pool.acquire() as conn:
        assert not await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM one_area_discovery_preferences WHERE user_id='person-02')"
        )
        with pytest.raises(asyncpg.CheckViolationError, match="account identity is deleted"):
            await conn.execute(
                "INSERT INTO one_area_discovery_preferences(user_id,enabled,revision,consent_version) VALUES('person-02',false,1,'one-area-discovery-v1')"
            )


async def assert_budget_and_browser_isolation(pool):
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM one_area_discovery_search_budgets WHERE user_id='viewer'")
    charges = await asyncio.gather(
        *(service._charge_search("viewer") for _ in range(35)), return_exceptions=True
    )
    assert sum(isinstance(v, AreaDiscoveryError) and v.status_code == 429 for v in charges) == 5
    async with pool.acquire() as conn:
        role = "area_browser_" + uuid4().hex
        await conn.execute(f'CREATE ROLE "{role}" NOLOGIN NOBYPASSRLS')
        try:
            await conn.execute(f'GRANT SELECT ON one_area_discovery_preferences TO "{role}"')
            await conn.execute(f'SET ROLE "{role}"')
            assert not await conn.fetch("SELECT * FROM one_area_discovery_preferences")
        finally:
            await conn.execute("RESET ROLE")
            await conn.execute(f'DROP OWNED BY "{role}"')
            await conn.execute(f'DROP ROLE "{role}"')
        with pytest.raises(asyncpg.RaiseError, match="rollback_refused_nonempty_area_state"):
            await conn.execute(ROLLBACK.read_text())
        await conn.execute("ROLLBACK")
        await conn.execute(
            "DELETE FROM one_area_discovery_preferences; DELETE FROM one_area_discovery_search_budgets"
        )
        await conn.execute(ROLLBACK.read_text())
        await conn.execute(MIGRATION.read_text())


def test_area_consent_sql_lifecycle_on_disposable_postgres(monkeypatch):
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Disposable PostgreSQL administrator URL is required")

    async def scenario():
        async with isolated_database(url) as pool:

            async def get_pool():
                return pool

            monkeypatch.setattr(service, "get_pool", get_pool)
            disabled = set()
            monkeypatch.setattr(
                service, "active_directory_user_ids", lambda ids, **kw: set(ids) - disabled
            )
            monkeypatch.setattr(
                service,
                "directory_auth_profiles",
                lambda ids: {uid: {"display_name": "Recovered Example"} for uid in ids},
            )
            await assert_consent_and_floor(pool, monkeypatch, disabled)
            await assert_off_and_erasure(pool, monkeypatch)
            await assert_budget_and_browser_isolation(pool)

    asyncio.run(scenario())
