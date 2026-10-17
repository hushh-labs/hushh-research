"""Withdrawals capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from .domain import (
    MAX_CENTS,
    MICRO_PER_CENT,
    CommerceError,
    account,
    integer,
    payout_terms,
)


class WithdrawalReservations:
    async def reserve_withdrawal(
        self,
        *,
        user_id,
        withdrawal_id,
        fee_micro_usd,
        minimum_net_cents,
        fee_basis_points=0,
        scheduled=False,
        expected_net_cents=None,
        expected_fee_micro_usd=None,
        conn=None,
    ):
        integer(fee_micro_usd, 0, MAX_CENTS * MICRO_PER_CENT, "invalid_payout_fee")
        integer(fee_basis_points, 0, 10000, "invalid_payout_fee")
        minimum = max(50, integer(minimum_net_cents, 1, MAX_CENTS, "invalid_payout_floor"))

        async def operation(c):
            return await self._tx_reserve_withdrawal(
                c,
                user_id,
                withdrawal_id,
                fee_micro_usd,
                fee_basis_points,
                scheduled,
                expected_net_cents,
                expected_fee_micro_usd,
                minimum,
            )

        return await self._transaction(operation, conn)

    async def _tx_reserve_withdrawal(
        self,
        c: Any,
        user_id: Any,
        withdrawal_id: Any,
        fee_micro_usd: Any,
        fee_basis_points: Any,
        scheduled: bool,
        expected_net_cents: Any,
        expected_fee_micro_usd: Any,
        minimum: Any,
    ) -> Any:
        if type(scheduled) is not bool:
            raise CommerceError("invalid_payout_schedule")
        await self._environment(c, seller_user_id=user_id)
        seller = await self._row(
            c, "SELECT * FROM scope_commerce_sellers WHERE owner_user_id=$1 FOR UPDATE", user_id
        )
        if not seller or seller["erased_at"]:
            raise CommerceError("seller_unavailable")
        old = await self._row(
            c,
            "SELECT * FROM scope_commerce_withdrawals WHERE withdrawal_id=$1 FOR UPDATE",
            UUID(str(withdrawal_id)),
        )
        if old:
            if old["seller_id"] != seller["seller_id"]:
                raise CommerceError("withdrawal_binding_mismatch")
            return self._withdrawal_public(old)
        await self._validate_withdrawal_owner(c, seller, user_id, scheduled)
        payable = await self._amount(c, account("seller_payable", seller["seller_id"]))
        debt = max(0, -await self._amount(c, account("seller_debt", seller["seller_id"])))
        available = max(0, payable - debt)
        terms = payout_terms(available, fee_micro_usd, fee_basis_points, minimum)
        net, fee = terms["net_cents"], terms["fee_micro_usd"]
        if expected_net_cents is not None or expected_fee_micro_usd is not None:
            if expected_net_cents != net or expected_fee_micro_usd != fee:
                raise CommerceError("payout_preview_changed")
        elif not scheduled:
            raise CommerceError("payout_confirmation_required")
        if net < minimum:
            raise CommerceError("payout_below_net_floor")
        gross = net * MICRO_PER_CENT + fee
        if debt:
            await self._post(
                c,
                f"debt_offset:{withdrawal_id}",
                "seller_debt_offset",
                {
                    account("seller_payable", seller["seller_id"]): -debt,
                    account("seller_debt", seller["seller_id"]): debt,
                },
                withdrawal_id,
            )
        await self._post(
            c,
            f"withdrawal_reserve:{withdrawal_id}",
            "withdrawal_reserve_weekly" if scheduled else "withdrawal_reserve_manual",
            {
                account("seller_payable", seller["seller_id"]): -gross,
                account("seller_withdrawal", seller["seller_id"]): gross,
            },
            withdrawal_id,
        )
        row = await self._create_withdrawal_obligation(
            c, user_id, withdrawal_id, seller, debt, net, fee, gross
        )
        return self._withdrawal_public(row)

    @staticmethod
    def _withdrawal_public(row):
        return {
            "withdrawal_id": str(row["withdrawal_id"]),
            "amount_cents": row["net_cents"],
            "net_cents": row["net_cents"],
            "gross_micro_usd": row["gross_micro_usd"],
            "fee_micro_usd": row["fee_micro_usd"],
            "transfer_id": row["transfer_id"],
            "payout_id": row["payout_id"],
            "status": row["status"],
        }

    async def _validate_withdrawal_owner(
        self, c: Any, seller: dict[str, Any], user_id: str, scheduled: bool
    ):
        eligible = await c.fetchval(
            "SELECT eligible FROM scope_commerce_seller_accounts WHERE user_id=$1 FOR SHARE",
            user_id,
        )
        if eligible is not True:
            raise CommerceError("seller_onboarding_required")
        running = await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_withdrawals WHERE seller_id=$1 AND status IN ('queued','transferred','pending','unknown'))",
            seller["seller_id"],
        )
        if running:
            raise CommerceError("withdrawal_already_pending")
        recent = scheduled and await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_withdrawals WHERE seller_id=$1 AND created_at>clock_timestamp()-interval '7 days')",
            seller["seller_id"],
        )
        if recent:
            raise CommerceError("weekly_payout_not_due")
        disputed = await c.fetchval(
            """SELECT EXISTS(SELECT 1 FROM scope_commerce_purchases p JOIN scope_commerce_allocations a USING(purchase_id) JOIN scope_commerce_funding_lots f USING(lot_id) WHERE p.seller_id=$1 AND f.frozen)""",
            seller["seller_id"],
        )
        if disputed:
            raise CommerceError("seller_funds_under_review")

    async def _create_withdrawal_obligation(
        self,
        c: Any,
        user_id: str,
        withdrawal_id: str,
        seller: dict[str, Any],
        debt: int,
        net: int,
        fee: int,
        gross: int,
    ):
        row = await self._row(
            c,
            "INSERT INTO scope_commerce_withdrawals(withdrawal_id,user_id,seller_id,net_cents,gross_micro_usd,fee_micro_usd,status) VALUES($1,$2,$3,$4,$5,$6,'queued') RETURNING *",
            UUID(str(withdrawal_id)),
            user_id,
            seller["seller_id"],
            net,
            gross,
            fee,
        )
        await self._allocate_withdrawal(c, row, debt)
        routing = await self._row(
            c,
            "SELECT account_id,country,livemode FROM scope_commerce_seller_accounts WHERE user_id=$1",
            user_id,
        )
        await c.execute(
            "UPDATE scope_commerce_withdrawals SET account_id=$2,country=$3,livemode=$4 WHERE withdrawal_id=$1",
            row["withdrawal_id"],
            routing["account_id"],
            routing["country"],
            routing["livemode"],
        )
        await c.execute(
            "INSERT INTO scope_commerce_obligations(obligation_id,kind,seller_id,amount_micro_usd,fee_micro_usd,status,idempotency_key) VALUES($1,'transfer',$2,$3,$4,'queued',$5)",
            UUID(str(withdrawal_id)),
            seller["seller_id"],
            net * MICRO_PER_CENT,
            fee,
            f"withdrawal:{withdrawal_id}",
        )
        return row


class WithdrawalReceipts:
    async def settle_withdrawal(
        self,
        *,
        withdrawal_id,
        transfer_id=None,
        payout_id=None,
        status,
        actual_fee_micro_usd=0,
        retained_payout_fee_micro_usd=0,
        conn=None,
    ):
        if status == "payout_pending":
            status = "pending"
        if status not in {"transferred", "pending", "unknown", "succeeded", "failed", "reversed"}:
            raise CommerceError("invalid_provider_status")
        integer(actual_fee_micro_usd, 0, 10**18, "invalid_provider_fee")
        integer(
            retained_payout_fee_micro_usd, 0, actual_fee_micro_usd, "invalid_retained_payout_fee"
        )

        async def operation(c):
            return await self._tx_settle_withdrawal(
                c,
                withdrawal_id,
                transfer_id,
                payout_id,
                status,
                actual_fee_micro_usd,
                retained_payout_fee_micro_usd,
            )

        return await self._transaction(operation, conn)

    async def _tx_settle_withdrawal(
        self,
        c: Any,
        withdrawal_id: Any,
        transfer_id: Any,
        payout_id: Any,
        status: Any,
        actual_fee_micro_usd: Any,
        retained_payout_fee_micro_usd: Any,
    ) -> Any:
        row = await self._row(
            c,
            "SELECT * FROM scope_commerce_withdrawals WHERE withdrawal_id=$1 FOR UPDATE",
            UUID(str(withdrawal_id)),
        )
        if not row:
            raise CommerceError("withdrawal_unavailable")
        for key, value in (("transfer_id", transfer_id), ("payout_id", payout_id)):
            if row[key] and value and row[key] != value:
                raise CommerceError("withdrawal_provider_conflict")
        transfer = transfer_id or row["transfer_id"]
        payout = payout_id or row["payout_id"]
        late_failure = row["status"] == "succeeded" and status in {
            "failed",
            "unknown",
            "reversed",
        }
        if row["status"] in {"succeeded", "failed"} and not late_failure:
            if row["status"] != status and not (row["status"] == "failed" and status == "reversed"):
                raise CommerceError("withdrawal_terminal_conflict")
            return self._withdrawal_public(row)
        if status == "succeeded":
            await self._record_paid_withdrawal(
                c, row, withdrawal_id, transfer, payout, actual_fee_micro_usd
            )
        elif status == "reversed" or (status == "failed" and not transfer):
            await self._record_reversed_withdrawal(
                c, row, withdrawal_id, transfer, actual_fee_micro_usd, retained_payout_fee_micro_usd
            )
            status_value = "failed"
        else:
            status_value = "unknown" if status == "failed" else status
        status_value = (
            "succeeded"
            if status == "succeeded"
            else "failed"
            if status == "reversed" or (status == "failed" and not transfer)
            else status_value
        )
        row = await self._row(
            c,
            "UPDATE scope_commerce_withdrawals SET status=$2,transfer_id=COALESCE(transfer_id,$3),payout_id=COALESCE(payout_id,$4),settled_micro_usd=$5,updated_at=clock_timestamp() WHERE withdrawal_id=$1 RETURNING *",
            UUID(str(withdrawal_id)),
            status_value,
            transfer,
            payout,
            row["net_cents"] * MICRO_PER_CENT + actual_fee_micro_usd
            if status_value == "succeeded"
            else actual_fee_micro_usd
            if status_value == "failed"
            else row["settled_micro_usd"],
        )
        await c.execute(
            "UPDATE scope_commerce_obligations SET status=$2,provider_id=COALESCE(provider_id,$3),source_id=COALESCE(source_id,$4) WHERE obligation_id=$1",
            UUID(str(withdrawal_id)),
            "succeeded"
            if status_value == "succeeded"
            else "failed"
            if status_value == "failed"
            else "pending"
            if status_value in {"transferred", "pending"}
            else "unknown",
            transfer,
            payout,
        )
        return self._withdrawal_public(row)

    async def _record_paid_withdrawal(
        self,
        c: Any,
        row: dict[str, Any],
        withdrawal_id: str,
        transfer: str,
        payout: str,
        actual_fee_micro_usd: int,
    ):
        if not transfer or not payout:
            raise CommerceError("verified_payout_required")
        remainder = max(0, row["fee_micro_usd"] - actual_fee_micro_usd)
        excess = max(0, actual_fee_micro_usd - row["fee_micro_usd"])
        # Provider must have returned unused fee principal to platform
        # before this transition; operation records prove that reversal.
        if remainder:
            confirmed = await c.fetchval(
                "SELECT COALESCE(sum((request_json->>'amount')::bigint),0)*$3 >= $2 FROM scope_commerce_provider_operations WHERE kind='transfer_reversal' AND status='succeeded' AND request_json->>'transfer_id'=$1 AND request_json->'metadata'->>'withdrawal_id'=$4",
                transfer,
                remainder,
                MICRO_PER_CENT,
                str(withdrawal_id),
            )
            if not confirmed:
                raise CommerceError("fee_reversal_required")
        await self._post(
            c,
            f"withdrawal_settle:{withdrawal_id}",
            "withdrawal_settle",
            {
                account("seller_withdrawal", row["seller_id"]): -row["gross_micro_usd"],
                account("bank"): row["net_cents"] * MICRO_PER_CENT + actual_fee_micro_usd,
                account("seller_payable", row["seller_id"]): remainder,
                account("seller_debt", row["seller_id"]): -excess,
            },
            withdrawal_id,
        )

    async def _record_reversed_withdrawal(
        self,
        c: Any,
        row: dict[str, Any],
        withdrawal_id: str,
        transfer: str,
        actual_fee_micro_usd: int,
        retained_payout_fee_micro_usd: int,
    ):
        if await c.fetchval(
            "SELECT EXISTS(SELECT 1 FROM scope_commerce_transfer_recoveries WHERE withdrawal_id=$1 AND recovered_micro_usd>0)",
            row["withdrawal_id"],
        ):
            # Source-dispute recovery has its own cash/liability facts.
            # Do not guess how a later bank failure overlaps those
            # receipts or credit either cash or the owner twice.
            raise CommerceError("payout_recovery_overlap")
        if transfer:
            confirmed = await c.fetchval(
                "SELECT COALESCE(sum((request_json->>'amount')::bigint),0)*$3 >= $2 FROM scope_commerce_provider_operations WHERE kind='transfer_reversal' AND status='succeeded' AND request_json->>'transfer_id'=$1 AND request_json->'metadata'->>'withdrawal_id'=$4",
                transfer,
                row["gross_micro_usd"] - retained_payout_fee_micro_usd,
                MICRO_PER_CENT,
                str(withdrawal_id),
            )
            if not confirmed:
                raise CommerceError("transfer_reversal_required")
        cost = actual_fee_micro_usd
        prior_paid = row["settled_micro_usd"]
        # A paid payout can fail later. Preserve its original journal,
        # then compensate actual returned cash; do not debit the old
        # withdrawal hold, which was already consumed on paid receipt.
        restored = (prior_paid if prior_paid is not None else row["gross_micro_usd"]) - cost
        await self._post(
            c,
            f"withdrawal_late_failure:{withdrawal_id}"
            if prior_paid is not None
            else f"withdrawal_release:{withdrawal_id}",
            "withdrawal_late_failure" if prior_paid is not None else "withdrawal_release",
            {
                account("seller_withdrawal", row["seller_id"]): 0
                if prior_paid is not None
                else -row["gross_micro_usd"],
                account("seller_payable", row["seller_id"]): max(0, restored),
                account("seller_debt", row["seller_id"]): min(0, restored),
                account("bank"): cost - prior_paid if prior_paid is not None else cost,
            },
            withdrawal_id,
        )
