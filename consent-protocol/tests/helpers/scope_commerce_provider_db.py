"""Explicit isolated Postgres fixtures with genuine funding/purchase provenance."""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
import pytest_asyncio

from hushh_mcp.services.scope_commerce.provider_service import (
    CountryPayoutPolicy,
    ScopeCommerceProviderConfig,
)


@pytest_asyncio.fixture
async def provider_postgres():
    """Explicit isolated test DB only; never fall back to an application DSN."""
    dsn = os.getenv("SCOPE_COMMERCE_TEST_DSN")
    if not dsn and os.getenv("ONE_COMMAND_TEST_DATABASE_URL"):
        from sqlalchemy.engine import make_url

        url = make_url(os.environ["ONE_COMMAND_TEST_DATABASE_URL"])
        if (
            url.host not in {"localhost", "127.0.0.1"}
            or url.database != "command_test"
            or url.username != "command_test"
            or url.port not in {None, 5432}
        ):
            pytest.fail("Provider tests refuse a runtime database")
        dsn = url.set(drivername="postgresql").render_as_string(hide_password=False)
    if not dsn:
        if os.getenv("CI", "").lower() in {"true", "1"}:
            pytest.fail("CI requires an explicitly isolated PostgreSQL test database")
        pytest.skip("An explicitly isolated SCOPE_COMMERCE_TEST_DSN is required")
    parsed = urlparse(dsn)
    if (
        parsed.hostname not in {None, "localhost", "127.0.0.1"}
        or parse_qs(parsed.query).get("host", [""])[0] not in {"", "/tmp"}  # noqa: S108 -- Authorized PostgreSQL socket; no file is stored.
        or not (
            parsed.path.lstrip("/").startswith("hushh_scope_commerce_agent_")
            or parsed.path.lstrip("/") == "command_test"
        )
    ):
        pytest.fail("Provider tests refuse a runtime database")
    import asyncpg

    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService

    schema = f"scope_provider_test_{uuid4().hex}"
    admin = await asyncpg.connect(dsn)
    await admin.execute(f'CREATE SCHEMA "{schema}"')
    pool = await asyncpg.create_pool(
        dsn, min_size=1, max_size=3, server_settings={"search_path": schema}
    )
    try:
        async with pool.acquire() as conn:
            migration = (
                Path(__file__).resolve().parents[2]
                / "db/migrations/292_consumer_scope_commerce.sql"
            )
            await conn.execute(
                "CREATE TABLE pkm_manifests(user_id TEXT,domain TEXT,manifest_version INT)"
            )
            await conn.execute(
                "CREATE TABLE pkm_blobs(user_id TEXT,domain TEXT,content_revision INT,manifest_revision INT)"
            )
            await conn.execute(migration.read_text())
        config = ScopeCommerceProviderConfig(
            enabled=True,
            platform_account_id="acct_platform",
            frontend_origin="https://example.test",
            countries={"US": CountryPayoutPolicy(1, 730, 0, 0)},
            fee_configuration_ref="fixture-fees",
        )
        store = ScopeCommerceService(pool=pool, enabled=True, provider_config=config)
        await store.bind_environment(platform_account_id="acct_platform", livemode=False)
        # Verified operator capital supplies routing-fee liquidity. A raw
        # synthetic provider balance never substitutes for attributed cash.
        from tests.helpers.scope_commerce_provider import (
            _capital_fixture,
            _funding_service,
            _FundingAdapter,
            _signed_event,
        )

        adapter = _FundingAdapter()
        capital, _receipts = _capital_fixture(adapter, amount_cents=100)
        raw, signature = _signed_event(capital, event_type="topup.succeeded")
        await _funding_service(store, adapter).process_webhook(payload=raw, signature=signature)
        yield store, pool
    finally:
        await pool.close()
        await admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
        await admin.close()


