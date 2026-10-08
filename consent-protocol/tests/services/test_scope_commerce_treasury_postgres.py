"""Attributed commerce custody and provider-attested capital boundaries."""

from uuid import UUID, uuid4

import pytest

from hushh_mcp.services.scope_commerce import CommerceError
from hushh_mcp.services.scope_commerce.monitoring import financial_snapshot

from .test_scope_commerce_core_support import commerce_db as commerce_db
from .test_scope_commerce_core_support import fund, matured, purchase, staged


async def test_monitoring_projects_actual_liabilities_and_fee_reserves_without_writes(commerce_db):
    service, pool = commerce_db
    await fund(service, 100, 100000)
    async with pool.acquire() as connection:
        before = await connection.fetchval("SELECT count(*) FROM scope_commerce_journal")
    snapshot = await financial_snapshot(service, receipt_failures=1)
    assert snapshot["liabilities_micro_usd"] == 1000000
    assert snapshot["attributed_backing_micro_usd"] == 900000
    assert snapshot["backing_shortfall_micro_usd"] == 100000
    assert snapshot["unallocated_processing_cost_micro_usd"] == 100000
    assert snapshot["receipt_failures"] == 1
    assert snapshot["unbalanced_journals"] == snapshot["oldest_due_work_seconds"] == 0
    assert all(type(value) is int for value in snapshot.values())
    assert not any("owner" in key or "payer" in key for key in snapshot)
    async with pool.acquire() as connection:
        assert await connection.fetchval("SELECT count(*) FROM scope_commerce_journal") == before
    quote, pending = await purchase(service, 100)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=quote["quoteId"], idempotency_key="overdue-monitoring"
    )
    async with pool.acquire() as connection:
        await connection.execute(
            "UPDATE scope_commerce_purchases SET fulfillment_deadline=clock_timestamp()-INTERVAL '120 seconds' WHERE purchase_id=$1",
            pending["purchaseId"],
        )
    assert (await financial_snapshot(service, receipt_failures=0))["oldest_due_work_seconds"] >= 120


async def test_independent_withdrawals_cannot_spend_same_operating_fee_headroom(commerce_db):
    service, pool = commerce_db
    await fund(service, 300)
    async with pool.acquire() as c:
        await c.execute(
            "INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode,eligible) VALUES('owner2','acct_owner2','US',false,true)"
        )
    await matured(service, pool)
    await matured(service, pool, owner_user_id="owner2")
    await capital(service, "tu_first", 200000)
    await reserve(service, "owner")
    first = await service.treasury_check(available_micro_usd=3200000, fee_reserve_micro_usd=200000)
    assert first["feeReserveMicroUsd"] == 200000
    await reserve(service, "owner2")
    position = await service.treasury_position()
    assert position["operatingFeeReserveMicroUsd"] == 400000
    assert position["backingShortfallMicroUsd"] == 200000
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service.treasury_check(available_micro_usd=10**12, fee_reserve_micro_usd=200000)
    await capital(service, "tu_second", 200000)
    proof = await service.treasury_check(available_micro_usd=3400000, fee_reserve_micro_usd=200000)
    assert proof["feeReserveMicroUsd"] == 400000
    assert proof["backingShortfallMicroUsd"] == 0


async def capital(service, source, amount):
    await service.record_operating_capital_balance_transaction(
        topup_id=source,
        balance_transaction_id="txn_" + source,
        platform_account_id=service.provider_config.platform_account_id,
        livemode=False,
        currency="usd",
        amount_micro_usd=amount,
        fee_micro_usd=0,
        net_micro_usd=amount,
    )


async def reserve(service, owner):
    await service.reserve_withdrawal(
        user_id=owner,
        withdrawal_id=str(uuid4()),
        fee_micro_usd=200000,
        minimum_net_cents=50,
        expected_net_cents=80,
        expected_fee_micro_usd=200000,
    )


