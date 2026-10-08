"""Money and activation contracts against an explicit isolated PostgreSQL DB.

Never use environment application credentials or db.connection.get_pool here.
Each test owns a disposable schema in the parent-authorized local test database.
"""

from __future__ import annotations

import asyncio
import json
from uuid import UUID, uuid4

import pytest

from hushh_mcp.services.scope_commerce import CommerceError, ScopeCommerceService

from .test_scope_commerce_core_support import commerce_db as commerce_db
from .test_scope_commerce_core_support import fund, matured, purchase, staged


async def test_payout_actual_fee_excess_backing_and_recovery_use_earned_provenance(commerce_db):
    service, pool = commerce_db
    _, refs = await fund(service, 1000)
    await matured(service, pool)
    disabled = ScopeCommerceService(pool, enabled=False, provider_config=service.provider_config)
    withdrawal_id = str(uuid4())
    with pytest.raises(CommerceError, match="payout_preview_changed"):
        await disabled.reserve_withdrawal(
            user_id="owner",
            withdrawal_id=withdrawal_id,
            fee_micro_usd=200000,
            minimum_net_cents=50,
            expected_net_cents=81,
            expected_fee_micro_usd=200000,
        )
    result = await disabled.reserve_withdrawal(
        user_id="owner",
        withdrawal_id=withdrawal_id,
        fee_micro_usd=200000,
        minimum_net_cents=50,
        expected_net_cents=80,
        expected_fee_micro_usd=200000,
    )
    assert result["net_cents"] == 80
    await service.settle_withdrawal(
        withdrawal_id=withdrawal_id, transfer_id="tr_test", status="transferred"
    )
    await service.settle_withdrawal(
        withdrawal_id=withdrawal_id,
        transfer_id="tr_test",
        payout_id="po_test",
        status="succeeded",
        actual_fee_micro_usd=250000,
    )
    assert (await service.earnings(owner_user_id="owner"))["debtCents"] == 5
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 900
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service.treasury_check(available_micro_usd=8950000)
    await service.freeze_funding_dispute(
        charge_id=refs["charge_id"], dispute_id="dp_recovery", amount_cents=1000
    )
    candidates = await service.recovery_candidates("dp_recovery")
    assert len(candidates) == 1 and candidates[0]["amount_cents"] == 100
    await service.settle_transfer_recovery(candidates[0]["recovery_id"], "trr_test", 80)
    await service.settle_transfer_recovery(candidates[0]["recovery_id"], "trr_test", 80)
    assert (await service.recovery_candidates("dp_recovery"))[0]["amount_cents"] == 20
    async with pool.acquire() as c:
        await c.execute(
            "UPDATE scope_commerce_transfer_recoveries SET next_check_at=clock_timestamp()+interval '1 minute'"
        )
    assert await service.recovery_candidates("dp_recovery") == []
    await service.settle_withdrawal(withdrawal_id=withdrawal_id, status="unknown")
    with pytest.raises(CommerceError, match="payout_recovery_overlap"):
        await service.settle_withdrawal(
            withdrawal_id=withdrawal_id, status="reversed", actual_fee_micro_usd=250000
        )
    await service.record_dispute_balance_transaction(
        dispute_id="dp_recovery",
        charge_id=refs["charge_id"],
        balance_transaction_id="txn_dispute",
        amount_micro_usd=-10000000,
        fee_micro_usd=150000,
    )
    await service.record_dispute_balance_transaction(
        dispute_id="dp_recovery",
        charge_id=refs["charge_id"],
        balance_transaction_id="txn_dispute",
        amount_micro_usd=-10000000,
        fee_micro_usd=150000,
    )
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_journal WHERE idempotency_key='dispute_balance:txn_dispute'"
            )
            == 1
        )
        assert await c.fetchval("SELECT sum(micro_usd) FROM scope_commerce_postings") == 0


