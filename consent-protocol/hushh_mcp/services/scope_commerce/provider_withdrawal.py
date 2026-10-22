"""Human-confirmed withdrawal terms and pending/available earnings projection."""

from __future__ import annotations

from typing import Any

from .domain import payout_terms
from .provider_contracts import ProviderContext, _operation_id
from .stripe_adapter import CommerceProviderError


class WithdrawalIntent(ProviderContext):
    async def request_withdrawal(
        self,
        *,
        user_id: str,
        operation_id: str,
        scheduled: bool = False,
        expected_net_cents: int | None = None,
        expected_fee_micro_usd: int | None = None,
        expected_fee_configuration_ref: str | None = None,
    ) -> dict[str, Any]:
        await self._admit(new_activity=False)
        operation_id = _operation_id(operation_id)
        status = await self.seller_status(user_id)
        if not status["eligible"]:
            raise CommerceProviderError("seller_not_eligible")
        policy = self.config.countries[status["country"]]
        if not self.config.fee_configuration_ref:
            raise CommerceProviderError("payout_fee_configuration_unverified")
        if scheduled:
            preview = await self.preview_withdrawal(user_id)
            expected_net_cents, expected_fee_micro_usd = preview["netCents"], preview["feeMicroUsd"]
        elif expected_net_cents is None or expected_fee_micro_usd is None:
            raise CommerceProviderError("payout_confirmation_required")
        if (
            expected_fee_configuration_ref is not None
            and expected_fee_configuration_ref != self.config.fee_configuration_ref
        ):
            raise CommerceProviderError("payout_fee_configuration_changed")
        # The core reserves exact liabilities and computes the final fee basis.
        reservation = await self.store.reserve_withdrawal(
            user_id=user_id,
            withdrawal_id=operation_id,
            fee_micro_usd=policy.fixed_fee_micro_usd,
            minimum_net_cents=max(50, policy.minimum_cents),
            fee_basis_points=policy.fee_basis_points,
            scheduled=scheduled,
            expected_net_cents=expected_net_cents,
            expected_fee_micro_usd=expected_fee_micro_usd,
        )
        return await self._deliver_withdrawal(
            user_id=user_id,
            withdrawal_id=operation_id,
            reservation=reservation,
            account_id=status["accountId"],
        )

    async def preview_withdrawal(self, user_id: str) -> dict[str, Any]:
        self.config.validate(new_activity=False)
        status = await self.seller_status(user_id)
        if not status["eligible"]:
            return {"eligible": False, "blockReason": "seller_not_eligible"}
        if not self.config.fee_configuration_ref:
            return {"eligible": False, "blockReason": "payout_fee_configuration_unverified"}
        policy = self.config.countries[status["country"]]

        async def preview(connection: Any) -> dict[str, Any]:
            seller_id = await connection.fetchval(
                "SELECT seller_id FROM scope_commerce_sellers WHERE owner_user_id=$1", user_id
            )
            payable = (
                await self.store._amount(connection, f"seller_payable:{seller_id}")
                if seller_id
                else 0
            )
            pending = (
                await self.store._amount(connection, f"seller_pending:{seller_id}")
                if seller_id
                else 0
            )
            debt = (
                await self.store._amount(connection, f"seller_debt:{seller_id}") if seller_id else 0
            )
            available = max(0, payable + min(0, debt))
            terms = payout_terms(
                available, policy.fixed_fee_micro_usd, policy.fee_basis_points, policy.minimum_cents
            )
            reason = (
                "recovery_liability"
                if debt < 0 and available == 0
                else "below_payout_minimum"
                if terms["net_cents"] < terms["minimum_net_cents"]
                else None
            )
            running = (
                await connection.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM scope_commerce_withdrawals WHERE seller_id=$1 AND status IN ('queued','transferred','pending','unknown'))",
                    seller_id,
                )
                if seller_id
                else False
            )
            disputed = (
                await connection.fetchval(
                    """SELECT EXISTS(SELECT 1 FROM scope_commerce_purchases p
                JOIN scope_commerce_allocations a USING(purchase_id) JOIN scope_commerce_funding_lots f USING(lot_id)
                WHERE p.seller_id=$1 AND f.frozen)""",
                    seller_id,
                )
                if seller_id
                else False
            )
            reason = (
                "withdrawal_already_pending"
                if running
                else "seller_funds_under_review"
                if disputed
                else reason
            )
            return {
                "eligible": reason is None,
                "blockReason": reason,
                "grossMicroUsd": terms["gross_micro_usd"],
                "pendingMicroUsd": max(0, pending),
                "feeMicroUsd": terms["fee_micro_usd"],
                "netCents": terms["net_cents"],
                "minimumNetCents": terms["minimum_net_cents"],
                "feeConfigurationRef": self.config.fee_configuration_ref,
            }

        return await self.store._transaction(preview)
