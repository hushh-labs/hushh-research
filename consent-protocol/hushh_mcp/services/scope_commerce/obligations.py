"""Obligations capability; composed by the canonical commerce transaction host."""

from __future__ import annotations

from uuid import UUID

from .domain import (
    CommerceError,
    integer,
)


class DurableObligations:
    async def claim_obligations(self, *, kinds=("source_refund",), limit=4, conn=None):
        integer(limit, 1, 20, "invalid_worker_limit")
        if not kinds or set(kinds) - {
            "source_refund",
            "transfer",
            "payout",
            "transfer_reversal",
            "recovery",
        }:
            raise CommerceError("invalid_worker_kinds")

        async def operation(c):
            rows = await c.fetch(
                """SELECT * FROM scope_commerce_obligations WHERE kind=ANY($1::text[]) AND status IN ('queued','dispatching','unknown','pending') AND next_check_at<=clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED""",
                list(kinds),
                limit,
            )
            results = []
            for row in rows:
                if row["first_dispatch_at"] and await c.fetchval(
                    "SELECT clock_timestamp()>$1::timestamptz+interval '20 hours'",
                    row["first_dispatch_at"],
                ):
                    # Recovery still retrieves a known object; fresh provider
                    # creation outside its guaranteed key window is prohibited.
                    create_allowed = False
                else:
                    create_allowed = True
                claimed = await self._row(
                    c,
                    "UPDATE scope_commerce_obligations SET status='dispatching',lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE obligation_id=$1 RETURNING *",
                    row["obligation_id"],
                )
                claimed["create_allowed"] = create_allowed
                results.append(claimed)
            return results

        return await self._transaction(operation, conn)

    async def mark_obligation_dispatch_started(self, *, obligation_id, conn):
        """Trusted provider intent port, within its durable operation claim.

        Work leasing and preflight failures do not start the provider retry
        horizon. Once submission becomes possible, an unknown outcome retains
        this timestamp and its original idempotency window.
        """
        await conn.execute(
            "UPDATE scope_commerce_obligations SET first_dispatch_at=COALESCE(first_dispatch_at,clock_timestamp()) WHERE obligation_id=$1",
            UUID(str(obligation_id)),
        )
