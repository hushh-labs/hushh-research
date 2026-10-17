"""Provider retention admission stops and funded-balance residual obligations."""

from __future__ import annotations

import json
from typing import Any

from .domain import MICRO_PER_CENT as _MICRO_PER_CENT
from .domain import CommerceError
from .provider_contracts import ProviderContext


class RetentionPolicy(ProviderContext):
    async def _retention_sweep(self, *, limit: int) -> int:
        """Return aged unused funding and stop admission on unresolved residuals.

        The 50-cent net floor remains strict. Earned dust and disputed backing
        require the account's approved residual-resolution procedure; a worker
        must never mislabel an unresolved liability as a payout or forgiveness.
        """
        platform_policy = self.config.countries.get("US")
        if platform_policy is None:
            return 0

        async def aged(connection: Any) -> list[dict[str, Any]]:
            return await self._aged_unused_funding(
                connection, retention_days=platform_policy.retention_days, limit=limit
            )

        obligations = 0
        for funding in await self.store._transaction(aged):
            if await self._record_funding_retention(funding):
                obligations += 1

        async def sellers(connection: Any) -> list[dict[str, Any]]:
            return await self._aged_sellers(connection, limit=limit)

        for seller in await self.store._transaction(sellers):
            await self._retention_obligation(
                identity=str(seller["seller_id"]),
                kind="seller",
                amount=seller["aged_micro_usd"],
                seller_id=seller["seller_id"],
            )
            obligations += 1

        async def resolved(connection: Any) -> None:
            await self._close_resolved_retention(
                connection, retention_days=platform_policy.retention_days
            )

        await self.store._transaction(resolved)
        return obligations

    async def _retention_obligation(
        self,
        *,
        identity: str,
        kind: str,
        amount: int,
        wallet_id: Any = None,
        seller_id: Any = None,
        funding_lot_id: Any = None,
    ) -> None:
        async def record(connection: Any) -> None:
            await connection.execute(
                """INSERT INTO scope_commerce_obligations
                (obligation_id,kind,wallet_id,seller_id,funding_lot_id,amount_micro_usd,status,idempotency_key,source_id)
                VALUES($1::uuid,'recovery',$2,$3,$4,$5,'manual_review',$6,'retention')
                ON CONFLICT(idempotency_key) DO UPDATE SET amount_micro_usd=EXCLUDED.amount_micro_usd,
                 status='manual_review',next_check_at=clock_timestamp()""",
                self._derived_id(identity, f"retention:{kind}"),
                wallet_id,
                seller_id,
                funding_lot_id,
                amount,
                f"retention:{kind}:{identity}",
            )

        await self.store._transaction(record)

    async def _aged_unused_funding(
        self, connection: Any, *, retention_days: int, limit: int
    ) -> list[dict[str, Any]]:
        rows = await connection.fetch(
            """SELECT f.*,w.payer_user_id,w.erased_at,
            (SELECT COALESCE(sum(child.available_micro_usd),0)::bigint FROM scope_commerce_funding_lots child
             WHERE child.lot_id=f.lot_id OR child.source_lot_id=f.lot_id) AS unused_micro_usd,
            (SELECT COALESCE(sum(child.refund_reserved_micro_usd),0)::bigint FROM scope_commerce_funding_lots child
             WHERE child.lot_id=f.lot_id OR child.source_lot_id=f.lot_id) AS reserved_micro_usd
            FROM scope_commerce_funding_lots f JOIN scope_commerce_wallets w USING(wallet_id)
            LEFT JOIN scope_commerce_obligations o ON o.idempotency_key='retention:wallet:'||f.funding_id::text
            WHERE f.payment_intent_id IS NOT NULL
              AND f.created_at<=clock_timestamp()-$1*interval '1 day'
              AND (f.available_micro_usd>0 OR f.refund_reserved_micro_usd>0 OR EXISTS(
                SELECT 1 FROM scope_commerce_funding_lots child WHERE child.source_lot_id=f.lot_id
                AND (child.available_micro_usd>0 OR child.refund_reserved_micro_usd>0)))
            ORDER BY COALESCE(o.next_check_at,f.created_at),f.created_at,f.funding_id LIMIT $2""",
            retention_days,
            limit,
        )
        return [dict(row) for row in rows]

    async def _close_resolved_retention(self, connection: Any, *, retention_days: int) -> None:
        await connection.execute(
            """UPDATE scope_commerce_obligations o SET status='succeeded'
            WHERE o.idempotency_key LIKE 'retention:wallet:%' AND o.status<>'succeeded'
            AND NOT EXISTS(SELECT 1 FROM scope_commerce_funding_lots f WHERE f.lot_id=o.funding_lot_id
             AND f.created_at<=clock_timestamp()-$1*interval '1 day'
             AND (f.available_micro_usd>0 OR f.refund_reserved_micro_usd>0 OR EXISTS(
              SELECT 1 FROM scope_commerce_funding_lots child WHERE child.source_lot_id=f.lot_id
              AND (child.available_micro_usd>0 OR child.refund_reserved_micro_usd>0))))""",
            retention_days,
        )
        await connection.execute("""UPDATE scope_commerce_obligations o SET status='succeeded'
            WHERE o.idempotency_key LIKE 'retention:seller:%' AND o.status<>'succeeded'
            AND (SELECT COALESCE(sum(micro_usd),0) FROM scope_commerce_postings
             WHERE account='seller_payable:'||o.seller_id::text)<=0""")

    async def _aged_sellers(self, connection: Any, *, limit: int) -> list[dict[str, Any]]:
        # Select actual FIFO-aged liabilities before the batch limit. Old empty
        # sellers or consumed historical credits must not occupy every sweep.
        rows = await connection.fetch(
            """SELECT s.seller_id,aged.amount AS aged_micro_usd FROM scope_commerce_sellers s
            JOIN jsonb_each_text($1::jsonb) AS policy(country,days) ON policy.country=s.country
            CROSS JOIN LATERAL (WITH credits AS (
             SELECT j.created_at,p.micro_usd,sum(p.micro_usd) OVER(ORDER BY j.created_at,j.entry_id) AS cumulative
             FROM scope_commerce_postings p JOIN scope_commerce_journal j USING(entry_id)
             WHERE p.account='seller_payable:'||s.seller_id::text AND p.micro_usd>0), consumed AS (
             SELECT COALESCE(-sum(micro_usd),0) AS amount FROM scope_commerce_postings
             WHERE account='seller_payable:'||s.seller_id::text AND micro_usd<0)
             SELECT COALESCE(sum(LEAST(micro_usd,GREATEST(0,cumulative-consumed.amount))),0)::bigint AS amount
             FROM credits CROSS JOIN consumed WHERE cumulative>consumed.amount
             AND created_at<=clock_timestamp()-policy.days::integer*interval '1 day') aged
            LEFT JOIN scope_commerce_obligations o ON o.idempotency_key='retention:seller:'||s.seller_id::text
            WHERE aged.amount>0
            ORDER BY COALESCE(o.next_check_at,s.created_at),s.created_at,s.seller_id LIMIT $2""",
            json.dumps(
                {
                    country: policy.retention_days
                    for country, policy in self.config.countries.items()
                }
            ),
            limit,
        )
        return [dict(row) for row in rows]

    async def _record_funding_retention(self, funding: dict[str, Any]) -> bool:
        amount = funding["unused_micro_usd"] + funding["reserved_micro_usd"]
        if amount <= 0:
            return False
        await self._retention_obligation(
            identity=str(funding["funding_id"]),
            kind="wallet",
            amount=amount,
            wallet_id=funding["wallet_id"],
            funding_lot_id=funding["lot_id"],
        )
        if (
            not funding["frozen"]
            and funding["payer_user_id"] is not None
            and funding["unused_micro_usd"] >= _MICRO_PER_CENT
        ):
            try:
                await self.store.reserve_funding_refund(
                    user_id=funding["payer_user_id"],
                    funding_id=str(funding["funding_id"]),
                    refund_id=self._derived_id(
                        str(funding["funding_id"]),
                        f"retention_refund:{funding['refunded_micro_usd']}:{funding['unused_micro_usd']}",
                    ),
                    amount_cents=funding["unused_micro_usd"] // _MICRO_PER_CENT,
                )
            except CommerceError:
                pass  # Keep the durable residual and admission stop.

        return True
