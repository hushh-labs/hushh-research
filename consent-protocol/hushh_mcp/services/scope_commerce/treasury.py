"""Commerce custody backing shared by admission and count-only monitoring."""

from __future__ import annotations

from typing import Any

from .domain import MICRO_PER_CENT, CommerceError, account, integer


class TreasuryBacking:
    async def funding_fee_conservation(self, *, conn: Any = None) -> dict[str, bool | int]:
        """Check original funding cost allocation, not provider or payout receipts."""

        async def operation(c: Any) -> dict[str, bool | int]:
            bad_lots = await c.fetchval(
                """WITH purchase_cost AS (
                    SELECT a.lot_id,sum(a.fee_micro_usd) AS allocated
                    FROM scope_commerce_allocations a
                    JOIN scope_commerce_reservations r USING(purchase_id)
                    WHERE r.status IN ('held','consumed') GROUP BY a.lot_id
                ), refund_cost AS (
                    SELECT a.lot_id,sum(a.fee_micro_usd) AS allocated
                    FROM scope_commerce_source_refund_allocations a
                    JOIN scope_commerce_obligations o ON o.obligation_id=a.refund_id
                    WHERE o.kind='source_refund' AND o.status<>'failed' GROUP BY a.lot_id
                ) SELECT count(*) FROM scope_commerce_funding_lots f
                LEFT JOIN purchase_cost p USING(lot_id)
                LEFT JOIN refund_cost r USING(lot_id)
                WHERE f.fee_total_micro_usd <> f.fee_remaining_micro_usd
                    + COALESCE(p.allocated,0) + COALESCE(r.allocated,0)"""
            )
            return {"balanced": bad_lots == 0, "bad_lot_count": bad_lots}

        return await self._transaction(operation, conn)

    async def treasury_position(self, *, conn: Any = None) -> dict[str, int]:
        """Read the attributed custody position without provider I/O or writes."""
        return await self._transaction(self._treasury_position, conn)

    async def _treasury_position(self, c: Any) -> dict[str, int]:
        restricted = await c.fetchval(
            """SELECT COALESCE(sum(micro_usd),0)::bigint FROM scope_commerce_postings
            WHERE account LIKE 'wallet_available:%' OR account LIKE 'wallet_reserved:%'
            OR account LIKE 'wallet_frozen:%' OR account LIKE 'source_refund_hold:%'
            OR account LIKE 'seller_pending:%' OR account LIKE 'seller_payable:%'
            OR account LIKE 'seller_withdrawal:%'"""
        )
        # Pending seller credit is net of costs, while an unsettled term can
        # return its gross principal. Seller debt is never cash backing.
        restricted += await c.fetchval(
            "SELECT COALESCE(sum(LEAST(price_cents::bigint*10000,fee_micro_usd)),0)::bigint FROM scope_commerce_purchases WHERE status='staged' AND earnings_settled_at IS NULL"
        )
        external = await c.fetchval(
            "SELECT COALESCE(sum(gross_micro_usd),0)::bigint FROM scope_commerce_withdrawals WHERE transfer_id IS NOT NULL AND settled_micro_usd IS NULL AND status IN ('transferred','pending','unknown')"
        )
        restricted = max(0, restricted - external)
        # Transfer principal stays in journal bank until terminal receipt.
        # Aggregate provider cash can belong to unrelated activities and is
        # never credited as commerce capital without an attributable receipt.
        attributed = -await self._amount(c, account("bank")) - external
        operating_reserve = await c.fetchval(
            "SELECT COALESCE(sum(((fee_micro_usd+9999)/10000)*10000),0)::bigint FROM scope_commerce_withdrawals WHERE settled_micro_usd IS NULL AND status IN ('queued','transferred','pending','unknown')"
        )
        return {
            "restrictedMicroUsd": restricted,
            "attributedMicroUsd": attributed,
            "operatingFeeReserveMicroUsd": operating_reserve,
            "backingShortfallMicroUsd": max(0, restricted + operating_reserve - attributed),
        }

    async def treasury_check(
        self, *, available_micro_usd, withdrawal_id=None, fee_reserve_micro_usd=0, conn=None
    ):
        integer(available_micro_usd, 0, 10**18, "invalid_provider_backing")
        integer(fee_reserve_micro_usd, 0, 10**18, "invalid_provider_fee")

        async def operation(c: Any) -> dict[str, int]:
            position = await self._treasury_position(c)
            # All independent provider operations share durable headroom.
            # Per-call snapshots cannot reserve the same capital twice.
            fee_reserve = max(fee_reserve_micro_usd, position["operatingFeeReserveMicroUsd"])
            required = position["restrictedMicroUsd"] + fee_reserve
            if available_micro_usd < required or position["attributedMicroUsd"] < required:
                raise CommerceError("treasury_backing_insufficient")
            return position | {
                "availableMicroUsd": available_micro_usd,
                "feeReserveMicroUsd": fee_reserve,
            }

        return await self._transaction(operation, conn)

    async def treasury_require_backing(self, conn, amount_cents):
        # Compatibility check alone cannot replace actual provider admission.
        backing = -await self._amount(conn, account("bank"))
        if backing < amount_cents * MICRO_PER_CENT:
            raise CommerceError("treasury_backing_insufficient")
