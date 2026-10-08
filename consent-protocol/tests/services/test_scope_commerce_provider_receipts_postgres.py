"""Funding, capital and immutable provider receipts against isolated Postgres."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest

from hushh_mcp.services.scope_commerce.domain import CommerceError
from hushh_mcp.services.scope_commerce.stripe_adapter import (
    CommerceProviderError,
)
from tests.helpers.scope_commerce_provider import (
    _capital_fixture,
    _FinancialAdapter,
    _funding_service,
    _FundingAdapter,
    _payout_service,
    _signed_event,
)
from tests.helpers.scope_commerce_provider_db import _seller_credit
from tests.helpers.scope_commerce_provider_db import provider_postgres as provider_postgres


@pytest.mark.asyncio
async def test_postgres_signed_funding_webhook_credits_once_and_rejects_forged_amount(
    provider_postgres,
):
    store, _pool = provider_postgres
    adapter = _FundingAdapter()
    service = _funding_service(store, adapter)
    funding_id = str(uuid4())
    await service.funding_checkout(
        payer_user_id="payer", buyer_app_id="shared", amount_cents=50, operation_id=funding_id
    )
    async with _pool.acquire() as connection:
        request = json.loads(
            await connection.fetchval(
                "SELECT request_json FROM scope_commerce_provider_operations WHERE operation_id=$1::uuid",
                funding_id,
            )
        )
        assert request["allowed_payment_method_types"] == ["card", "link"]
    assert (await store.balance(payer_user_id="payer"))["balanceCents"] == 0
    session = next(iter(adapter.sessions.values()))
    session.update(status="complete", payment_status="unpaid")
    raw, signature = _signed_event(session)
    assert (await service.process_webhook(payload=raw, signature=signature))[
        "status"
    ] == "processed"
    assert (await store.balance(payer_user_id="payer"))["balanceCents"] == 0
    assert (await service._resume_events(limit=4)) == 0
    session.update(status="complete", payment_status="paid", payment_intent="pi_fixture")
    forged = {**session, "amount_total": 51}
    raw, signature = _signed_event(forged)
    with pytest.raises(CommerceProviderError, match="provider_invalid_event"):
        await service.process_webhook(payload=raw, signature=signature)
    assert (await store.balance(payer_user_id="payer"))["balanceCents"] == 0
    raw, signature = _signed_event(session, event_type="checkout.session.async_payment_succeeded")
    await service.process_webhook(payload=raw, signature=signature)
    await service.process_webhook(payload=raw, signature=signature)
    assert (await store.balance(payer_user_id="payer"))["balanceCents"] == 50
    # Out-of-order failure notices cannot cancel canonically paid funding.
    raw, signature = _signed_event(
        {**session, "payment_status": "unpaid"}, event_type="checkout.session.async_payment_failed"
    )
    await service.process_webhook(payload=raw, signature=signature)
    assert (await store.balance(payer_user_id="payer"))["balanceCents"] == 50
    async with _pool.acquire() as connection:
        assert await connection.fetchval("SELECT status FROM scope_commerce_fundings") == "paid"
        assert (
            await connection.fetchval("SELECT fee_total_micro_usd FROM scope_commerce_funding_lots")
            == 320_000
        )
    assert (await service.reconcile(max_operations=4))["examined"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_status", ["canceled", "requires_payment_method"])
async def test_postgres_async_failure_requires_current_bound_zero_charge_and_recovers_without_event(
    provider_postgres, failed_status
):
    store, pool = provider_postgres
    adapter = _FundingAdapter()
    service = _funding_service(store, adapter)
    funding_id = str(uuid4())
    await service.funding_checkout(
        payer_user_id="payer", buyer_app_id="shared", amount_cents=50, operation_id=funding_id
    )
    session = next(iter(adapter.sessions.values()))
    session.update(status="complete", payment_status="unpaid", payment_intent="pi_failed")
    intent = {
        "id": "pi_failed",
        "object": "payment_intent",
        "amount": 50,
        "amount_received": 0,
        "currency": "usd",
        "livemode": False,
        "customer": session["customer"],
        "metadata": session["metadata"],
        "status": "processing",
        "last_payment_error": None,
    }
    retrieve = adapter.retrieve

    async def current(kind, provider_id, **options):
        return (
            intent.copy()
            if kind == "payment_intent"
            else await retrieve(kind, provider_id, **options)
        )

    adapter.retrieve = current
    raw, signature = _signed_event(session, event_type="checkout.session.async_payment_failed")
    with pytest.raises(CommerceProviderError, match="provider_funding_failure_unconfirmed"):
        await service.process_webhook(payload=raw, signature=signature)
    async with pool.acquire() as connection:
        assert await connection.fetchval("SELECT status FROM scope_commerce_fundings") == "reserved"
    intent.update(status=failed_status, last_payment_error={"code": "fixture_failure"})
    intent["customer"] = "cus_other"
    with pytest.raises(CommerceProviderError, match="provider_invalid_event"):
        await service.process_webhook(payload=raw, signature=signature)
    intent["customer"] = session["customer"]
    assert (await service.process_webhook(payload=raw, signature=signature))[
        "status"
    ] == "processed"
    assert (await service.process_webhook(payload=raw, signature=signature))[
        "status"
    ] == "duplicate"
    async with pool.acquire() as connection:
        assert (
            await connection.fetchval("SELECT status FROM scope_commerce_fundings") == "cancelled"
        )
    assert (await store.balance(payer_user_id="payer"))["balanceCents"] == 0
    # A lost webhook also converges from the exact current failed provider intent.
    other_id = str(uuid4())
    await service.funding_checkout(
        payer_user_id="payer", buyer_app_id="shared", amount_cents=50, operation_id=other_id
    )
    other = list(adapter.sessions.values())[-1]
    other.update(status="complete", payment_status="unpaid", payment_intent="pi_failed")
    intent["metadata"] = other["metadata"]
    assert (await service.reconcile(max_operations=4))["reconciled"] == 1
    async with pool.acquire() as connection:
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM scope_commerce_fundings WHERE status='cancelled'"
            )
            == 2
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("erased", [True, False])
async def test_postgres_erased_funding_refund_drains_without_user_identity(
    provider_postgres, erased
):
    from tests.helpers.scope_commerce_provider_db import _reverse_fixture_capital

    store, pool = provider_postgres
    adapter = _FundingAdapter()
    service = _funding_service(store, adapter)
    funding_id, refund_id = str(uuid4()), str(uuid4())
    await service.funding_checkout(
        payer_user_id="payer", buyer_app_id="shared", amount_cents=50, operation_id=funding_id
    )
    session = next(iter(adapter.sessions.values()))
    session.update(status="complete", payment_status="paid", payment_intent="pi_fixture")
    raw, signature = _signed_event(session)
    await service.process_webhook(payload=raw, signature=signature)
    await _reverse_fixture_capital(pool, service, adapter)

    async def direct_refund():
        return await service.refund_unused_funding(
            payer_user_id="payer",
            buyer_app_id="shared",
            funding_id=funding_id,
            amount_cents=50,
            operation_id=refund_id,
        )

    if erased:
        await store.erase_account("payer")
        assert await service._drain_source_refunds(limit=4) == 0
    else:
        with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
            await direct_refund()
    assert adapter.refunds == {}
    async with pool.acquire() as connection:
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM scope_commerce_provider_operations WHERE kind='refund'"
            )
            == 0
        )
        assert (
            await connection.fetchval(
                "SELECT first_dispatch_at FROM scope_commerce_obligations WHERE kind='source_refund'"
            )
            is None
        )
    capital, _receipts = _capital_fixture(adapter, amount_cents=50)
    raw, signature = _signed_event(capital, event_type="topup.succeeded")
    await service.process_webhook(payload=raw, signature=signature)
    if erased:
        async with pool.acquire() as connection:
            await connection.execute(
                "UPDATE scope_commerce_obligations SET next_check_at=clock_timestamp() WHERE kind='source_refund'"
            )
        assert await service._drain_source_refunds(limit=4) == 1
    else:
        await direct_refund()
        await direct_refund()
    assert await service._drain_source_refunds(limit=4) == 0
    async with pool.acquire() as connection:
        row = await connection.fetchrow(
            "SELECT status,provider_id FROM scope_commerce_obligations WHERE kind='source_refund'"
        )
        assert row["status"] == "succeeded"
        assert row["provider_id"].startswith("re_")
        operation = await connection.fetchrow(
            "SELECT user_id,request_json FROM scope_commerce_provider_operations WHERE kind='refund'"
        )
        assert operation["user_id"] == (None if erased else "payer")
        assert "payer" not in json.loads(operation["request_json"])["metadata"].values()
    assert len(adapter.refunds) == 1


@pytest.mark.asyncio
async def test_postgres_poison_event_does_not_starve_new_receipt_or_lose_first_receipt_time(
    provider_postgres,
):
    store, pool = provider_postgres
    adapter = _FundingAdapter()
    service = _funding_service(store, adapter)
    topup, _transactions = _capital_fixture(adapter)
    poison_id, good_id = "evt_poison", "evt_later"
    async with pool.acquire() as connection:
        await connection.execute(
            """INSERT INTO scope_commerce_provider_events(event_id,event_type,livemode,status,created_at,next_check_at)
            VALUES($1,'topup.succeeded',false,'received',clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days'),
            ($2,'topup.succeeded',false,'received',clock_timestamp(),clock_timestamp())""",
            poison_id,
            good_id,
        )
        original = await connection.fetchval(
            "SELECT created_at FROM scope_commerce_provider_events WHERE event_id=$1", poison_id
        )

    async def retrieve(kind, provider_id, **_options):
        if kind == "event":
            if provider_id == poison_id:
                raise CommerceProviderError("provider_object_unavailable")
            return {
                "id": good_id,
                "type": "topup.succeeded",
                "livemode": False,
                "data": {"object": topup},
            }
        return adapter.topups[provider_id]

    adapter.retrieve = retrieve
    assert await service._resume_events(limit=1) == 0
    assert await service._resume_events(limit=1) == 1
    async with pool.acquire() as connection:
        poison = await connection.fetchrow(
            "SELECT * FROM scope_commerce_provider_events WHERE event_id=$1", poison_id
        )
        assert poison["status"] == "received"
        assert poison["created_at"] == original
        assert poison["next_check_at"] > original
        assert (
            await connection.fetchval(
                "SELECT status FROM scope_commerce_provider_events WHERE event_id=$1", good_id
            )
            == "processed"
        )


@pytest.mark.asyncio
async def test_postgres_capital_replay_and_verified_reversal_preserve_attributed_backing(
    provider_postgres,
):
    store, pool = provider_postgres
    adapter = _FundingAdapter()
    service = _funding_service(store, adapter)
    topup, transactions = _capital_fixture(adapter, amount_cents=200, fee_cents=5)
    raw, signature = _signed_event(topup, event_type="topup.succeeded")
    await service.process_webhook(payload=raw, signature=signature)
    await service.process_webhook(payload=raw, signature=signature)
    async with pool.acquire() as connection:
        assert await store._amount(connection, "bank:platform") == -2_950_000
    topup["status"] = "reversed"
    transactions.append(
        {
            **transactions[0],
            "id": "txn_capital_return",
            "type": "topup_reversal",
            "amount": -200,
            "fee": 0,
            "net": -200,
        }
    )
    raw, signature = _signed_event(topup, event_type="topup.reversed")
    await service.process_webhook(payload=raw, signature=signature)
    await service.process_webhook(payload=raw, signature=signature)
    async with pool.acquire() as connection:
        assert await store._amount(connection, "bank:platform") == -950_000
        assert await store._amount(connection, "platform_capital:platform") == 1_000_000
        assert await store._amount(connection, "platform_capital_cost:platform") == -50_000


@pytest.mark.asyncio
async def test_postgres_payout_cannot_borrow_other_liabilities_or_unattributed_provider_cash(
    provider_postgres,
):
    from tests.helpers.scope_commerce_provider_db import _reverse_fixture_capital

    store, pool = provider_postgres
    await _seller_credit(store)
    adapter = _FinancialAdapter()
    service = _payout_service(store, adapter)
    reservation = await store.reserve_withdrawal(
        user_id="owner",
        withdrawal_id=str(uuid4()),
        fee_micro_usd=200_000,
        minimum_net_cents=50,
        expected_net_cents=80,
        expected_fee_micro_usd=200_000,
    )
    withdrawal_id = reservation["withdrawal_id"]

    async def scarce_balance(**_options):
        return {"livemode": False, "available": [{"currency": "usd", "amount": 100}]}

    adapter.balance = scarce_balance
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service._ensure_withdrawal_transfer(
            user_id="owner",
            withdrawal_id=withdrawal_id,
            reservation=reservation,
            account_id="acct_owner",
            metadata=service._metadata(withdrawal_id, "owner"),
        )
    assert adapter.transfers == {}
    # Aggregate account cash cannot cover a fee deficit after verified capital is reversed.
    await _reverse_fixture_capital(pool, service, adapter)

    async def unrelated_balance(**_options):
        return {"livemode": False, "available": [{"currency": "usd", "amount": 10000}]}

    adapter.balance = unrelated_balance
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service._ensure_withdrawal_transfer(
            user_id="owner",
            withdrawal_id=withdrawal_id,
            reservation=reservation,
            account_id="acct_owner",
            metadata=service._metadata(withdrawal_id, "owner"),
        )
    assert adapter.transfers == {}
