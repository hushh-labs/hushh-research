"""A hosted onboarding link cannot adopt another financial source's account."""

import asyncio
from pathlib import Path

import pytest

from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError
from tests.helpers.scope_commerce_provider import _FinancialAdapter, _payout_service
from tests.helpers.scope_commerce_provider_db import provider_postgres as provider_postgres
from tests.test_pkm_payouts import stripe_env as stripe_env
from tests.test_pkm_payouts import world as world

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"


async def _document_table(connection):
    ddl = (
        (MIGRATIONS / "298_stripe_mode_isolation.sql")
        .read_text()
        .split("CREATE TABLE IF NOT EXISTS stripe_owner_payout_accounts", 1)[1]
        .split(";", 1)[0]
    )
    await connection.execute("CREATE TABLE IF NOT EXISTS stripe_owner_payout_accounts" + ddl)


def _binding_insert(source):
    if source == "scope":
        return "INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode) VALUES($1,$2,'US',$3='live')"
    return "INSERT INTO stripe_owner_payout_accounts(user_id,stripe_account_id,stripe_mode) VALUES($1,$2,$3)"


@pytest.mark.parametrize(
    ("owner", "livemode", "account", "conflict"),
    [
        ("owner", False, "acct_1", True),
        ("owner", False, "acct_scope", False),
        ("other", False, "acct_1", True),
        ("other", False, "acct_scope", False),
        ("owner", True, "acct_1", False),
    ],
)
async def test_document_onboarding_preserves_scope_binding(
    world, owner, livemode, account, conflict
):
    service, database, provider = world
    binding = {"user_id": owner, "livemode": livemode, "account_id": account}
    database.tables["scope_commerce_seller_accounts"] = [binding]
    if conflict:
        with pytest.raises(PacketOrderError, match="Could not start payout setup"):
            await service.onboarding_link(user_id="owner", surface="documents")
        assert not provider.links and not provider.preparations
        assert not database.tables["stripe_owner_payout_accounts"]
    else:
        await service.onboarding_link(user_id="owner", surface="documents")
        assert database.tables["stripe_owner_payout_accounts"][0]["stripe_account_id"] == "acct_1"
        assert len(provider.accounts) == 1
    assert database.tables["scope_commerce_seller_accounts"] == [binding]


async def test_binding_lookup_failure_refuses_provider_creation(world, monkeypatch):
    service, database, provider = world

    def fail(*_):
        raise RuntimeError("private database diagnostic")

    monkeypatch.setattr(database, "execute_raw", fail)
    with pytest.raises(PacketOrderError, match="Could not start payout setup"):
        await service.onboarding_link(user_id="owner", surface="documents")
    assert not provider.accounts and not provider.links


@pytest.mark.parametrize("phase", ["existing", "creation", "insert_race"])
async def test_document_reuse_cannot_bypass_financial_source_check(world, monkeypatch, phase):
    service, database, provider = world
    binding = {"user_id": "other", "livemode": False, "account_id": "acct_1"}
    if phase == "existing":
        await service.onboarding_link(user_id="owner", surface="documents")
        database.tables["scope_commerce_seller_accounts"] = [binding]
    elif phase == "creation":
        original_create = provider.Account.create

        def create(**kwargs):
            database.tables["scope_commerce_seller_accounts"] = [binding]
            return original_create(**kwargs)

        monkeypatch.setattr(provider.Account, "create", create)
    else:
        original_rows = service._rows

        async def insert_race(query):
            if (
                query.op == "insert"
                and query.store is database.tables["stripe_owner_payout_accounts"]
            ):
                query.store.append(
                    {"user_id": "owner", "stripe_mode": "test", "stripe_account_id": "acct_1"}
                )
                database.tables["scope_commerce_seller_accounts"] = [binding]
                raise RuntimeError("concurrent binding")
            return await original_rows(query)

        monkeypatch.setattr(service, "_rows", insert_race)
    prior_links = len(provider.links)
    with pytest.raises(PacketOrderError):
        await service.onboarding_link(user_id="owner", surface="documents")
    assert len(provider.links) == prior_links
    assert database.tables["scope_commerce_seller_accounts"] == [binding]


