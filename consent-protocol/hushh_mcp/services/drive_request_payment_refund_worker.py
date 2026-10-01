"""Bounded payment reconciliation in the existing private Drive sharing drain."""

from __future__ import annotations

import os

from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService


class DriveRequestPaymentRefundWorker:
    def __init__(self, service: DriveRequestPaymentService | None = None) -> None:
        self.service = service or DriveRequestPaymentService()

    async def run(self, *, max_jobs: int, deadline_seconds: int) -> dict:
        if not 1 <= max_jobs <= 4 or not 20 <= deadline_seconds <= 35:
            raise ValueError("invalid Drive payment refund bounds")
        # Before Stripe is configured there can be no paid-required order.
        # A later credential outage is visible as a disabled stage and the
        # durable refund rows remain due for the next scheduled drain.
        if not os.getenv("STRIPE_SECRET_KEY") or not os.getenv("STRIPE_WEBHOOK_SECRET"):
            return {"outcomes": {"disabled": 1}}
        outcomes = await self.service.reconcile_refunds(max_orders=max_jobs)
        return {"outcomes": outcomes}
