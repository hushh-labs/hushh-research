"""Erasure capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from .domain import (
    MICRO_PER_CENT,
    account,
)


class FinancialErasure:
    async def erase_account(self, user_id, *, permanent=True, conn=None):
        async def operation(c):
            return await self._tx_erase_account(c, user_id, permanent)

        return await self._transaction(operation, conn)

    async def _tx_erase_account(self, c: Any, user_id: Any, permanent: Any) -> Any:
        await c.execute(
            "UPDATE scope_commerce_sellers s SET account_id=a.account_id,country=a.country,livemode=a.livemode FROM scope_commerce_seller_accounts a WHERE a.user_id=$1 AND s.owner_user_id=a.user_id",
            user_id,
        )
        await c.execute(
            "UPDATE scope_commerce_withdrawals w SET account_id=a.account_id,country=a.country,livemode=a.livemode FROM scope_commerce_seller_accounts a WHERE w.user_id=$1 AND a.user_id=w.user_id",
            user_id,
        )
        purchases = await c.fetch(
            "SELECT * FROM scope_commerce_purchases WHERE owner_user_id=$1 OR payer_user_id=$1 ORDER BY purchase_id FOR UPDATE",
            user_id,
        )
        for p in purchases:
            await self._revoke(c, dict(p))
            if not permanent:
                continue
            await c.execute(
                "UPDATE scope_commerce_purchases SET owner_user_id=CASE WHEN owner_user_id=$2 THEN NULL ELSE owner_user_id END,payer_user_id=CASE WHEN payer_user_id=$2 THEN NULL ELSE payer_user_id END,erased_at=clock_timestamp(),staged_export=NULL WHERE purchase_id=$1",
                p["purchase_id"],
                user_id,
            )
        if not permanent:
            return {"revokedPurchases": len(purchases), "detachedWallets": 0}
        wallets = await c.fetch(
            "SELECT * FROM scope_commerce_wallets WHERE payer_user_id=$1 FOR UPDATE", user_id
        )
        for wallet in wallets:
            await self._erase_wallet_liabilities(c, wallet, user_id)
        await c.execute(
            "UPDATE scope_commerce_sellers SET owner_user_id=NULL,erased_at=clock_timestamp() WHERE owner_user_id=$1",
            user_id,
        )
        await c.execute(
            "UPDATE scope_commerce_tariffs SET owner_user_id=NULL WHERE owner_user_id=$1",
            user_id,
        )
        await c.execute(
            "UPDATE scope_commerce_quotes SET purpose=NULL,owner_user_id=CASE WHEN owner_user_id=$1 THEN NULL ELSE owner_user_id END,payer_user_id=CASE WHEN payer_user_id=$1 THEN NULL ELSE payer_user_id END WHERE owner_user_id=$1 OR payer_user_id=$1",
            user_id,
        )
        await c.execute(
            "UPDATE scope_commerce_withdrawals SET user_id=NULL WHERE user_id=$1", user_id
        )
        # Provider operations keep only allowlisted opaque settlement refs,
        # never user IDs, request purpose, scope names or hosted URLs.
        await c.execute(
            "UPDATE scope_commerce_provider_operations SET user_id=NULL,request_json=request_json-'user_id'-'payer_user_id'-'purpose'-'machine_scope'-'scope_handle',provider_response=provider_response-'url'-'email' WHERE user_id=$1",
            user_id,
        )
        await c.execute("DELETE FROM scope_commerce_stripe_customers WHERE user_id=$1", user_id)
        await c.execute("DELETE FROM scope_commerce_seller_accounts WHERE user_id=$1", user_id)
        return {"revokedPurchases": len(purchases), "detachedWallets": len(wallets)}

    async def _erase_wallet_liabilities(self, c: Any, wallet: dict[str, Any], user_id: str):
        amount = await self._amount(c, account("wallet_available", wallet["wallet_id"]))
        await self._post(
            c,
            f"erase_wallet:{wallet['wallet_id']}",
            "erasure_freeze",
            {
                account("wallet_available", wallet["wallet_id"]): -amount,
                account("wallet_frozen", wallet["wallet_id"]): amount,
            },
            wallet["wallet_id"],
        )
        await c.execute(
            "UPDATE scope_commerce_funding_lots SET frozen=TRUE WHERE wallet_id=$1",
            wallet["wallet_id"],
        )
        # Money is retained as a liability. Queue source refunds for
        # unused principal before detaching the human identity.
        originals = await c.fetch(
            "SELECT funding_id,lot_id FROM scope_commerce_funding_lots WHERE wallet_id=$1 AND payment_intent_id IS NOT NULL",
            wallet["wallet_id"],
        )
        for original in originals:
            if await c.fetchval(
                "SELECT EXISTS(SELECT 1 FROM scope_commerce_obligations WHERE funding_lot_id=$1 AND kind='recovery' AND idempotency_key LIKE 'recovery:%' AND status<>'succeeded')",
                original["lot_id"],
            ):
                continue
            unused = await c.fetchval(
                "SELECT COALESCE(sum(available_micro_usd),0)::bigint FROM scope_commerce_funding_lots WHERE lot_id=$1 OR source_lot_id=$1",
                original["lot_id"],
            )
            if unused >= MICRO_PER_CENT:
                await c.execute(
                    "UPDATE scope_commerce_wallets SET erased_at=COALESCE(erased_at,clock_timestamp()) WHERE wallet_id=$1",
                    wallet["wallet_id"],
                )
                await self.reserve_funding_refund(
                    user_id=user_id,
                    funding_id=original["funding_id"],
                    refund_id=uuid4(),
                    amount_cents=unused // MICRO_PER_CENT,
                    conn=c,
                )
        await c.execute(
            "UPDATE scope_commerce_wallets SET payer_user_id=NULL,erased_at=clock_timestamp() WHERE wallet_id=$1",
            wallet["wallet_id"],
        )