@pytest.mark.asyncio
@pytest.mark.parametrize("document_mode,conflict", [("test", True), ("live", False)])
async def test_scope_binding_cannot_adopt_document_account(
    provider_postgres, document_mode, conflict
):
    store, pool = provider_postgres
    adapter = _FinancialAdapter()
    service = _payout_service(store, adapter)
    async with pool.acquire() as connection:
        await _document_table(connection)
        await connection.execute(
            "INSERT INTO stripe_owner_payout_accounts(user_id,stripe_mode,stripe_account_id) VALUES('owner',$1,'acct_scope')",
            document_mode,
        )
        await connection.execute(
            "INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode) VALUES('owner','acct_scope','US',false)"
        )
    if conflict:
        with pytest.raises(CommerceProviderError, match="provider_account_source_conflict"):
            await service._prepare_seller_account(user_id="owner", country="US")
    else:
        assert (await service._prepare_seller_account(user_id="owner", country="US"))[
            "account_id"
        ] == "acct_scope"
    assert adapter.created == 0


@pytest.mark.parametrize(
    "first_source,second_mode,second_account,conflict",
    [
        ("scope", "test", "acct_race", True),
        ("document", "test", "acct_race", True),
        ("scope", "live", "acct_race", False),
        ("document", "test", "acct_separate", False),
    ],
)
async def test_cross_source_binding_race_is_serialized(
    provider_postgres, first_source, second_mode, second_account, conflict
):
    import asyncpg

    _store, pool = provider_postgres
    async with pool.acquire() as first, pool.acquire() as second:
        await _document_table(first)
        await first.execute((MIGRATIONS / "406_stripe_payout_source_binding.sql").read_text())
        transaction = first.transaction()
        await transaction.start()
        second_source = "document" if first_source == "scope" else "scope"
        pending = None
        try:
            await first.execute(_binding_insert(first_source), "first", "acct_race", "test")
            pending = asyncio.create_task(
                second.execute(_binding_insert(second_source), "other", second_account, second_mode)
            )
            if second_account == "acct_race":
                async with pool.acquire() as observer:
                    for _ in range(100):
                        if await observer.fetchval(
                            "SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1",
                            second.get_server_pid(),
                        ):
                            break
                        await asyncio.sleep(0.01)
                    else:
                        pytest.fail("The competing source did not wait for account admission")
            await transaction.commit()
            if conflict:
                with pytest.raises(
                    asyncpg.CheckViolationError, match="payout_financial_source_conflict"
                ):
                    await pending
            else:
                await pending
        finally:
            if first.is_in_transaction():
                await transaction.rollback()
            if pending is not None and not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
        rows = await first.fetchval(
            "SELECT (SELECT count(*) FROM stripe_owner_payout_accounts) + (SELECT count(*) FROM scope_commerce_seller_accounts)"
        )
        assert rows == (1 if conflict else 2)


@pytest.mark.parametrize("isolation", ["repeatable_read", "serializable"])
async def test_binding_admission_refuses_stale_snapshot_isolation(provider_postgres, isolation):
    import asyncpg

    _store, pool = provider_postgres
    async with pool.acquire() as connection:
        await _document_table(connection)
        await connection.execute((MIGRATIONS / "406_stripe_payout_source_binding.sql").read_text())
        with pytest.raises(
            asyncpg.InvalidTransactionStateError, match="payout_binding_isolation_unsupported"
        ):
            async with connection.transaction(isolation=isolation):
                await connection.execute(_binding_insert("scope"), "owner", "acct_stale", "test")
        assert await connection.fetchval("SELECT count(*) FROM scope_commerce_seller_accounts") == 0


