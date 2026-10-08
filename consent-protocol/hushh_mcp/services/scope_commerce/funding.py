"""Funding capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from .domain import (
    MAX_CENTS,
    MICRO_PER_CENT,
    CommerceError,
    account,
    fingerprint,
    integer,
)


class FundingAdmission:
    async def reserve_funding(
        self, *, payer_user_id, buyer_app_id="shared", funding_id, amount_cents, conn=None
    ):
        self._admit()
        integer(amount_cents, 50, MAX_CENTS, "invalid_funding_amount")

        async def operation(c):
            await self._environment(c)
            wallet = await self._wallet(c, payer_user_id, buyer_app_id)
            old = await self._row(
                c,
                "SELECT * FROM scope_commerce_fundings WHERE funding_id=$1 FOR UPDATE",
                UUID(str(funding_id)),
            )
            if old:
                if old["wallet_id"] != wallet["wallet_id"] or old["amount_cents"] != amount_cents:
                    raise CommerceError("idempotency_conflict")
                return {
                    "fundingId": str(old["funding_id"]),
                    "amountCents": amount_cents,
                    "status": old["status"],
                }
            liabilities = sum(
                [
                    await self._amount(c, account(kind, wallet["wallet_id"]))
                    for kind in ("wallet_available", "wallet_reserved", "wallet_frozen")
                ]
            )
            # Unvested purchase principal can still return to this wallet.
            # Include it so refunds cannot overflow the consumer balance cap.
            returnable = await c.fetchval(
                "SELECT COALESCE(sum(price_cents),0)::bigint FROM scope_commerce_purchases WHERE wallet_id=$1 AND status='staged' AND earnings_settled_at IS NULL",
                wallet["wallet_id"],
            )
            pending = await c.fetchval(
                "SELECT COALESCE(sum(amount_cents),0)::bigint FROM scope_commerce_fundings WHERE wallet_id=$1 AND status='reserved'",
                wallet["wallet_id"],
            )
            refund_holds = await c.fetchval(
                "SELECT COALESCE(sum(amount_micro_usd),0)::bigint FROM scope_commerce_obligations WHERE wallet_id=$1 AND kind='source_refund' AND status NOT IN ('succeeded','failed')",
                wallet["wallet_id"],
            )
            if (
                liabilities + refund_holds + (pending + amount_cents + returnable) * MICRO_PER_CENT
                > MAX_CENTS * MICRO_PER_CENT
            ):
                raise CommerceError("balance_cap_exceeded")
            await c.execute(
                "INSERT INTO scope_commerce_fundings VALUES($1,$2,$3,'reserved',clock_timestamp())",
                UUID(str(funding_id)),
                wallet["wallet_id"],
                amount_cents,
            )
            return {"fundingId": str(funding_id), "amountCents": amount_cents, "status": "reserved"}

        return await self._transaction(operation, conn)

    async def expire_funding(self, *, funding_id, conn=None):
        async def operation(c):
            await c.execute(
                "UPDATE scope_commerce_fundings SET status='cancelled' WHERE funding_id=$1 AND status='reserved'",
                UUID(str(funding_id)),
            )

        return await self._transaction(operation, conn)

    async def cancel_funding(self, *, funding_id, conn=None):
        return await self.expire_funding(funding_id=funding_id, conn=conn)


class FundingReceipts:
    async def settle_funding(
        self,
        *,
        payer_user_id,
        buyer_app_id,
        funding_id,
        payment_intent_id,
        charge_id,
        provider_event_id,
        amount_cents,
        fee_micro_usd,
        balance_transaction_id,
        livemode,
        conn=None,
    ):
        integer(amount_cents, 50, MAX_CENTS, "invalid_funding_amount")
        integer(fee_micro_usd, 0, MAX_CENTS * MICRO_PER_CENT, "invalid_provider_fee")
        if (
            not all((payment_intent_id, charge_id, provider_event_id, balance_transaction_id))
            or type(livemode) is not bool
        ):
            raise CommerceError("verified_funding_receipt_required")
        digest = fingerprint(
            [
                funding_id,
                payment_intent_id,
                charge_id,
                amount_cents,
                fee_micro_usd,
                balance_transaction_id,
                livemode,
            ]
        )

        async def operation(c):
            return await self._tx_settle_funding(
                c,
                payer_user_id,
                funding_id,
                payment_intent_id,
                charge_id,
                provider_event_id,
                amount_cents,
                fee_micro_usd,
                balance_transaction_id,
                livemode,
                digest,
            )

        return await self._transaction(operation, conn)

    async def _tx_settle_funding(
        self,
        c: Any,
        payer_user_id: Any,
        funding_id: Any,
        payment_intent_id: Any,
        charge_id: Any,
        provider_event_id: Any,
        amount_cents: Any,
        fee_micro_usd: Any,
        balance_transaction_id: Any,
        livemode: Any,
        digest: Any,
    ) -> Any:
        await self._environment(c, livemode=livemode)
        # Reconciliation remains possible after feature disable/identity
        # erasure; funding was authenticated when it was reserved.
        f = await self._row(
            c,
            "SELECT * FROM scope_commerce_fundings WHERE funding_id=$1 FOR UPDATE",
            UUID(str(funding_id)),
        )
        if not f or f["amount_cents"] != amount_cents:
            raise CommerceError("funding_binding_mismatch")
        wallet = await self._row(
            c,
            "SELECT * FROM scope_commerce_wallets WHERE wallet_id=$1 FOR UPDATE",
            f["wallet_id"],
        )
        if wallet["payer_user_id"] is not None and wallet["payer_user_id"] != payer_user_id:
            raise CommerceError("payer_binding_mismatch")
        previous = await self._row(
            c,
            "SELECT * FROM scope_commerce_financial_events WHERE event_id=$1",
            provider_event_id,
        )
        if previous:
            if previous["request_hash"] != digest:
                raise CommerceError("provider_event_conflict")
            return {"fundingId": str(funding_id), "status": "paid"}
        lot = await self._row(
            c, "SELECT * FROM scope_commerce_funding_lots WHERE funding_id=$1", f["funding_id"]
        )
        if lot:
            if (
                lot["payment_intent_id"] != payment_intent_id
                or lot["charge_id"] != charge_id
                or lot["fee_total_micro_usd"] != fee_micro_usd
            ):
                raise CommerceError("funding_binding_mismatch")
        else:
            await self._credit_funding_lot(
                c,
                f,
                wallet,
                funding_id,
                payment_intent_id,
                charge_id,
                balance_transaction_id,
                amount_cents,
                fee_micro_usd,
                livemode,
            )
        await c.execute(
            "INSERT INTO scope_commerce_financial_events(event_id,kind,reference_id,request_hash) VALUES($1,'funding',$2,$3)",
            provider_event_id,
            str(funding_id),
            digest,
        )
        return {"fundingId": str(funding_id), "status": "paid"}

    async def _credit_funding_lot(
        self,
        c: Any,
        f: dict[str, Any],
        wallet: dict[str, Any],
        funding_id: str,
        payment_intent_id: str,
        charge_id: str,
        balance_transaction_id: str,
        amount_cents: int,
        fee_micro_usd: int,
        livemode: bool,
    ):
        gross = amount_cents * MICRO_PER_CENT
        frozen = wallet["erased_at"] is not None or f["status"] == "cancelled"
        await c.execute(
            """INSERT INTO scope_commerce_funding_lots(lot_id,wallet_id,funding_id,payment_intent_id,charge_id,balance_transaction_id,gross_micro_usd,available_micro_usd,fee_total_micro_usd,fee_remaining_micro_usd,fee_basis_remaining_micro_usd,frozen,livemode)
            VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,$7,$9,$10)""",
            uuid4(),
            f["wallet_id"],
            f["funding_id"],
            payment_intent_id,
            charge_id,
            balance_transaction_id,
            gross,
            fee_micro_usd,
            frozen,
            livemode,
        )
        # Gross consumer credit, fee expense initially held as allocated
        # funding cost. Sellers reimburse actual costs upon use.
        await self._post(
            c,
            f"funding:{funding_id}",
            "funding",
            {
                account("bank"): -(gross - fee_micro_usd),
                account("unallocated_fees"): -fee_micro_usd,
                account("wallet_frozen" if frozen else "wallet_available", f["wallet_id"]): gross,
            },
            funding_id,
        )
        await c.execute(
            "UPDATE scope_commerce_fundings SET status='paid' WHERE funding_id=$1",
            f["funding_id"],
        )
        if frozen:
            if wallet["erased_at"]:
                await self._reserve_erased_source_refund(
                    funding_id=f["funding_id"],
                    refund_id=uuid4(),
                    amount_cents=amount_cents,
                    conn=c,
                )
            else:
                await self.reserve_funding_refund(
                    user_id=wallet["payer_user_id"],
                    funding_id=f["funding_id"],
                    refund_id=uuid4(),
                    amount_cents=amount_cents,
                    conn=c,
                )