async def _seller_credit(store, amount_cents=100):
    from hushh_mcp.consent.export_envelope import connector_key_fingerprint

    public_key = base64.b64encode(b"k" * 32).decode()

    async def seed(connection: Any) -> None:
        await _configure_earnings_parties(connection, public_key)

    await store._transaction(seed)
    funding_id = str(uuid4())
    await store.reserve_funding(
        payer_user_id="payer", funding_id=funding_id, amount_cents=amount_cents
    )
    await store.settle_funding(
        payer_user_id="payer",
        buyer_app_id="shared",
        funding_id=funding_id,
        amount_cents=amount_cents,
        payment_intent_id="pi_" + funding_id,
        charge_id="ch_" + funding_id,
        provider_event_id="evt_" + funding_id,
        balance_transaction_id="txn_" + funding_id,
        fee_micro_usd=0,
        livemode=False,
    )
    await store.set_tariff(
        owner_user_id="owner",
        scope_handle="scope_abcdefgh",
        machine_scope="information.test",
        price_cents=amount_cents,
        base_duration_seconds=60,
        idempotency_key=str(uuid4()),
    )
    request_id = "req_" + uuid4().hex
    quote = await store.quote(
        owner_user_id="owner",
        buyer_app_id="app",
        payer_user_id="payer",
        scope_handle="scope_abcdefgh",
        machine_scope="information.test",
        duration_seconds=60,
        recipient_key_fingerprint=connector_key_fingerprint(public_key),
        purpose="provider contract test",
        refresh_policy="snapshot",
        scope_manifest_revision="1",
        request_id=request_id,
        idempotency_key=str(uuid4()),
    )
    purchase = await store.approve_quote(
        owner_user_id="owner", quote_id=quote["quoteId"], request_id=request_id
    )
    await store.reserve_purchase(
        payer_user_id="payer", quote_id=quote["quoteId"], idempotency_key=str(uuid4())
    )

    async def mature(connection: Any) -> None:
        await _mature_earned_fixture(connection, store, purchase, amount_cents)

    await store._transaction(mature)
    return {
        "funding_id": funding_id,
        "charge_id": "ch_" + funding_id,
        "purchase_id": purchase["purchaseId"],
    }


async def _configure_earnings_parties(connection: Any, public_key: str) -> None:
    await connection.execute(
        "CREATE TABLE IF NOT EXISTS developer_apps(app_id TEXT PRIMARY KEY,owner_firebase_uid TEXT,status TEXT)"
    )
    await connection.execute(
        "CREATE TABLE IF NOT EXISTS developer_connector_keys(app_id TEXT,connector_key_id TEXT,connector_public_key TEXT,connector_wrapping_alg TEXT,status TEXT)"
    )
    await connection.execute(
        "INSERT INTO developer_apps VALUES('app','payer','active') ON CONFLICT DO NOTHING"
    )
    if not await connection.fetchval("SELECT EXISTS(SELECT 1 FROM developer_connector_keys)"):
        await connection.execute(
            "INSERT INTO developer_connector_keys VALUES('app','key',$1,'X25519-AES256-GCM','active')",
            public_key,
        )
    await connection.execute("""INSERT INTO scope_commerce_seller_accounts
        (user_id,account_id,country,livemode,eligible) VALUES('owner','acct_owner','US',false,true)
        ON CONFLICT DO NOTHING""")


async def _mature_earned_fixture(
    connection: Any, store: Any, purchase: dict[str, Any], amount_cents: int
) -> None:
    row = await connection.fetchrow(
        "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1::uuid",
        purchase["purchaseId"],
    )
    # Provider tests start at the term-completion boundary. Store activation
    # and crypto authority are covered by their own integration contracts.
    await store._post(
        connection,
        "fixture-mature:" + purchase["purchaseId"],
        "fixture-mature",
        {
            f"wallet_reserved:{row['wallet_id']}": -amount_cents * 10000,
            f"seller_payable:{row['seller_id']}": amount_cents * 10000,
        },
        purchase["purchaseId"],
    )
    await connection.execute(
        "UPDATE scope_commerce_purchases SET status='expired',earnings_settled_at=clock_timestamp() WHERE purchase_id=$1::uuid",
        purchase["purchaseId"],
    )
    await connection.execute(
        "UPDATE scope_commerce_reservations SET status='consumed' WHERE purchase_id=$1::uuid",
        purchase["purchaseId"],
    )


async def _retention_parties(store):
    """Historical append-only earnings and two frozen genuine funding roots."""

    async def sellers(connection):
        result = []
        for owner in ("empty", "fresh", "aged_a", "aged_b"):
            seller = await store._seller(connection, owner)
            await connection.execute(
                "UPDATE scope_commerce_sellers SET country='US',created_at=clock_timestamp()-interval '1000 days' WHERE seller_id=$1",
                seller["seller_id"],
            )
            if owner == "empty":
                continue
            await _append_historical_credit(connection, seller["seller_id"])
            if owner == "fresh":
                await store._post(
                    connection,
                    "fixture-spent",
                    "fixture-spent",
                    {f"seller_payable:{seller['seller_id']}": -100_000, "bank:platform": 100_000},
                    owner,
                )
                await store._post(
                    connection,
                    "fixture-fresh",
                    "fixture-fresh",
                    {f"seller_payable:{seller['seller_id']}": 100_000, "bank:platform": -100_000},
                    owner,
                )
            else:
                result.append(str(seller["seller_id"]))
        return result

    aged = await store._transaction(sellers)
    funding_ids = []
    for _number in range(2):
        funding_id = str(uuid4())
        await store.reserve_funding(payer_user_id="payer", funding_id=funding_id, amount_cents=50)
        await store.settle_funding(
            payer_user_id="payer",
            buyer_app_id="shared",
            funding_id=funding_id,
            amount_cents=50,
            payment_intent_id="pi_" + funding_id,
            charge_id="ch_" + funding_id,
            provider_event_id="evt_" + funding_id,
            balance_transaction_id="txn_" + funding_id,
            fee_micro_usd=0,
            livemode=False,
        )
        await store.freeze_funding_dispute(
            charge_id="ch_" + funding_id, dispute_id="dp_" + funding_id, amount_cents=50
        )
        funding_ids.append(funding_id)

    async def age_roots(connection):
        await connection.execute(
            "UPDATE scope_commerce_funding_lots SET created_at=clock_timestamp()-interval '731 days'"
        )

    await store._transaction(age_roots)
    return aged, funding_ids


