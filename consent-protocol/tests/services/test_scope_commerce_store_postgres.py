"""Money and activation contracts against an explicit isolated PostgreSQL DB.

Never use environment application credentials or db.connection.get_pool here.
Each test owns a disposable schema in the parent-authorized local test database.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import asyncpg
import pytest

from hushh_mcp.services.scope_commerce import CommerceError
from hushh_mcp.services.scope_commerce.domain import allocated_fee, prorated_cents, unused_cents

from .test_scope_commerce_core_support import MIGRATIONS, fund, purchase
from .test_scope_commerce_core_support import commerce_db as commerce_db


def test_exact_money_minimum_rounding_and_fee_conservation():
    assert prorated_cents(1, 90, 1) == 1
    assert prorated_cents(0, 90, 1) == 0
    assert prorated_cents(3, 2, 1) == 2
    with pytest.raises(CommerceError, match="quote_exceeds_limit"):
        prorated_cents(100000, 1, 2)
    fee, basis, total = 333333, 1000000, 0
    for _ in range(100):
        part = allocated_fee(10000, basis, fee)
        total += part
        fee -= part
        basis -= 10000
    assert total == 333333 and fee == basis == 0
    start = datetime(2026, 1, 1, tzinfo=UTC)
    assert unused_cents(1, start, start + timedelta(seconds=60), start + timedelta(seconds=30)) == 1
    assert (
        unused_cents(
            100, start, start + timedelta(seconds=60), start + timedelta(seconds=59, microseconds=1)
        )
        == 0
    )


async def test_postgres_balanced_append_only_with_negative_controls(commerce_db):
    service, pool = commerce_db
    funding, _ = await fund(service)
    async with pool.acquire() as c:
        entry = await c.fetchval(
            "SELECT entry_id FROM scope_commerce_journal WHERE reference_id=$1", funding
        )
        with pytest.raises(asyncpg.CheckViolationError):
            async with c.transaction():
                await c.execute(
                    "UPDATE scope_commerce_postings SET micro_usd=micro_usd+1 WHERE entry_id=$1",
                    entry,
                )
        with pytest.raises(asyncpg.CheckViolationError):
            async with c.transaction():
                await c.execute(
                    "INSERT INTO scope_commerce_postings VALUES($1,'late_a',1),($1,'late_b',-1)",
                    entry,
                )
        with pytest.raises(asyncpg.CheckViolationError):
            async with c.transaction():
                invalid = uuid4()
                await c.execute(
                    "INSERT INTO scope_commerce_journal(entry_id,idempotency_key,kind,reference_id) VALUES($1,'broken','broken','broken')",
                    invalid,
                )
                await c.execute(
                    "INSERT INTO scope_commerce_postings VALUES($1,'a',1),($1,'b',1)", invalid
                )
        # Negative control proves the actual trigger guards the boundary.
        async with c.transaction():
            await c.execute(
                "ALTER TABLE scope_commerce_postings DISABLE TRIGGER scope_commerce_postings_immutable"
            )
            await c.execute(
                "UPDATE scope_commerce_postings SET micro_usd=micro_usd WHERE entry_id=$1", entry
            )
            await c.execute(
                "ALTER TABLE scope_commerce_postings ENABLE TRIGGER scope_commerce_postings_immutable"
            )
        # SQL rollback cannot discard an existing financial obligation.
        with pytest.raises(asyncpg.RaiseError, match="cannot discard"):
            await c.execute(
                (MIGRATIONS / "rollback" / "296_consumer_scope_commerce.rollback.sql").read_text()
            )
        await c.execute("ROLLBACK")
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_journal") > 0


async def test_migration_replay_and_unused_rollback_are_independent(commerce_db):
    _, pool = commerce_db
    async with pool.acquire() as c:
        await c.execute((MIGRATIONS / "296_consumer_scope_commerce.sql").read_text())
        await c.execute(
            (MIGRATIONS / "rollback" / "296_consumer_scope_commerce.rollback.sql").read_text()
        )
        assert await c.fetchval("SELECT to_regclass('scope_commerce_journal')") is None
        assert await c.fetchval("SELECT to_regclass('pkm_manifests')") is not None


async def test_reservation_race_never_double_spends_shared_wallet(commerce_db):
    service, _ = commerce_db
    await fund(service, 50)
    q1, p1 = await purchase(service, 40)
    q2, p2 = await purchase(service, 40)
    results = await asyncio.gather(
        *(
            service.reserve_purchase(
                payer_user_id="payer", quote_id=q["quoteId"], idempotency_key=str(uuid4())
            )
            for q in (q1, q2)
        ),
        return_exceptions=True,
    )
    assert (
        sum(isinstance(r, CommerceError) and r.code == "insufficient_balance" for r in results) == 1
    )
    assert sum(isinstance(r, dict) for r in results) == 1
    balance = await service.balance(payer_user_id="payer")
    assert (balance["balanceCents"], balance["reservedCents"]) == (10, 40)
    good = next(r for r in results if isinstance(r, dict))
    replay = await service.reserve_purchase(
        payer_user_id="payer", quote_id=good["quoteId"], idempotency_key=str(uuid4())
    )
    assert replay["purchaseId"] == good["purchaseId"]
