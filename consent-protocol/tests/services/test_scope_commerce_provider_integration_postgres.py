"""Provider settlement and erased-account recovery against isolated Postgres."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from uuid import uuid4

import pytest

from hushh_mcp.services.scope_commerce.domain import CommerceError
from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy
from hushh_mcp.services.scope_commerce.provider_service import (
    ScopeCommerceProviderConfig,
    ScopeCommerceProviderService,
)
from hushh_mcp.services.scope_commerce.stripe_adapter import (
    CommerceProviderError,
)
from tests.helpers.scope_commerce_provider import (
    _FinancialAdapter,
    _funding_service,
    _FundingAdapter,
    _OperationAdapter,
    _payout_service,
    _signed_event,
)
from tests.helpers.scope_commerce_provider_db import _seller_credit
from tests.helpers.scope_commerce_provider_db import provider_postgres as provider_postgres


@pytest.mark.asyncio
async def test_sandbox_funding_budget_serializes_pending_attempts_and_refunds_do_not_reset_it(
    provider_postgres, monkeypatch
):
    monkeypatch.setenv("ENVIRONMENT", "sandbox")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    store, pool = provider_postgres
    adapter = _FundingAdapter()
    service = _funding_service(store, adapter)
    service.config = replace(
        service.config, sandbox_policy=SandboxPolicy("acct_platform", ("owner", "buyer"))
    )
    attempts = [str(uuid4()), str(uuid4())]
    outcomes = await asyncio.gather(
        *[
            service.funding_checkout(
                payer_user_id="buyer", buyer_app_id="shared", amount_cents=1500, operation_id=key
            )
            for key in attempts
        ],
        return_exceptions=True,
    )
    assert sum(isinstance(value, dict) for value in outcomes) == 1
    assert (
        sum(
            isinstance(value, CommerceProviderError)
            and value.code == "provider_sandbox_funding_budget_exceeded"
            for value in outcomes
        )
        == 1
    )
    created = adapter.created
    winning = next(value["fundingId"] for value in outcomes if isinstance(value, dict))
    await service.funding_checkout(
        payer_user_id="buyer", buyer_app_id="shared", amount_cents=1500, operation_id=winning
    )
    assert adapter.created == created
    async with pool.acquire() as connection:
        # Model the canonical terminal refund state; principal returned is not
        # permission for another gross sandbox funding charge.
        await connection.execute(
            "UPDATE scope_commerce_fundings SET status='refunded' WHERE funding_id=$1::uuid",
            winning,
        )
    with pytest.raises(CommerceProviderError, match="provider_sandbox_funding_budget_exceeded"):
        await service.funding_checkout(
            payer_user_id="buyer",
            buyer_app_id="shared",
            amount_cents=501,
            operation_id=str(uuid4()),
        )
    with pytest.raises(CommerceProviderError, match="provider_sandbox_reviewer_required"):
        await service.funding_checkout(
            payer_user_id="outsider",
            buyer_app_id="shared",
            amount_cents=50,
            operation_id=str(uuid4()),
        )
    assert adapter.created == created
    async with pool.acquire() as connection:
        await connection.execute(
            "UPDATE scope_commerce_fundings SET status='cancelled' WHERE funding_id=$1::uuid",
            winning,
        )
    # Only the owning core's provider-confirmed zero-charge cancellation releases allowance.
    await service.funding_checkout(
        payer_user_id="buyer", buyer_app_id="shared", amount_cents=2000, operation_id=str(uuid4())
    )


@pytest.mark.asyncio
async def test_postgres_provider_operation_binding_replay_is_durable(provider_postgres):
    store, pool = provider_postgres
    adapter = _OperationAdapter()
    service = ScopeCommerceProviderService(
        store, adapter=adapter, config=ScopeCommerceProviderConfig()
    )
    operation_id = str(uuid4())
    request = {"metadata": service._metadata(operation_id, "owner")}

    async def run():
        return await service._run_operation(
            user_id="owner",
            operation_id=operation_id,
            kind="customer",
            request=request,
            validate=lambda value: service._validate_object(
                value, object_type="customer", metadata=request["metadata"]
            ),
        )

    await run()
    await run()
    assert adapter.created == 1
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM scope_commerce_provider_operations WHERE status='succeeded'"
            )
            == 1
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome", ["paid", "failed", "failed_returned_fee", "erased_pending", "late_failed"]
)
async def test_postgres_payout_reversal_and_erased_resume_preserve_backing(
    provider_postgres, outcome
):
    store, pool = provider_postgres
    await _seller_credit(store)
    adapter = _FinancialAdapter()
    adapter.payout_status = (
        "pending"
        if outcome == "erased_pending"
        else "failed"
        if outcome.startswith("failed")
        else "paid"
    )
    adapter.returned_payout_fee = 1 if outcome == "failed_returned_fee" else 0
    service = _payout_service(store, adapter)
    preview = await service.preview_withdrawal("owner")
    assert (preview["netCents"], preview["feeMicroUsd"]) == (80, 200_000)
    result = await service.request_withdrawal(
        user_id="owner",
        operation_id=str(uuid4()),
        expected_net_cents=80,
        expected_fee_micro_usd=200_000,
        expected_fee_configuration_ref="fixture-fees",
    )
    if outcome == "erased_pending":
        await store.erase_account("owner")
        next(iter(adapter.payouts.values()))["status"] = "paid"
        assert await service._resume_withdrawals(limit=4) == 1
    if outcome == "late_failed":
        payout = next(iter(adapter.payouts.values()))
        payout.update(status="failed", failure_balance_transaction="txn_failure_" + payout["id"])
        await service._settle_payout(payout, account_id="acct_owner")
        await service._settle_payout(payout, account_id="acct_owner")
    async with pool.acquire() as connection:
        withdrawal = await connection.fetchrow(
            "SELECT * FROM scope_commerce_withdrawals WHERE withdrawal_id=$1::uuid",
            result["withdrawalId"],
        )
        failed = outcome.startswith("failed") or outcome == "late_failed"
        assert withdrawal["status"] == ("failed" if failed else "succeeded")
        seller_id = withdrawal["seller_id"]
        held = await store._amount(connection, f"seller_withdrawal:{seller_id}")
        available = await store._amount(connection, f"seller_payable:{seller_id}")
        bank = await store._amount(connection, "bank:platform")
        assert held == 0
        assert available == (
            980_000 if outcome == "failed_returned_fee" else 970_000 if failed else 170_000
        )
        assert bank == -available - 1_000_000  # Verified operator capital, never customer funds.
    assert len(adapter.reversals) == (2 if outcome == "late_failed" else 1)
    assert await service._resume_withdrawals(limit=4) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_receipt", ["missing", "source"])
async def test_postgres_failed_payout_without_matching_return_stays_held(
    provider_postgres, bad_receipt
):
    store, pool = provider_postgres
    await _seller_credit(store)
    adapter = _FinancialAdapter()
    adapter.payout_status = "failed"
    adapter.bad_failure_receipt = bad_receipt
    service = _payout_service(store, adapter)
    with pytest.raises(CommerceProviderError, match="provider_payout_receipt"):
        await service.request_withdrawal(
            user_id="owner",
            operation_id=str(uuid4()),
            expected_net_cents=80,
            expected_fee_micro_usd=200_000,
            expected_fee_configuration_ref="fixture-fees",
        )
    async with pool.acquire() as connection:
        withdrawal = await connection.fetchrow("SELECT * FROM scope_commerce_withdrawals")
        assert withdrawal["status"] == "unknown"
        assert (
            await store._amount(connection, f"seller_withdrawal:{withdrawal['seller_id']}")
            == 1_000_000
        )
        assert await store._amount(connection, f"seller_payable:{withdrawal['seller_id']}") == 0
    assert adapter.reversals == {}


@pytest.mark.asyncio
async def test_postgres_changed_withdrawal_preview_refuses_money_movement(provider_postgres):
    store, _pool = provider_postgres
    await _seller_credit(store)
    adapter = _FinancialAdapter()
    service = _payout_service(store, adapter)
    preview = await service.preview_withdrawal("owner")
    await _seller_credit(store)
    with pytest.raises(CommerceError, match="payout_preview_changed"):
        await service.request_withdrawal(
            user_id="owner",
            operation_id=str(uuid4()),
            expected_net_cents=preview["netCents"],
            expected_fee_micro_usd=preview["feeMicroUsd"],
        )
    assert adapter.transfers == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("canonical", ["won", "needs_response"])
async def test_postgres_dispute_replays_follow_canonical_status(provider_postgres, canonical):
    store, _pool = provider_postgres
    adapter = _FinancialAdapter()
    service = _funding_service(store, adapter)
    await service.funding_checkout(
        payer_user_id="payer", buyer_app_id="shared", amount_cents=50, operation_id=str(uuid4())
    )
    session = next(iter(adapter.sessions.values()))
    session.update(status="complete", payment_status="paid", payment_intent="pi_fixture")
    raw, signature = _signed_event(session)
    await service.process_webhook(payload=raw, signature=signature)
    adapter.dispute_status = canonical
    adapter.dispute_transactions = {
        "txn_dispute_debit": {
            "id": "txn_dispute_debit",
            "object": "balance_transaction",
            "source": "dp_fixture",
            "currency": "usd",
            "amount": -50,
            "fee": 15,
            "net": -65,
        },
    }
    if canonical == "won":
        adapter.dispute_transactions["txn_dispute_return"] = {
            "id": "txn_dispute_return",
            "object": "balance_transaction",
            "source": "dp_fixture",
            "currency": "usd",
            "amount": 50,
            "fee": 0,
            "net": 50,
        }
    dispute = {
        "id": "dp_fixture",
        "object": "dispute",
        "charge": "ch_pi_fixture",
        "amount": 50,
        "currency": "usd",
        "status": "won",
    }
    for event_type in ("charge.dispute.closed", "charge.dispute.created"):
        raw, signature = _signed_event(dispute, event_type=event_type)
        await service.process_webhook(payload=raw, signature=signature)
    balance = await store.balance(payer_user_id="payer")
    assert balance["frozenCents"] == (0 if canonical == "won" else 50)
    assert balance["balanceCents"] == (50 if canonical == "won" else 0)
    async with _pool.acquire() as connection:
        assert await store._amount(connection, "bank:platform") == (
            -1_030_000 if canonical == "won" else -530_000
        )


@pytest.mark.asyncio
async def test_postgres_dispute_recovers_only_available_attributable_transfers(provider_postgres):
    store, pool = provider_postgres
    source = await _seller_credit(store)
    adapter = _FinancialAdapter()
    service = _payout_service(store, adapter)
    await service.request_withdrawal(
        user_id="owner",
        operation_id=str(uuid4()),
        expected_net_cents=80,
        expected_fee_micro_usd=200_000,
        expected_fee_configuration_ref="fixture-fees",
    )
    await store.freeze_funding_dispute(
        charge_id=source["charge_id"], dispute_id="dp_recovery", amount_cents=100
    )
    adapter.connected_available = 40
    assert await service._drain_transfer_recoveries(limit=4) == 1
    assert await service._drain_transfer_recoveries(limit=4) == 0
    async with pool.acquire() as connection:
        row = await connection.fetchrow("SELECT * FROM scope_commerce_transfer_recoveries")
        assert row["recovered_micro_usd"] == 400_000
        assert row["amount_micro_usd"] > row["recovered_micro_usd"]
        assert await store._amount(connection, "bank:platform") == -1_570_000
        assert (
            await connection.fetchval(
                "SELECT status FROM scope_commerce_obligations WHERE idempotency_key='recovery:dp_recovery'"
            )
            != "succeeded"
        )
    assert len(adapter.reversals) == 2  # Payout fee return, then bounded dispute recovery.


@pytest.mark.asyncio
async def test_postgres_retention_returns_unused_funding_and_pauses_admission(provider_postgres):
    from tests.helpers.scope_commerce_provider_db import (
        _restore_returned_projection,
        _returned_refund_projection,
    )

    store, pool = provider_postgres
    adapter = _FundingAdapter()
    service = _funding_service(store, adapter)
    await service.funding_checkout(
        payer_user_id="payer", buyer_app_id="shared", amount_cents=50, operation_id=str(uuid4())
    )
    session = next(iter(adapter.sessions.values()))
    session.update(status="complete", payment_status="paid", payment_intent="pi_fixture")
    raw, signature = _signed_event(session)
    await service.process_webhook(payload=raw, signature=signature)
    async with pool.acquire() as connection:
        await connection.execute(
            "UPDATE scope_commerce_funding_lots SET created_at=clock_timestamp()-interval '731 days'"
        )
    assert await service._retention_sweep(limit=4) == 1
    with pytest.raises(CommerceProviderError, match="provider_retention_resolution_required"):
        await service._admit()
    root, child = await _returned_refund_projection(pool)
    assert await service._retention_sweep(limit=4) == 1
    with pytest.raises(CommerceProviderError, match="provider_retention_resolution_required"):
        await service._admit()
    await _restore_returned_projection(pool, root, child)
    assert await service._drain_source_refunds(limit=4) == 1
    assert await service._retention_sweep(limit=4) == 0
    await service._admit()


@pytest.mark.asyncio
async def test_postgres_retention_batches_reach_later_aged_sellers_and_frozen_roots(
    provider_postgres,
):
    from tests.helpers.scope_commerce_provider_db import _retention_parties

    store, pool = provider_postgres
    aged_sellers, funding_ids = await _retention_parties(store)
    service = _funding_service(store, _FundingAdapter())
    assert await service._retention_sweep(limit=1) == 2
    assert await service._retention_sweep(limit=1) == 2
    async with pool.acquire() as connection:
        keys = set(
            await connection.fetch(
                "SELECT idempotency_key FROM scope_commerce_obligations WHERE source_id='retention'"
            )
        )
        keys = {row["idempotency_key"] for row in keys}
        assert keys == {f"retention:seller:{seller}" for seller in aged_sellers} | {
            f"retention:wallet:{funding}" for funding in funding_ids
        }
    with pytest.raises(CommerceProviderError, match="provider_retention_resolution_required"):
        await service._admit()
