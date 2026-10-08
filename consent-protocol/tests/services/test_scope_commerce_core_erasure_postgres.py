"""Money and activation contracts against an explicit isolated PostgreSQL DB.

Never use environment application credentials or db.connection.get_pool here.
Each test owns a disposable schema in the parent-authorized local test database.
"""

from __future__ import annotations

import asyncio
import os
from uuid import UUID, uuid4

import pytest

from hushh_mcp.services.scope_commerce import CommerceError, ScopeCommerceService

from .test_scope_commerce_core_support import commerce_db as commerce_db
from .test_scope_commerce_core_support import fund, purchase, staged


async def test_sync_erasure_fails_closed_if_adapter_introduces_real_await(monkeypatch):
    from hushh_mcp.services.scope_commerce.sync_bridge import erase_account_in_transaction

    async def yields_external_io(self, *args, **kwargs):
        await asyncio.sleep(0)

    class ExistingTransaction:
        def in_transaction(self):
            return True

    monkeypatch.setattr(ScopeCommerceService, "erase_account", yields_external_io)
    with pytest.raises(RuntimeError, match="yielded external I/O"):
        erase_account_in_transaction(ExistingTransaction(), "owner")


async def test_reset_preserves_money_and_sync_erasure_joins_outer_transaction(commerce_db):
    service, pool = commerce_db
    async with pool.acquire() as c:
        await c.execute(
            "INSERT INTO scope_commerce_stripe_customers VALUES('payer','cus_payer',false); INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode,eligible) VALUES('payer','acct_payer','US',false,true)"
        )
    await fund(service, 50)
    q, p = await purchase(service, 10)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="confirm"
    )
    await service.erase_account("payer", permanent=False)
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_stripe_customers WHERE user_id='payer'"
            )
            == 1
        )
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_seller_accounts WHERE user_id='payer'"
            )
            == 1
        )
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 50
    assert (await service.lookup_by_request(p["requestId"]))["status"] == "revoked"
    async with pool.acquire() as c:
        schema = await c.fetchval("SELECT current_schema()")
        dsn = os.getenv("SCOPE_COMMERCE_TEST_DSN") or os.environ["ONE_COMMAND_TEST_DATABASE_URL"]

    # Prove the real account_service call shape: an existing async loop plus
    # synchronous SQLAlchemy outer transaction in this same thread.
    erase_then_rollback(dsn, schema)
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 50
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT purpose FROM scope_commerce_quotes WHERE quote_id=$1", UUID(q["quoteId"])
            )
            == "contract test"
        )
        assert not await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_obligations WHERE kind='source_refund')"
        )
    await service.erase_account("payer", permanent=True)
    async with pool.acquire() as c:
        assert not await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_stripe_customers WHERE user_id='payer')"
        )
        assert not await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_seller_accounts WHERE user_id='payer')"
        )
        assert await c.fetchval(
            "SELECT payer_user_id IS NULL AND staged_export IS NULL AND erased_at IS NOT NULL FROM scope_commerce_purchases WHERE purchase_id=$1",
            UUID(p["purchaseId"]),
        )
        assert (
            await c.fetchval(
                "SELECT purpose FROM scope_commerce_quotes WHERE quote_id=$1", UUID(q["quoteId"])
            )
            is None
        )


async def test_dispute_freezes_existing_access_and_erasure_preserves_obligations(commerce_db):
    service, pool = commerce_db
    funding, refs = await fund(service, 50)
    q, p = await purchase(service, 10)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="reserve"
    )
    await staged(service, p)
    await service.freeze_funding_dispute(
        charge_id=refs["charge_id"], dispute_id="dp_test", amount_cents=50
    )
    assert (await service.access_state(purchase_id=p["purchaseId"], buyer_app_id="app"))[
        "status"
    ] == "payment_disputed"
    with pytest.raises(CommerceError, match="funding_disputed"):
        await service.reserve_funding_refund(
            user_id="payer", funding_id=funding, refund_id=str(uuid4()), amount_cents=1
        )
    await service.release_funding_dispute(charge_id=refs["charge_id"], dispute_id="dp_test")
    await service.erase_account("payer")
    async with pool.acquire() as c:
        assert await c.fetchval(
            "SELECT payer_user_id IS NULL AND staged_export IS NULL AND erased_at IS NOT NULL FROM scope_commerce_purchases WHERE purchase_id=$1",
            UUID(p["purchaseId"]),
        )
        assert await c.fetchval("SELECT count(*) FROM scope_commerce_journal") > 0
        assert not await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_wallets WHERE payer_user_id='payer')"
        )
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_obligations WHERE kind='source_refund'"
            )
            == 1
        )
        assert not await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_postings WHERE account LIKE '%payer%' OR account LIKE '%owner%')"
        )


def erase_then_rollback(dsn, schema):
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url

    from hushh_mcp.services.scope_commerce.sync_bridge import erase_account_in_transaction

    engine = create_engine(make_url(dsn).set(drivername="postgresql+psycopg2"))
    try:
        with engine.connect() as c:
            tx = c.begin()
            c.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            erase_account_in_transaction(c, "payer", permanent=True)
            assert (
                c.execute(
                    text("SELECT count(*) FROM scope_commerce_wallets WHERE payer_user_id='payer'")
                ).scalar()
                == 0
            )
            tx.rollback()
    finally:
        engine.dispose()
