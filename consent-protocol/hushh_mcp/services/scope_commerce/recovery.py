"""Recovery capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from .domain import (
    MICRO_PER_CENT,
    CommerceError,
    account,
    fingerprint,
    half_up,
    integer,
    proportional_shares,
)


class WithdrawalProvenance:
    async def _allocate_withdrawal(self, c, withdrawal, debt_micro):
        earnings = await c.fetch(
            "SELECT * FROM scope_commerce_purchases WHERE seller_id=$1 AND earnings_settled_at IS NOT NULL ORDER BY earnings_settled_at,purchase_id FOR UPDATE",
            withdrawal["seller_id"],
        )
        cash_remaining = withdrawal["gross_micro_usd"]
        debt_remaining = debt_micro
        for p in earnings:
            earned = max(
                0, (p["price_cents"] - p["refunded_cents"]) * MICRO_PER_CENT - p["fee_micro_usd"]
            )
            rows = await c.fetch(
                "SELECT a.*,w.gross_micro_usd,w.settled_micro_usd FROM scope_commerce_withdrawal_allocations a JOIN scope_commerce_withdrawals w USING(withdrawal_id) WHERE a.purchase_id=$1",
                p["purchase_id"],
            )
            spent = 0
            for previous in rows:
                spent += previous["debt_micro_usd"]
                effective = (
                    previous["gross_micro_usd"]
                    if previous["settled_micro_usd"] is None
                    else min(previous["gross_micro_usd"], previous["settled_micro_usd"])
                )
                all_parts = await c.fetch(
                    "SELECT purchase_id,amount_micro_usd FROM scope_commerce_withdrawal_allocations WHERE withdrawal_id=$1 ORDER BY purchase_id",
                    previous["withdrawal_id"],
                )
                shares = proportional_shares(
                    effective,
                    [(str(part["purchase_id"]), part["amount_micro_usd"]) for part in all_parts],
                )
                spent += shares[str(p["purchase_id"])]
            available = max(0, earned - spent)
            debt_take = min(available, debt_remaining)
            debt_remaining -= debt_take
            available -= debt_take
            cash_take = min(available, cash_remaining)
            cash_remaining -= cash_take
            if debt_take or cash_take:
                await c.execute(
                    "INSERT INTO scope_commerce_withdrawal_allocations VALUES($1,$2,$3,$4)",
                    withdrawal["withdrawal_id"],
                    p["purchase_id"],
                    cash_take,
                    debt_take,
                )
            if not cash_remaining and not debt_remaining:
                break
        if cash_remaining or debt_remaining:
            raise CommerceError("earnings_provenance_unavailable")


class DisputeRecovery:
    async def recovery_candidates(self, dispute_id, conn=None):
        async def operation(c):
            return await self._tx_recovery_candidates(c, dispute_id)

        return await self._transaction(operation, conn)

    async def _tx_recovery_candidates(self, c: Any, dispute_id: Any) -> Any:
        obligation = await self._row(
            c,
            "SELECT * FROM scope_commerce_obligations WHERE idempotency_key=$1 FOR UPDATE",
            f"recovery:{dispute_id}",
        )
        if not obligation or obligation["status"] == "succeeded":
            return []
        originals = await c.fetch(
            "SELECT * FROM scope_commerce_withdrawals WHERE transfer_id IS NOT NULL AND status<>'failed' ORDER BY created_at,withdrawal_id FOR UPDATE"
        )
        cap = obligation["amount_micro_usd"]
        for withdrawal in originals:
            old = await self._row(
                c,
                "SELECT * FROM scope_commerce_transfer_recoveries WHERE dispute_id=$1 AND withdrawal_id=$2",
                dispute_id,
                withdrawal["withdrawal_id"],
            )
            if old:
                cap -= old["amount_micro_usd"]
                continue
            if cap <= 0:
                break
            attributable = await self._withdrawal_source_attribution(c, withdrawal, obligation)
            amount = min(attributable, cap)
            if amount:
                await c.execute(
                    "INSERT INTO scope_commerce_transfer_recoveries(recovery_id,dispute_id,funding_lot_id,withdrawal_id,seller_id,amount_micro_usd) VALUES($1,$2,$3,$4,$5,$6)",
                    uuid4(),
                    dispute_id,
                    obligation["funding_lot_id"],
                    withdrawal["withdrawal_id"],
                    withdrawal["seller_id"],
                    amount,
                )
                cap -= amount
        rows = await c.fetch(
            "SELECT r.*,w.transfer_id,w.account_id,s.account_id AS seller_account_id FROM scope_commerce_transfer_recoveries r JOIN scope_commerce_withdrawals w USING(withdrawal_id) JOIN scope_commerce_sellers s ON s.seller_id=r.seller_id WHERE r.dispute_id=$1 AND r.recovered_micro_usd<r.amount_micro_usd AND r.next_check_at<=clock_timestamp() ORDER BY r.next_check_at,r.recovery_id",
            dispute_id,
        )
        return [
            {
                "recovery_id": str(r["recovery_id"]),
                "withdrawal_id": str(r["withdrawal_id"]),
                "seller_id": str(r["seller_id"]),
                "transfer_id": r["transfer_id"],
                "account_id": r["account_id"] or r["seller_account_id"],
                "amount_cents": (r["amount_micro_usd"] - r["recovered_micro_usd"])
                // MICRO_PER_CENT,
                "dispute_id": dispute_id,
            }
            for r in rows
            if r["amount_micro_usd"] - r["recovered_micro_usd"] >= MICRO_PER_CENT
        ]

    async def settle_transfer_recovery(
        self, recovery_id, provider_reversal_id, amount_cents, conn=None
    ):
        integer(amount_cents, 1, 100000, "invalid_recovery_amount")
        amount = amount_cents * MICRO_PER_CENT

        async def operation(c):
            r = await self._row(
                c,
                "SELECT * FROM scope_commerce_transfer_recoveries WHERE recovery_id=$1 FOR UPDATE",
                UUID(str(recovery_id)),
            )
            if not r:
                raise CommerceError("recovery_unavailable")
            key = f"transfer_recovery:{provider_reversal_id}"
            old = await self._row(
                c, "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1", key
            )
            digest = fingerprint([recovery_id, amount_cents])
            if old:
                if old["request_hash"] != digest:
                    raise CommerceError("provider_event_conflict")
                return {"recoveredCents": r["recovered_micro_usd"] // MICRO_PER_CENT}
            if amount > r["amount_micro_usd"] - r["recovered_micro_usd"]:
                raise CommerceError("recovery_exceeds_attribution")
            won = await c.fetchval(
                "SELECT EXISTS(SELECT 1 FROM scope_commerce_financial_events WHERE event_id=$1)",
                f"dispute_won:{r['dispute_id']}",
            )
            await self._post(
                c,
                key,
                "transfer_recovery",
                {
                    account("bank"): -amount,
                    account(
                        "seller_payable" if won else "dispute_recovered", r["seller_id"]
                    ): amount,
                },
                recovery_id,
            )
            await c.execute(
                "UPDATE scope_commerce_transfer_recoveries SET recovered_micro_usd=recovered_micro_usd+$2 WHERE recovery_id=$1",
                r["recovery_id"],
                amount,
            )
            if won:
                # A reversal confirmed after terminal win is still real cash.
                # Return that newly recovered principal to its owner once.
                await c.execute(
                    "UPDATE scope_commerce_transfer_recoveries SET restored_at=clock_timestamp() WHERE recovery_id=$1",
                    r["recovery_id"],
                )
                await c.execute(
                    "UPDATE scope_commerce_withdrawals SET settled_micro_usd=GREATEST(0,COALESCE(settled_micro_usd,gross_micro_usd)-$2) WHERE withdrawal_id=$1",
                    r["withdrawal_id"],
                    amount,
                )
            await c.execute(
                "INSERT INTO scope_commerce_financial_events(event_id,kind,reference_id,request_hash) VALUES($1,'transfer_recovery',$2,$3)",
                key,
                str(recovery_id),
                digest,
            )
            return {"recoveredCents": (r["recovered_micro_usd"] + amount) // MICRO_PER_CENT}

        return await self._transaction(operation, conn)

    async def record_dispute_balance_transaction(
        self,
        *,
        dispute_id,
        charge_id,
        balance_transaction_id,
        amount_micro_usd,
        fee_micro_usd=0,
        conn=None,
    ):
        if type(amount_micro_usd) is not int or abs(amount_micro_usd) > 10**18:
            raise CommerceError("invalid_dispute_receipt")
        if type(fee_micro_usd) is not int or abs(fee_micro_usd) > 10**18:
            raise CommerceError("invalid_dispute_fee")

        async def operation(c):
            source = await self._row(
                c, "SELECT lot_id FROM scope_commerce_funding_lots WHERE charge_id=$1", charge_id
            )
            if not source:
                raise CommerceError("funding_unavailable")
            net = amount_micro_usd - fee_micro_usd
            key = f"dispute_balance:{balance_transaction_id}"
            digest = fingerprint([dispute_id, charge_id, amount_micro_usd, fee_micro_usd])
            previous = await self._row(
                c, "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1", key
            )
            if previous and previous["request_hash"] != digest:
                raise CommerceError("provider_event_conflict")
            if not previous:
                await self._post(
                    c,
                    key,
                    "dispute_balance",
                    {account("bank"): -net, account("dispute_cost"): net},
                    dispute_id,
                )
                await c.execute(
                    "INSERT INTO scope_commerce_financial_events(event_id,kind,reference_id,request_hash) VALUES($1,'dispute_balance',$2,$3)",
                    key,
                    dispute_id,
                    digest,
                )
            return {"recorded": True}

        return await self._transaction(operation, conn)

    async def _withdrawal_source_attribution(
        self, c: Any, withdrawal: dict[str, Any], obligation: dict[str, Any]
    ):
        purchase_rows = await c.fetch(
            "SELECT a.*,p.price_cents FROM scope_commerce_withdrawal_allocations a JOIN scope_commerce_purchases p USING(purchase_id) WHERE a.withdrawal_id=$1 ORDER BY purchase_id",
            withdrawal["withdrawal_id"],
        )
        effective = (
            withdrawal["gross_micro_usd"]
            if withdrawal["settled_micro_usd"] is None
            else min(withdrawal["gross_micro_usd"], withdrawal["settled_micro_usd"])
        )
        cash_shares = proportional_shares(
            effective,
            [(str(a["purchase_id"]), a["amount_micro_usd"]) for a in purchase_rows],
        )
        attributable = 0
        for allocation in purchase_rows:
            funding = await c.fetch(
                "SELECT a.*,COALESCE(f.source_lot_id,f.lot_id) AS root_lot FROM scope_commerce_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE a.purchase_id=$1 ORDER BY a.lot_id",
                allocation["purchase_id"],
            )
            positive = [(f, max(0, f["gross_micro_usd"] - f["fee_micro_usd"])) for f in funding]
            basis = sum(weight for _, weight in positive)
            cash = cash_shares[str(allocation["purchase_id"])]
            for f, weight in positive:
                if not weight or not basis:
                    continue
                share = half_up(cash * weight, basis)
                cash -= share
                basis -= weight
                if f["root_lot"] == obligation["funding_lot_id"]:
                    attributable += share
        return attributable
