"""Bounded packet-order reconciliation inside the scheduled work drain.

Refunds paid packets the owner did not accept (see PkmPacketOrderService.reconcile)
and reports aggregate counts only. Disabled until Stripe is configured; durable
order rows stay due for the next run.
"""

from __future__ import annotations

import os

from hushh_mcp.services.pkm_packet_order_service import PkmPacketOrderService


class PkmPacketOrderWorker:
    def __init__(self, service: PkmPacketOrderService | None = None) -> None:
        self.service = service

    async def run(self, *, max_jobs: int, deadline_seconds: int) -> dict:
        if not 1 <= max_jobs <= 20 or not 20 <= deadline_seconds <= 35:
            raise ValueError("invalid packet order worker bounds")
        if not os.getenv("STRIPE_SECRET_KEY") or not os.getenv("STRIPE_WEBHOOK_SECRET"):
            return {"outcomes": {"disabled": 1}}
        from hushh_mcp.services.pkm_credit_service import PkmCreditService

        result = await (self.service or PkmPacketOrderService()).reconcile()
        cancelled = await PkmCreditService().cancel_deleted_subscriptions(max_jobs=max_jobs)
        return {
            "outcomes": {
                "marked": result["markedRefundable"],
                "refunded": result["refunded"],
                "cancelled": cancelled,
            }
        }
