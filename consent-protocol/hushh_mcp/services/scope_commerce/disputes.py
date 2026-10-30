"""Disputes capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from .domain import (
    MAX_CENTS,
    MICRO_PER_CENT,
    CommerceError,
    account,
    fingerprint,
    integer,
)


class FundingDisputes:
    async def freeze_funding_dispute(self, *, charge_id, dispute_id, amount_cents, conn=None):
        integer(amount_cents, 1, MAX_CENTS, "invalid_dispute_amount")

        async def operation(c):
            source = await self._row(
                c,
                "SELECT * FROM scope_commerce_funding_lots WHERE charge_id=$1 FOR UPDATE",
                charge_id,
            )
            if not source:
                raise CommerceError("funding_unavailable")
            if amount_cents * MICRO_PER_CENT > source["gross_micro_usd"]:
                raise CommerceError("dispute_amount_mismatch")
            if await c.fetchval(
                "SELECT EXISTS(SELECT 1 FROM scope_commerce_financial_events WHERE event_id=$1 AND reference_id=$2)",
                f"dispute_won:{dispute_id}",
                str(source["lot_id"]),
            ):
                return {"status": "released"}
            key = f"dispute:{dispute_id}"
            digest = fingerprint([charge_id, amount_cents])
            previous = await self._row(
                c, "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1", key
            )
            if previous:
                if previous["request_hash"] != digest:
                    raise CommerceError("provider_event_conflict")
                return {"status": "frozen"}
            lots = await c.fetch(
                "SELECT * FROM scope_commerce_funding_lots WHERE lot_id=$1 OR source_lot_id=$1 FOR UPDATE",
                source["lot_id"],
            )
            freeze = sum(lot["available_micro_usd"] for lot in lots if not lot["frozen"])
            await c.execute(
                "UPDATE scope_commerce_funding_lots SET frozen=TRUE WHERE lot_id=$1 OR source_lot_id=$1",
                source["lot_id"],
            )
            await self._post(
                c,
                key,
                "funding_dispute_freeze",
                {
                    account("wallet_available", source["wallet_id"]): -freeze,
                    account("wallet_frozen", source["wallet_id"]): freeze,
                },
                dispute_id,
            )
            await c.execute(
                "INSERT INTO scope_commerce_financial_events(event_id,kind,reference_id,request_hash) VALUES($1,'dispute',$2,$3)",
                key,
                str(source["lot_id"]),
                digest,
            )
            # Provider debits and recovery are separate from access revocation.
            # Do not invent a successful transfer reversal or bank recovery.
            await c.execute(
                "INSERT INTO scope_commerce_obligations(obligation_id,kind,wallet_id,funding_lot_id,amount_micro_usd,status,idempotency_key,source_id) VALUES($1,'recovery',$2,$3,$4,'manual_review',$5,$6)",
                uuid4(),
                source["wallet_id"],
                source["lot_id"],
                amount_cents * MICRO_PER_CENT,
                f"recovery:{dispute_id}",
                dispute_id,
            )
            return {"status": "frozen"}

        return await self._transaction(operation, conn)

    async def release_funding_dispute(self, *, charge_id, dispute_id, conn=None):
        async def operation(c):
            return await self._tx_release_funding_dispute(c, charge_id, dispute_id)

        return await self._transaction(operation, conn)

    async def _tx_release_funding_dispute(self, c: Any, charge_id: Any, dispute_id: Any) -> Any:
        source = await self._row(
            c,
            "SELECT * FROM scope_commerce_funding_lots WHERE charge_id=$1 FOR UPDATE",
            charge_id,
        )
        if not source:
            raise CommerceError("funding_unavailable")
        event_key = f"dispute_won:{dispute_id}"
        existing = await self._row(
            c, "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1", event_key
        )
        if existing and existing["reference_id"] != str(source["lot_id"]):
            raise CommerceError("provider_event_conflict")
        if not existing:
            await c.execute(
                "INSERT INTO scope_commerce_financial_events(event_id,kind,reference_id,request_hash) VALUES($1,'dispute_won',$2,$3)",
                event_key,
                str(source["lot_id"]),
                fingerprint(charge_id),
            )
        hold = await self._row(
            c,
            "SELECT * FROM scope_commerce_obligations WHERE idempotency_key=$1 FOR UPDATE",
            f"recovery:{dispute_id}",
        )
        if not hold or hold["status"] == "succeeded":
            return {"status": "released"}
        other = await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_obligations WHERE funding_lot_id=$1 AND kind='recovery' AND status<>'succeeded' AND obligation_id<>$2)",
            source["lot_id"],
            hold["obligation_id"],
        )
        if not other:
            lots = await c.fetch(
                "SELECT * FROM scope_commerce_funding_lots WHERE lot_id=$1 OR source_lot_id=$1 FOR UPDATE",
                source["lot_id"],
            )
            erased = await c.fetchval(
                "SELECT erased_at IS NOT NULL FROM scope_commerce_wallets WHERE wallet_id=$1",
                source["wallet_id"],
            )
            if not erased:
                amount = sum(lot["available_micro_usd"] for lot in lots if lot["frozen"])
                await self._post(
                    c,
                    f"dispute_release:{dispute_id}",
                    "dispute_release",
                    {
                        account("wallet_frozen", source["wallet_id"]): -amount,
                        account("wallet_available", source["wallet_id"]): amount,
                    },
                    dispute_id,
                )
                await c.execute(
                    "UPDATE scope_commerce_funding_lots SET frozen=FALSE WHERE lot_id=$1 OR source_lot_id=$1",
                    source["lot_id"],
                )
        await c.execute(
            "UPDATE scope_commerce_obligations SET status='succeeded' WHERE obligation_id=$1",
            hold["obligation_id"],
        )
        await self._restore_won_dispute_earnings(c, dispute_id)
        return {"status": "released"}

    async def _restore_won_dispute_earnings(self, c: Any, dispute_id: str):
        recovered = await c.fetch(
            "SELECT * FROM scope_commerce_transfer_recoveries WHERE dispute_id=$1 AND recovered_micro_usd>0 AND restored_at IS NULL FOR UPDATE",
            dispute_id,
        )
        for recovery in recovered:
            amount = recovery["recovered_micro_usd"]
            await self._post(
                c,
                f"dispute_owner_restore:{recovery['recovery_id']}",
                "dispute_owner_restore",
                {
                    account("dispute_recovered", recovery["seller_id"]): -amount,
                    account("seller_payable", recovery["seller_id"]): amount,
                },
                recovery["recovery_id"],
            )
            await c.execute(
                "UPDATE scope_commerce_transfer_recoveries SET restored_at=clock_timestamp() WHERE recovery_id=$1",
                recovery["recovery_id"],
            )
            await c.execute(
                "UPDATE scope_commerce_withdrawals SET settled_micro_usd=GREATEST(0,COALESCE(settled_micro_usd,gross_micro_usd)-$2) WHERE withdrawal_id=$1",
                recovery["withdrawal_id"],
                amount,
            )