async def test_binding_guard_install_and_rollback_preserve_historical_accounts(provider_postgres):
    _store, pool = provider_postgres
    async with pool.acquire() as connection:
        await _document_table(connection)
        await connection.execute(_binding_insert("scope"), "owner", "acct_historical", "test")
        await connection.execute(_binding_insert("document"), "owner", "acct_historical", "test")
        tables = ("scope_commerce_seller_accounts", "stripe_owner_payout_accounts")
        before = [await connection.fetch(f"SELECT * FROM {table}") for table in tables]  # noqa: S608 -- Authored table constants only.
        await connection.execute((MIGRATIONS / "406_stripe_payout_source_binding.sql").read_text())
        await connection.execute((MIGRATIONS / "406_stripe_payout_source_binding.sql").read_text())
        # Erasure archives existing routing before detaching its owner binding.
        await connection.execute(
            "INSERT INTO scope_commerce_sellers(seller_id,owner_user_id) VALUES(gen_random_uuid(),'owner')"
        )
        await _store.erase_account("owner")
        retained = await connection.fetchrow("SELECT * FROM scope_commerce_sellers")
        assert retained["owner_user_id"] is None and retained["account_id"] == "acct_historical"
        assert retained["erased_at"] is not None
        assert await connection.fetch("SELECT * FROM stripe_owner_payout_accounts") == before[1]
        # Restore only this synthetic test binding to compare rollback preservation.
        await connection.execute("DELETE FROM scope_commerce_sellers")
        await connection.execute(_binding_insert("scope"), "other", "acct_rollback", "test")
        before = [await connection.fetch(f"SELECT * FROM {table}") for table in tables]  # noqa: S608 -- Authored table constants only.
        await connection.execute(
            (MIGRATIONS / "rollback/406_stripe_payout_source_binding.rollback.sql").read_text()
        )
        after = [await connection.fetch(f"SELECT * FROM {table}") for table in tables]  # noqa: S608 -- Authored table constants only.
        assert after == before


@pytest.mark.parametrize("mode", [False, None])
async def test_erased_scope_attribution_cannot_be_adopted_by_document_payouts(
    provider_postgres, mode
):
    import asyncpg

    _store, pool = provider_postgres
    async with pool.acquire() as connection:
        await _document_table(connection)
        await connection.execute((MIGRATIONS / "406_stripe_payout_source_binding.sql").read_text())
        await connection.execute(
            "INSERT INTO scope_commerce_sellers(seller_id,owner_user_id,erased_at,account_id,livemode) VALUES(gen_random_uuid(),NULL,clock_timestamp(),'acct_erased',$1)",
            mode,
        )
        assert await connection.fetchval(
            "SELECT scope_commerce_payout_account_claims_v1('new_owner',false,'acct_erased')"
        ) == ["acct_erased"]
        with pytest.raises(asyncpg.CheckViolationError, match="payout_financial_source_conflict"):
            await connection.execute(
                _binding_insert("document"), "new_owner", "acct_erased", "test"
            )
        assert await connection.fetchval("SELECT count(*) FROM scope_commerce_sellers") == 1


async def test_policy_filtered_binding_reads_and_writes_fail_closed(provider_postgres):
    from uuid import uuid4

    import asyncpg

    _store, pool = provider_postgres
    role = "payout_rls_" + uuid4().hex
    async with pool.acquire() as connection:
        schema = await connection.fetchval("SELECT current_schema()")
        await _document_table(connection)
        await connection.execute(_binding_insert("document"), "other", "acct_hidden", "test")
        await connection.execute((MIGRATIONS / "406_stripe_payout_source_binding.sql").read_text())
        await connection.execute(
            "ALTER TABLE stripe_owner_payout_accounts ENABLE ROW LEVEL SECURITY"
        )
        await connection.execute(f'CREATE ROLE "{role}"')  # noqa: S608 -- Generated identifier, never owner input.
        try:
            await connection.execute(f'GRANT USAGE ON SCHEMA "{schema}" TO "{role}"')  # noqa: S608 -- Test-generated identifiers.
            await connection.execute(
                f'GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA "{schema}" TO "{role}"'
            )  # noqa: S608 -- Test-generated identifiers.
            await connection.execute(f'SET ROLE "{role}"')  # noqa: S608 -- Test-generated identifier.
            assert (
                await connection.fetchval("SELECT count(*) FROM stripe_owner_payout_accounts") == 0
            )
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await connection.execute(_binding_insert("scope"), "owner", "acct_hidden", "test")
            await connection.execute("RESET ROLE")
            await connection.execute(
                "ALTER TABLE scope_commerce_seller_accounts ENABLE ROW LEVEL SECURITY"
            )
            await connection.execute(f'SET ROLE "{role}"')  # noqa: S608 -- Test-generated identifier.
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await connection.fetchval(
                    "SELECT scope_commerce_payout_account_claims_v1('owner',false,'acct_hidden')"
                )
        finally:
            await connection.execute("RESET ROLE")
            await connection.execute(f'DROP OWNED BY "{role}"')  # noqa: S608 -- Test-generated identifier.
            await connection.execute(f'DROP ROLE "{role}"')  # noqa: S608 -- Test-generated identifier.
        assert await connection.fetchval("SELECT count(*) FROM scope_commerce_seller_accounts") == 0