async def test_attested_operating_capital_preserves_liabilities_and_exact_signed_cost(commerce_db):
    service, pool = commerce_db
    funding, _ = await fund(service, 50, 100000)
    assert (await service.treasury_position())["backingShortfallMicroUsd"] == 100000
    # Unrelated provider cash cannot cover this commerce funding fee deficit.
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service.treasury_check(available_micro_usd=10**12)
    receipt = {
        "topup_id": "tu_operating",
        "balance_transaction_id": "txn_operating",
        "platform_account_id": service.provider_config.platform_account_id,
        "livemode": False,
        "currency": "usd",
        "amount_micro_usd": 200000,
        "fee_micro_usd": 50000,
        "net_micro_usd": 150000,
    }
    for change, error in (
        ({"net_micro_usd": 150001}, "invalid_operating_capital_amount"),
        ({"amount_micro_usd": 200000.0}, "invalid_operating_capital_amount"),
        ({"currency": "eur"}, "invalid_operating_capital_receipt"),
        ({"platform_account_id": "acct_other"}, "commerce_environment_mismatch"),
        ({"livemode": True}, "commerce_environment_mismatch"),
    ):
        with pytest.raises(CommerceError, match=error):
            await service.record_operating_capital_balance_transaction(**(receipt | change))
    for _ in range(2):
        await service.record_operating_capital_balance_transaction(**receipt)
    assert (await service.treasury_position())["backingShortfallMicroUsd"] == 0
    with pytest.raises(CommerceError, match="idempotency_conflict"):
        await service.record_operating_capital_balance_transaction(
            **(receipt | {"topup_id": "tu_conflict"})
        )
    proof = await service.treasury_check(available_micro_usd=550000, fee_reserve_micro_usd=50000)
    assert proof["attributedMicroUsd"] == 550000
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service.treasury_check(available_micro_usd=10**12, fee_reserve_micro_usd=50001)
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 50
    refund_id = str(uuid4())
    await service.reserve_funding_refund(
        user_id="payer", funding_id=funding, refund_id=refund_id, amount_cents=50
    )
    await service.settle_funding_refund(
        refund_id=refund_id, provider_refund_id="re_unused", status="succeeded"
    )
    await service.record_operating_capital_balance_transaction(
        **(
            receipt
            | {
                "balance_transaction_id": "txn_operating_reversal",
                "amount_micro_usd": -200000,
                "fee_micro_usd": -50000,
                "net_micro_usd": -150000,
            }
        )
    )
    async with pool.acquire() as c:
        assert await service._amount(c, "bank:platform") == 100000
        assert await service._amount(c, "platform_capital:platform") == 0
        assert await service._amount(c, "platform_capital_cost:platform") == 0
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_journal WHERE kind='operating_capital'"
            )
            == 2
        )
        assert await c.fetchval("SELECT sum(micro_usd) FROM scope_commerce_postings") == 0


async def test_refundable_gross_principal_stays_backed_when_seller_pending_is_net(commerce_db):
    service, _ = commerce_db
    await fund(service, 100, 100000)
    q, p = await purchase(service, 100)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="refundable"
    )
    await staged(service, p)
    assert (await service.earnings(owner_user_id="owner"))["pendingCents"] == 90
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service.treasury_check(available_micro_usd=10**12)
    await service.record_operating_capital_balance_transaction(
        topup_id="tu_refundable",
        balance_transaction_id="txn_refundable",
        platform_account_id=service.provider_config.platform_account_id,
        livemode=False,
        currency="usd",
        amount_micro_usd=100000,
        fee_micro_usd=0,
        net_micro_usd=100000,
    )
    proof = await service.treasury_check(available_micro_usd=1000000)
    assert proof["restrictedMicroUsd"] == proof["attributedMicroUsd"] == 1000000
    await service.revoke_purchase(owner_user_id="owner", purchase_id=p["purchaseId"])
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 100
    await service.treasury_check(available_micro_usd=1000000)


async def test_original_funding_fee_conservation_covers_release_and_refund_outcomes(commerce_db):
    service, pool = commerce_db
    funding, _ = await fund(service, 100, 333333)
    balanced = {"balanced": True, "bad_lot_count": 0}
    assert await service.funding_fee_conservation() == balanced
    quote, proposed = await purchase(service, 25)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=quote["quoteId"], idempotency_key="fee-allocation"
    )
    assert await service.funding_fee_conservation() == balanced
    await service.revoke_purchase(owner_user_id="owner", purchase_id=proposed["purchaseId"])
    assert await service.funding_fee_conservation() == balanced
    failed_id = str(uuid4())
    await service.reserve_funding_refund(
        user_id="payer", funding_id=funding, refund_id=failed_id, amount_cents=25
    )
    assert await service.funding_fee_conservation() == balanced
    await service.settle_funding_refund(
        refund_id=failed_id, provider_refund_id="re_failed", status="failed"
    )
    assert await service.funding_fee_conservation() == balanced
    succeeded_id = str(uuid4())
    await service.reserve_funding_refund(
        user_id="payer", funding_id=funding, refund_id=succeeded_id, amount_cents=25
    )
    await service.settle_funding_refund(
        refund_id=succeeded_id, provider_refund_id="re_succeeded", status="succeeded"
    )
    assert await service.funding_fee_conservation() == balanced
    quote2, proposed2 = await purchase(service, 25)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=quote2["quoteId"], idempotency_key="fee-consumed"
    )
    await staged(service, proposed2)
    assert await service.funding_fee_conservation() == balanced
    async with pool.acquire() as c:
        await c.execute(
            "UPDATE scope_commerce_funding_lots SET fee_remaining_micro_usd=fee_remaining_micro_usd+1 WHERE funding_id=$1",
            UUID(funding),
        )
    assert await service.funding_fee_conservation() == {"balanced": False, "bad_lot_count": 1}