async def test_failed_transferred_payout_stays_held_until_exact_confirmed_reversal(commerce_db):
    service, pool = commerce_db
    await fund(service, 1000)
    await matured(service, pool)
    withdrawal_id = str(uuid4())
    await service.reserve_withdrawal(
        user_id="owner",
        withdrawal_id=withdrawal_id,
        fee_micro_usd=200000,
        minimum_net_cents=50,
        expected_net_cents=80,
        expected_fee_micro_usd=200000,
    )

    await service.settle_withdrawal(
        withdrawal_id=withdrawal_id, transfer_id="tr_failure", status="transferred"
    )
    failed = await service.settle_withdrawal(
        withdrawal_id=withdrawal_id, transfer_id="tr_failure", status="failed"
    )
    assert failed["status"] == "unknown"
    assert (await service.earnings(owner_user_id="owner"))["withdrawingCents"] == 100
    with pytest.raises(CommerceError, match="transfer_reversal_required"):
        await service.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            transfer_id="tr_failure",
            status="reversed",
            actual_fee_micro_usd=10000,
        )
    async with pool.acquire() as c:
        await c.execute(
            "INSERT INTO scope_commerce_provider_operations(operation_id,kind,request_hash,request_json,status) VALUES($1,'transfer_reversal','receipt',$2::jsonb,'succeeded')",
            uuid4(),
            '{"transfer_id":"tr_other","amount":100}',
        )
    with pytest.raises(CommerceError, match="transfer_reversal_required"):
        await service.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            transfer_id="tr_failure",
            status="reversed",
            actual_fee_micro_usd=10000,
        )
    async with pool.acquire() as c:
        await c.execute(
            "INSERT INTO scope_commerce_provider_operations(operation_id,kind,request_hash,request_json,status) VALUES($1,'transfer_reversal','receipt',$2::jsonb,'succeeded')",
            uuid4(),
            json.dumps(
                {
                    "transfer_id": "tr_failure",
                    "amount": 100,
                    "metadata": {"withdrawal_id": withdrawal_id},
                }
            ),
        )
    for _ in range(2):
        await service.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            transfer_id="tr_failure",
            status="reversed",
            actual_fee_micro_usd=10000,
        )
    assert (await service.earnings(owner_user_id="owner"))["withdrawableCents"] == 99
    with pytest.raises(CommerceError, match="weekly_payout_not_due"):
        await service.reserve_withdrawal(
            user_id="owner",
            withdrawal_id=str(uuid4()),
            fee_micro_usd=200000,
            minimum_net_cents=50,
            scheduled=True,
        )
    # Explicit withdrawal has no scheduled weekly frequency limit.
    await service.reserve_withdrawal(
        user_id="owner",
        withdrawal_id=str(uuid4()),
        fee_micro_usd=200000,
        minimum_net_cents=50,
        expected_net_cents=79,
        expected_fee_micro_usd=200000,
    )


async def test_paid_then_failed_payout_compensates_only_verified_return_minus_retained_cost(
    commerce_db,
):
    service, pool = commerce_db
    await fund(service, 1000)
    await matured(service, pool)
    withdrawal_id = str(uuid4())
    await service.reserve_withdrawal(
        user_id="owner",
        withdrawal_id=withdrawal_id,
        fee_micro_usd=200000,
        minimum_net_cents=50,
        expected_net_cents=80,
        expected_fee_micro_usd=200000,
    )

    await verified_reversal(
        pool, withdrawal_id, 10
    )  # unused fee reserve before the original paid receipt
    await service.settle_withdrawal(
        withdrawal_id=withdrawal_id,
        transfer_id="tr_late",
        payout_id="po_late",
        status="succeeded",
        actual_fee_micro_usd=100000,
    )
    assert (await service.earnings(owner_user_id="owner"))["withdrawableCents"] == 10
    result = await service.settle_withdrawal(
        withdrawal_id=withdrawal_id, transfer_id="tr_late", payout_id="po_late", status="unknown"
    )
    assert result["status"] == "unknown"
    await assert_unknown_paid_backing(service, pool, withdrawal_id)
    # Retained costs must be covered by the verified actual total, not guessed.
    with pytest.raises(CommerceError, match="invalid_retained_payout_fee"):
        await service.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            status="reversed",
            actual_fee_micro_usd=100000,
            retained_payout_fee_micro_usd=150000,
        )
    await verified_reversal(
        pool, withdrawal_id, 74
    )  # a partial return is insufficient for terminal release
    with pytest.raises(CommerceError, match="transfer_reversal_required"):
        await service.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            status="reversed",
            actual_fee_micro_usd=150000,
            retained_payout_fee_micro_usd=150000,
        )
    await verified_reversal(pool, withdrawal_id, 1)
    for _ in range(2):
        await service.settle_withdrawal(
            withdrawal_id=withdrawal_id,
            status="reversed",
            actual_fee_micro_usd=150000,
            retained_payout_fee_micro_usd=150000,
        )
    assert (await service.earnings(owner_user_id="owner"))["withdrawableCents"] == 85
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 900
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_journal WHERE kind='withdrawal_settle'"
            )
            == 1
        )
        assert (
            await c.fetchval(
                "SELECT count(*) FROM scope_commerce_journal WHERE kind='withdrawal_late_failure'"
            )
            == 1
        )
        assert await c.fetchval("SELECT sum(micro_usd) FROM scope_commerce_postings") == 0


async def test_source_refund_reserve_races_spending_and_releases_on_failure(commerce_db):
    service, _ = commerce_db
    funding, _ = await fund(service, 50, 100000)
    q, p = await purchase(service, 50)
    refund_id = str(uuid4())
    results = await asyncio.gather(
        service.reserve_funding_refund(
            user_id="payer", funding_id=funding, refund_id=refund_id, amount_cents=50
        ),
        service.reserve_purchase(
            payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="reserve"
        ),
        return_exceptions=True,
    )
    assert sum(isinstance(r, dict) for r in results) == 1
    if isinstance(results[0], dict):
        await service.settle_funding_refund(
            refund_id=refund_id, provider_refund_id="re_failed", status="failed"
        )
    else:
        await service.revoke_purchase(owner_user_id="owner", purchase_id=p["purchaseId"])
    assert (await service.balance(payer_user_id="payer"))["balanceCents"] == 50


