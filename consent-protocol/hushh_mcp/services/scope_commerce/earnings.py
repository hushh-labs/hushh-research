"""Earnings capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from uuid import UUID, uuid4

from .domain import (
    MICRO_PER_CENT,
    CommerceError,
    account,
    half_up,
    integer,
    public,
    unused_cents,
)


class AccessEarnings:
    async def _release_reservation(self, c, p):
        reservation = await self._row(
            c,
            "SELECT * FROM scope_commerce_reservations WHERE purchase_id=$1 FOR UPDATE",
            p["purchase_id"],
        )
        if not reservation or reservation["status"] != "held":
            return
        allocations = await c.fetch(
            "SELECT a.*,f.frozen FROM scope_commerce_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE purchase_id=$1 ORDER BY lot_id FOR UPDATE OF f",
            p["purchase_id"],
        )
        available, frozen = 0, 0
        for a in allocations:
            await c.execute(
                "UPDATE scope_commerce_funding_lots SET available_micro_usd=available_micro_usd+$2,fee_basis_remaining_micro_usd=fee_basis_remaining_micro_usd+$2,fee_remaining_micro_usd=fee_remaining_micro_usd+$3 WHERE lot_id=$1",
                a["lot_id"],
                a["gross_micro_usd"],
                a["fee_micro_usd"],
            )
            if a["frozen"]:
                frozen += a["gross_micro_usd"]
            else:
                available += a["gross_micro_usd"]
        await self._post(
            c,
            f"release:{p['purchase_id']}",
            "reservation_release",
            {
                account("wallet_reserved", p["wallet_id"]): -(available + frozen),
                account("wallet_available", p["wallet_id"]): available,
                account("wallet_frozen", p["wallet_id"]): frozen,
            },
            p["purchase_id"],
        )
        await c.execute(
            "UPDATE scope_commerce_reservations SET status='released' WHERE purchase_id=$1",
            p["purchase_id"],
        )

    async def _return_access_credit(self, c, p, refund_micro):
        if refund_micro == 0:
            return 0, 0
        allocations = await c.fetch(
            "SELECT a.*,f.source_lot_id,f.frozen,f.livemode FROM scope_commerce_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE purchase_id=$1 ORDER BY f.created_at,a.lot_id",
            p["purchase_id"],
        )
        remaining, basis = refund_micro, p["price_cents"] * MICRO_PER_CENT
        available, frozen = 0, 0
        for a in allocations:
            amount = (
                remaining
                if a["gross_micro_usd"] == basis
                else half_up(remaining * a["gross_micro_usd"], basis)
            )
            remaining -= amount
            basis -= a["gross_micro_usd"]
            if not amount:
                continue
            await c.execute(
                """INSERT INTO scope_commerce_funding_lots(lot_id,source_lot_id,wallet_id,funding_id,gross_micro_usd,available_micro_usd,fee_total_micro_usd,fee_remaining_micro_usd,fee_basis_remaining_micro_usd,frozen,livemode)
            VALUES($1,$2,$3,$4,$5,$5,0,0,$5,$6,$7)""",
                uuid4(),
                a["source_lot_id"] or a["lot_id"],
                p["wallet_id"],
                uuid4(),
                amount,
                a["frozen"],
                a["livemode"],
            )
            if a["frozen"]:
                frozen += amount
            else:
                available += amount
        if remaining:
            raise CommerceError("refund_provenance_mismatch")
        return available, frozen

    async def revoke_purchase(self, *, owner_user_id, purchase_id, conn=None):
        async def operation(c):
            p = await self._row(
                c,
                "SELECT * FROM scope_commerce_purchases WHERE purchase_id=$1 AND owner_user_id=$2 FOR UPDATE",
                UUID(str(purchase_id)),
                owner_user_id,
            )
            if not p:
                raise CommerceError("purchase_unavailable")
            return await self._revoke(c, p)

        return await self._transaction(operation, conn)

    async def _revoke(self, c, p):
        if p["status"] in {"revoked", "expired"}:
            return public(p)
        now = await c.fetchval("SELECT clock_timestamp()")
        refund = 0
        if p["status"] == "staged":
            if now < p["activation_at"]:
                refund = p["price_cents"]
                await self._cancel_armed_purchase(c, p)
            else:
                refund = unused_cents(p["price_cents"], p["activation_at"], p["expires_at"], now)
                await self._settle_earnings(c, p, refund)
        else:
            await self._release_reservation(c, p)
        p = await self._row(
            c,
            "UPDATE scope_commerce_purchases SET status='revoked',refunded_cents=$2,revoked_at=$3,staged_export=NULL WHERE purchase_id=$1 RETURNING *",
            p["purchase_id"],
            refund,
            now,
        )
        return public(p)

    async def _cancel_armed_purchase(self, c, p):
        """Pre-T cancellation restores the original reservation and its fees."""
        gross, fee = p["price_cents"] * MICRO_PER_CENT, p["fee_micro_usd"]
        await self._post(
            c,
            f"cancel_armed:{p['purchase_id']}",
            "armed_cancellation",
            {
                account("wallet_reserved", p["wallet_id"]): gross,
                account("seller_pending", p["seller_id"]): -max(0, gross - fee),
                account("processor_fees"): -fee,
                account("seller_debt", p["seller_id"]): max(0, fee - gross),
            },
            p["purchase_id"],
        )
        await c.execute(
            "UPDATE scope_commerce_reservations SET status='held' WHERE purchase_id=$1 AND status='consumed'",
            p["purchase_id"],
        )
        await self._release_reservation(c, p)
        await c.execute(
            "UPDATE scope_commerce_purchases SET fee_micro_usd=0,earnings_settled_at=clock_timestamp() WHERE purchase_id=$1",
            p["purchase_id"],
        )

    async def _settle_earnings(self, c, p, refund_cents=0):
        if p["earnings_settled_at"]:
            return
        gross, fee = p["price_cents"] * MICRO_PER_CENT, p["fee_micro_usd"]
        refund = refund_cents * MICRO_PER_CENT
        earned = gross - refund
        original_pending = max(0, gross - fee)
        payable = max(0, earned - fee)
        extra_debt = max(0, fee - earned) - max(0, fee - gross)
        available, frozen = await self._return_access_credit(c, p, refund)
        await self._post(
            c,
            f"earnings:{p['purchase_id']}",
            "earnings_settlement",
            {
                account("seller_pending", p["seller_id"]): -original_pending,
                account("seller_payable", p["seller_id"]): payable,
                account("seller_debt", p["seller_id"]): -extra_debt,
                account("wallet_available", p["wallet_id"]): available,
                account("wallet_frozen", p["wallet_id"]): frozen,
            },
            p["purchase_id"],
        )
        await c.execute(
            "UPDATE scope_commerce_purchases SET earnings_settled_at=clock_timestamp(),refunded_cents=$2,staged_export=NULL WHERE purchase_id=$1",
            p["purchase_id"],
            refund_cents,
        )

    async def settle_expired_earnings(self, *, limit=100, conn=None):
        integer(limit, 1, 500, "invalid_worker_limit")

        async def operation(c):
            rows = await c.fetch(
                """SELECT * FROM scope_commerce_purchases p WHERE status='staged' AND expires_at<=clock_timestamp() AND earnings_settled_at IS NULL AND NOT EXISTS(SELECT 1 FROM scope_commerce_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE a.purchase_id=p.purchase_id AND f.frozen) ORDER BY expires_at LIMIT $1 FOR UPDATE""",
                limit,
            )
            for row in rows:
                await self._settle_earnings(c, dict(row))
                await c.execute(
                    "UPDATE scope_commerce_purchases SET status='expired' WHERE purchase_id=$1",
                    row["purchase_id"],
                )
            unfulfilled = await c.fetch(
                "SELECT * FROM scope_commerce_purchases WHERE status IN ('awaiting_payment','reserved','preparing') AND fulfillment_deadline<=clock_timestamp() ORDER BY fulfillment_deadline LIMIT $1 FOR UPDATE",
                limit,
            )
            for row in unfulfilled:
                await self._release_reservation(c, dict(row))
                await c.execute(
                    "UPDATE scope_commerce_purchases SET status='expired',staged_export=NULL WHERE purchase_id=$1",
                    row["purchase_id"],
                )
            return {"settled": len(rows), "expired": len(unfulfilled)}

        return await self._transaction(operation, conn)

    async def earnings(self, *, owner_user_id, conn=None):
        async def operation(c):
            seller = await self._row(
                c, "SELECT * FROM scope_commerce_sellers WHERE owner_user_id=$1", owner_user_id
            )
            if not seller:
                return {
                    "pendingCents": 0,
                    "withdrawableCents": 0,
                    "debtCents": 0,
                    "currency": "usd",
                }
            values = {
                k: await self._amount(c, account(k, seller["seller_id"]))
                for k in ("seller_pending", "seller_payable", "seller_debt", "seller_withdrawal")
            }
            debt = max(0, -values["seller_debt"])
            return {
                "pendingCents": values["seller_pending"] // MICRO_PER_CENT,
                "withdrawableCents": max(0, values["seller_payable"] - debt) // MICRO_PER_CENT,
                "debtCents": (debt + MICRO_PER_CENT - 1) // MICRO_PER_CENT,
                "withdrawingCents": values["seller_withdrawal"] // MICRO_PER_CENT,
                "currency": "usd",
            }

        return await self._transaction(operation, conn)