async def _append_historical_credit(connection, seller_id):
    entry_id = uuid4()
    # Insert historical evidence at creation, preserving the append-only
    # journal trigger; never update an entry or override the database clock.
    await connection.execute(
        """INSERT INTO scope_commerce_journal(entry_id,idempotency_key,kind,reference_id,created_at)
        VALUES($1,$2,'fixture_historical_earnings',$3,clock_timestamp()-interval '731 days')""",
        entry_id,
        "fixture-history:" + str(seller_id),
        str(seller_id),
    )
    await connection.executemany(
        "INSERT INTO scope_commerce_postings VALUES($1,$2,$3)",
        [(entry_id, f"seller_payable:{seller_id}", 100_000), (entry_id, "bank:platform", -100_000)],
    )


async def _reverse_fixture_capital(pool, service, adapter):
    from tests.helpers.scope_commerce_provider import _capital_fixture, _signed_event

    async with pool.acquire() as connection:
        receipt = await connection.fetchrow(
            "SELECT reference_id,event_id FROM scope_commerce_financial_events WHERE kind='operating_capital'"
        )
    topup, transactions = _capital_fixture(adapter, amount_cents=100, reversed=True)
    topup["id"] = receipt["reference_id"]
    topup["balance_transaction"] = receipt["event_id"].removeprefix("operating_capital:")
    transactions[0]["id"] = topup["balance_transaction"]
    for transaction in transactions:
        transaction["source"] = topup["id"]
    adapter.topups[topup["id"]] = topup
    adapter.capital_transactions[topup["id"]] = transactions
    raw, signature = _signed_event(topup, event_type="topup.reversed")
    await service.process_webhook(payload=raw, signature=signature)


async def _returned_refund_projection(pool):
    """Represent an already-held source refund on a returned child lot."""
    async with pool.acquire() as connection, connection.transaction():
        root = await connection.fetchrow(
            "SELECT * FROM scope_commerce_funding_lots WHERE source_lot_id IS NULL"
        )
        child = uuid4()
        await connection.execute(
            """INSERT INTO scope_commerce_funding_lots
            (lot_id,wallet_id,source_lot_id,funding_id,gross_micro_usd,available_micro_usd,
             fee_total_micro_usd,fee_remaining_micro_usd,fee_basis_remaining_micro_usd,refund_reserved_micro_usd)
            VALUES($1,$2,$3,$4,$5,0,0,0,0,$5)""",
            child,
            root["wallet_id"],
            root["lot_id"],
            uuid4(),
            root["refund_reserved_micro_usd"],
        )
        await connection.execute(
            "UPDATE scope_commerce_funding_lots SET refund_reserved_micro_usd=0 WHERE lot_id=$1",
            root["lot_id"],
        )
        await connection.execute(
            "UPDATE scope_commerce_source_refund_allocations SET lot_id=$2 WHERE lot_id=$1",
            root["lot_id"],
            child,
        )
        return root["lot_id"], child


async def _restore_returned_projection(pool, root, child):
    async with pool.acquire() as connection, connection.transaction():
        await connection.execute(
            "UPDATE scope_commerce_funding_lots SET refund_reserved_micro_usd=(SELECT refund_reserved_micro_usd FROM scope_commerce_funding_lots WHERE lot_id=$2) WHERE lot_id=$1",
            root,
            child,
        )
        await connection.execute(
            "UPDATE scope_commerce_funding_lots SET refund_reserved_micro_usd=0 WHERE lot_id=$1",
            child,
        )
        await connection.execute(
            "UPDATE scope_commerce_source_refund_allocations SET lot_id=$2 WHERE lot_id=$1",
            child,
            root,
        )