async def verified_reversal(pool, withdrawal_id, amount, transfer="tr_late"):
    async with pool.acquire() as c:
        await c.execute(
            "INSERT INTO scope_commerce_provider_operations(operation_id,kind,request_hash,request_json,status) VALUES($1,'transfer_reversal','verified-receipt',$2::jsonb,'succeeded')",
            uuid4(),
            json.dumps(
                {
                    "transfer_id": transfer,
                    "amount": amount,
                    "metadata": {"withdrawal_id": withdrawal_id},
                }
            ),
        )


async def test_after_activation_revoke_retains_actual_cost_and_returned_credit_has_no_fee(
    commerce_db,
):
    service, pool = commerce_db
    funding_id, _ = await fund(service, 100, 333333)
    q, p = await purchase(service, 100)
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q["quoteId"], idempotency_key="active-term"
    )
    await staged(service, p)
    # Synthetic elapsed financial term; production keeps the original crypto T.
    async with pool.acquire() as c:
        await c.execute(
            "WITH t AS(SELECT clock_timestamp()-interval '1 second' AS v) UPDATE scope_commerce_purchases SET activation_at=t.v,expires_at=t.v+duration_seconds*interval '1 second' FROM t WHERE purchase_id=$1",
            UUID(p["purchaseId"]),
        )
    ended = await service.revoke_purchase(owner_user_id="owner", purchase_id=p["purchaseId"])
    assert 0 < ended["refundedCents"] < 100
    assert await service.funding_fee_conservation() == {"balanced": True, "bad_lot_count": 0}
    assert ended["processingFeeMicroUsd"] == 333333
    assert (await service.earnings(owner_user_id="owner"))["debtCents"] == (
        -ended["netEarningsMicroUsd"] + 9999
    ) // 10000
    balance = await service.balance(payer_user_id="payer")
    assert balance["balanceCents"] == ended["refundedCents"]
    assert [(lot["fundingId"], lot["unusedCents"]) for lot in balance["fundingLots"]] == [
        (funding_id, ended["refundedCents"])
    ]
    q2, p2 = await purchase(service, ended["refundedCents"])
    await service.reserve_purchase(
        payer_user_id="payer", quote_id=q2["quoteId"], idempotency_key="returned-credit"
    )
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT fee_micro_usd FROM scope_commerce_purchases WHERE purchase_id=$1",
                UUID(p2["purchaseId"]),
            )
            == 0
        )
    assert await service.funding_fee_conservation() == {"balanced": True, "bad_lot_count": 0}


async def assert_unknown_paid_backing(service, pool, withdrawal_id):
    # Paid -> unknown has no held seller_withdrawal balance to subtract from
    # platform liabilities. Customer principal and prior returned reserve stay
    # fully backed while bank failure facts are reconciled.
    with pytest.raises(CommerceError, match="treasury_backing_insufficient"):
        await service.treasury_check(available_micro_usd=8099999)
    assert (await service.treasury_check(available_micro_usd=9100000))[
        "restrictedMicroUsd"
    ] == 9100000
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT settled_micro_usd FROM scope_commerce_withdrawals WHERE withdrawal_id=$1",
                UUID(withdrawal_id),
            )
            == 900000
        )


async def test_withdrawal_provenance_is_internal_boolean_not_operation_uuid(commerce_db):
    from hushh_mcp.services.scope_commerce.provider_contracts import _derived_id

    service, pool = commerce_db
    await fund(service, 300)
    await matured(service, pool)
    weekly_shaped_id = _derived_id("owner", "weekly:2026:41")
    manual = dict(
        user_id="owner",
        withdrawal_id=weekly_shaped_id,
        fee_micro_usd=0,
        minimum_net_cents=50,
        expected_net_cents=100,
        expected_fee_micro_usd=0,
    )
    await service.reserve_withdrawal(**manual)
    await service.reserve_withdrawal(**manual, scheduled=True)
    with pytest.raises(CommerceError, match="invalid_payout_schedule"):
        await service.reserve_withdrawal(**manual, scheduled=1)
    async with pool.acquire() as c:
        rows = await c.fetch(
            "SELECT kind FROM scope_commerce_journal WHERE idempotency_key=$1",
            "withdrawal_reserve:" + weekly_shaped_id,
        )
        assert [row["kind"] for row in rows] == ["withdrawal_reserve_manual"]
        await c.execute(
            "INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode,eligible) VALUES('owner2','acct_owner2','US',false,true)"
        )
    await matured(service, pool, owner_user_id="owner2")
    scheduled_id = str(uuid4())
    await service.reserve_withdrawal(
        user_id="owner2",
        withdrawal_id=scheduled_id,
        fee_micro_usd=0,
        minimum_net_cents=50,
        scheduled=True,
    )
    async with pool.acquire() as c:
        assert (
            await c.fetchval(
                "SELECT kind FROM scope_commerce_journal WHERE idempotency_key=$1",
                "withdrawal_reserve:" + scheduled_id,
            )
            == "withdrawal_reserve_weekly"
        )
        assert await c.fetchval("SELECT sum(micro_usd) FROM scope_commerce_postings") == 0
