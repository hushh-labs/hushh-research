"""Purchases capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from .domain import (
    MICRO_PER_CENT,
    CommerceError,
    account,
    allocated_fee,
    fingerprint,
    public,
)


class PurchaseReservations:
    async def reserve_purchase(
        self, *, payer_user_id, quote_id, idempotency_key, on_reserved=None, conn=None
    ):
        self._admit()

        async def operation(c):
            return await self._tx_reserve_purchase(
                c, payer_user_id, quote_id, idempotency_key, on_reserved
            )

        return await self._transaction(operation, conn)

    async def _tx_reserve_purchase(
        self, c: Any, payer_user_id: Any, quote_id: Any, idempotency_key: Any, on_reserved: Any
    ) -> Any:
        await self._environment(c)
        p = await self._row(
            c,
            "SELECT * FROM scope_commerce_purchases WHERE quote_id=$1 AND payer_user_id=$2 FOR UPDATE",
            UUID(str(quote_id)),
            payer_user_id,
        )
        if not p:
            raise CommerceError("owner_approval_required")
        await self._wallet(c, payer_user_id, p["buyer_app_id"])
        await self._validate_purchase_payer(c, p, payer_user_id)
        old = await self._row(
            c,
            "SELECT * FROM scope_commerce_reservations WHERE purchase_id=$1",
            p["purchase_id"],
        )
        if old:
            if old["status"] == "released":
                raise CommerceError("reservation_closed")
            return public(p)
        now = await c.fetchval("SELECT clock_timestamp()")
        if p["status"] != "awaiting_payment" or now >= p["fulfillment_deadline"]:
            raise CommerceError("purchase_unavailable")
        quote_expiry = await c.fetchval(
            "SELECT expires_at FROM scope_commerce_quotes WHERE quote_id=$1", p["quote_id"]
        )
        if now >= quote_expiry:
            raise CommerceError("quote_expired")
        if p["price_cents"]:
            await self._environment(c, seller_user_id=p["owner_user_id"])
        if p["price_cents"] and not await c.fetchval(
            "SELECT eligible FROM scope_commerce_seller_accounts WHERE user_id=$1 FOR SHARE",
            p["owner_user_id"],
        ):
            raise CommerceError("seller_onboarding_required")
        await self._registered_key(c, p)
        required = p["price_cents"] * MICRO_PER_CENT
        if required:
            await self._paid_admission(c)
        available = await self._amount(c, account("wallet_available", p["wallet_id"]))
        if available < required:
            raise CommerceError("insufficient_balance")
        await c.execute(
            "INSERT INTO scope_commerce_reservations(purchase_id,idempotency_key,request_hash,status) VALUES($1,$2,$3,'held')",
            p["purchase_id"],
            idempotency_key,
            fingerprint([quote_id, payer_user_id]),
        )
        fee = await self._allocate_purchase_funding(c, p, required)
        await self._post(
            c,
            f"reserve:{p['purchase_id']}",
            "purchase_reserve",
            {
                account("wallet_available", p["wallet_id"]): -required,
                account("wallet_reserved", p["wallet_id"]): required,
            },
            p["purchase_id"],
        )
        row = await self._row(
            c,
            "UPDATE scope_commerce_purchases SET status='reserved',fee_micro_usd=$2,fulfillment_deadline=LEAST(clock_timestamp()+interval '24 hours',(SELECT request_deadline FROM scope_commerce_quotes WHERE quote_id=scope_commerce_purchases.quote_id)) WHERE purchase_id=$1 RETURNING *",
            p["purchase_id"],
            fee,
        )
        if on_reserved is not None:
            await on_reserved(c, row)
        return public(row)

    async def _validate_purchase_payer(self, c: Any, p: dict[str, Any], payer_user_id: str):
        if p["buyer_app_id"] == "agent_one":
            bundle = await c.fetchrow(
                "SELECT b.requester_user_id FROM one_information_request_bundles b JOIN one_information_request_items i USING(bundle_id) WHERE i.request_id=$1 FOR SHARE OF b,i",
                p["request_id"],
            )
            marketplace = (
                await c.fetchrow(
                    "SELECT buyer_user_id FROM marketplace_access_requests WHERE id::text=$1 FOR SHARE",
                    p["request_id"],
                )
                if not bundle
                else None
            )
            if not (bundle and bundle["requester_user_id"] == payer_user_id) and not (
                marketplace and marketplace["buyer_user_id"] == payer_user_id
            ):
                raise CommerceError("payer_request_binding_required")

    async def _allocate_purchase_funding(self, c: Any, p: dict[str, Any], required: int):
        lots = await c.fetch(
            "SELECT * FROM scope_commerce_funding_lots WHERE wallet_id=$1 AND NOT frozen AND available_micro_usd>0 AND livemode=$2 ORDER BY created_at,lot_id FOR UPDATE",
            p["wallet_id"],
            self._config().livemode,
        )
        remaining, fee = required, 0
        for lot in lots:
            take = min(remaining, lot["available_micro_usd"])
            if take == 0:
                break
            # Returned access credits are separate fee-free lots. Original
            # funding fees are retained as seller expense, never charged twice.
            cost = allocated_fee(
                take, lot["fee_basis_remaining_micro_usd"], lot["fee_remaining_micro_usd"]
            )
            await c.execute(
                "INSERT INTO scope_commerce_allocations VALUES($1,$2,$3,$4)",
                p["purchase_id"],
                lot["lot_id"],
                take,
                cost,
            )
            await c.execute(
                "UPDATE scope_commerce_funding_lots SET available_micro_usd=available_micro_usd-$2,fee_basis_remaining_micro_usd=fee_basis_remaining_micro_usd-$2,fee_remaining_micro_usd=fee_remaining_micro_usd-$3 WHERE lot_id=$1",
                lot["lot_id"],
                take,
                cost,
            )
            fee += cost
            remaining -= take
        if remaining:
            raise CommerceError("funding_provenance_unavailable")
        return fee
