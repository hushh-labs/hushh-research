"""Refunds capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from .domain import (
    MAX_CENTS,
    MICRO_PER_CENT,
    CommerceError,
    account,
    allocated_fee,
    integer,
)


class SourceRefundReservations:
    async def reserve_funding_refund(
        self, *, user_id, funding_id, refund_id, amount_cents, conn=None
    ):
        return await self._reserve_funding_refund(
            user_id=user_id,
            funding_id=funding_id,
            refund_id=refund_id,
            amount_cents=amount_cents,
            conn=conn,
        )

    async def _reserve_erased_source_refund(self, *, funding_id, refund_id, amount_cents, conn):
        """Worker-only reconciliation of an already erased funding identity."""
        return await self._reserve_funding_refund(
            user_id=None,
            funding_id=funding_id,
            refund_id=refund_id,
            amount_cents=amount_cents,
            erased_only=True,
            conn=conn,
        )

    async def _reserve_funding_refund(
        self, *, user_id, funding_id, refund_id, amount_cents, erased_only=False, conn=None
    ):
        integer(amount_cents, 1, MAX_CENTS, "invalid_refund_amount")

        async def operation(c):
            return await self._tx_reserve_funding_refund(
                c, user_id, funding_id, refund_id, amount_cents, erased_only
            )

        return await self._transaction(operation, conn)

    async def _tx_reserve_funding_refund(
        self,
        c: Any,
        user_id: Any,
        funding_id: Any,
        refund_id: Any,
        amount_cents: Any,
        erased_only: Any,
    ) -> Any:
        original = await self._row(
            c,
            "SELECT f.* FROM scope_commerce_funding_lots f JOIN scope_commerce_wallets w USING(wallet_id) WHERE f.funding_id=$1 AND ((NOT $3 AND w.payer_user_id=$2) OR ($3 AND w.erased_at IS NOT NULL)) FOR UPDATE OF f",
            UUID(str(funding_id)),
            user_id,
            erased_only,
        )
        if not original or not original["payment_intent_id"]:
            raise CommerceError("funding_unavailable")
        old = await self._row(
            c,
            "SELECT * FROM scope_commerce_obligations WHERE obligation_id=$1",
            UUID(str(refund_id)),
        )
        amount = amount_cents * MICRO_PER_CENT
        if old:
            if old["funding_lot_id"] != original["lot_id"] or old["amount_micro_usd"] != amount:
                raise CommerceError("idempotency_conflict")
            return {
                "payment_intent_id": original["payment_intent_id"],
                "amount_cents": amount_cents,
                "refund_id": str(refund_id),
            }
        if await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_obligations WHERE funding_lot_id=$1 AND kind='recovery' AND idempotency_key LIKE 'recovery:%' AND status<>'succeeded')",
            original["lot_id"],
        ):
            raise CommerceError("funding_disputed")
        lots = await c.fetch(
            "SELECT * FROM scope_commerce_funding_lots WHERE lot_id=$1 OR source_lot_id=$1 ORDER BY created_at,lot_id FOR UPDATE",
            original["lot_id"],
        )
        if (
            sum(lot["available_micro_usd"] for lot in lots) < amount
            or original["refunded_micro_usd"] + original["refund_reserved_micro_usd"] + amount
            > original["gross_micro_usd"]
        ):
            raise CommerceError("refund_exceeds_unused_funds")
        fee, available, frozen = await self._allocate_source_refund(c, lots, refund_id, amount)
        await c.execute(
            "UPDATE scope_commerce_funding_lots SET refund_reserved_micro_usd=refund_reserved_micro_usd+$2 WHERE lot_id=$1",
            original["lot_id"],
            amount,
        )
        await c.execute(
            "INSERT INTO scope_commerce_obligations(obligation_id,kind,wallet_id,funding_lot_id,amount_micro_usd,fee_micro_usd,status,idempotency_key,source_id) VALUES($1,'source_refund',$2,$3,$4,$5,'queued',$6,$7)",
            UUID(str(refund_id)),
            original["wallet_id"],
            original["lot_id"],
            amount,
            fee,
            f"source_refund:{refund_id}",
            original["payment_intent_id"],
        )
        await self._post(
            c,
            f"source_refund_reserve:{refund_id}",
            "source_refund_reserve",
            {
                account("wallet_available", original["wallet_id"]): -available,
                account("wallet_frozen", original["wallet_id"]): -frozen,
                account("source_refund_hold", refund_id): amount,
            },
            refund_id,
        )
        return {
            "payment_intent_id": original["payment_intent_id"],
            "amount_cents": amount_cents,
            "refund_id": str(refund_id),
        }

    async def _allocate_source_refund(self, c: Any, lots: list[Any], refund_id: str, amount: int):
        remaining, fee, available, frozen = amount, 0, 0, 0
        for lot in lots:
            take = min(remaining, lot["available_micro_usd"])
            if not take:
                continue
            cost = allocated_fee(
                take, lot["fee_basis_remaining_micro_usd"], lot["fee_remaining_micro_usd"]
            )
            await c.execute(
                "UPDATE scope_commerce_funding_lots SET available_micro_usd=available_micro_usd-$2,fee_basis_remaining_micro_usd=fee_basis_remaining_micro_usd-$2,fee_remaining_micro_usd=fee_remaining_micro_usd-$3 WHERE lot_id=$1",
                lot["lot_id"],
                take,
                cost,
            )
            # Refund holds retain provenance for uncertain provider outcomes.
            await c.execute(
                "INSERT INTO scope_commerce_source_refund_allocations(refund_id,lot_id,amount_micro_usd,fee_micro_usd) VALUES($1,$2,$3,$4)",
                UUID(str(refund_id)),
                lot["lot_id"],
                take,
                cost,
            )
            remaining -= take
            fee += cost
            if lot["frozen"]:
                frozen += take
            else:
                available += take
            if not remaining:
                break
        return fee, available, frozen


class SourceRefundReceipts:
    async def settle_funding_refund(self, *, refund_id, provider_refund_id, status, conn=None):
        if status not in {"succeeded", "failed", "pending", "unknown"}:
            raise CommerceError("invalid_provider_status")

        async def operation(c):
            r = await self._row(
                c,
                "SELECT * FROM scope_commerce_obligations WHERE obligation_id=$1 AND kind='source_refund' FOR UPDATE",
                UUID(str(refund_id)),
            )
            if not r:
                raise CommerceError("refund_unavailable")
            if r["provider_id"] and provider_refund_id and r["provider_id"] != provider_refund_id:
                raise CommerceError("refund_provider_conflict")
            if r["status"] in {"succeeded", "failed"}:
                if r["status"] != status:
                    raise CommerceError("refund_terminal_conflict")
                return {"status": status}
            if status == "succeeded":
                await self._post(
                    c,
                    f"source_refund_settle:{refund_id}",
                    "source_refund",
                    {
                        account("source_refund_hold", refund_id): -r["amount_micro_usd"],
                        account("bank"): r["amount_micro_usd"],
                    },
                    refund_id,
                )
                await c.execute(
                    "UPDATE scope_commerce_funding_lots SET refunded_micro_usd=refunded_micro_usd+$2,refund_reserved_micro_usd=refund_reserved_micro_usd-$2 WHERE lot_id=$1",
                    r["funding_lot_id"],
                    r["amount_micro_usd"],
                )
            elif status == "failed":
                lots = await c.fetch(
                    "SELECT a.*,f.frozen FROM scope_commerce_source_refund_allocations a JOIN scope_commerce_funding_lots f USING(lot_id) WHERE refund_id=$1 FOR UPDATE OF f",
                    UUID(str(refund_id)),
                )
                available, frozen = 0, 0
                for lot in lots:
                    await c.execute(
                        "UPDATE scope_commerce_funding_lots SET available_micro_usd=available_micro_usd+$2,fee_basis_remaining_micro_usd=fee_basis_remaining_micro_usd+$2,fee_remaining_micro_usd=fee_remaining_micro_usd+$3 WHERE lot_id=$1",
                        lot["lot_id"],
                        lot["amount_micro_usd"],
                        lot["fee_micro_usd"],
                    )
                    if lot["frozen"]:
                        frozen += lot["amount_micro_usd"]
                    else:
                        available += lot["amount_micro_usd"]
                await self._post(
                    c,
                    f"source_refund_release:{refund_id}",
                    "source_refund_release",
                    {
                        account("source_refund_hold", refund_id): -r["amount_micro_usd"],
                        account("wallet_available", r["wallet_id"]): available,
                        account("wallet_frozen", r["wallet_id"]): frozen,
                    },
                    refund_id,
                )
                await c.execute(
                    "UPDATE scope_commerce_funding_lots SET refund_reserved_micro_usd=refund_reserved_micro_usd-$2 WHERE lot_id=$1",
                    r["funding_lot_id"],
                    r["amount_micro_usd"],
                )
            await c.execute(
                "UPDATE scope_commerce_obligations SET status=$2,provider_id=COALESCE(provider_id,$3) WHERE obligation_id=$1",
                UUID(str(refund_id)),
                status,
                provider_refund_id,
            )
            return {"status": status}

        return await self._transaction(operation, conn)
