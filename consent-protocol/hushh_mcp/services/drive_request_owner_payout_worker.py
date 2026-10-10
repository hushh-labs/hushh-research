"""Bounded owner earning settlement in the private Drive sharing drain."""

from __future__ import annotations

import os
from collections import Counter

from hushh_mcp.services.drive_request_owner_payout_service import (
    DriveRequestOwnerPayoutService,
    payout_enabled,
)


class DriveRequestOwnerPayoutWorker:
    def __init__(self, service: DriveRequestOwnerPayoutService | None = None) -> None:
        self.service = service or DriveRequestOwnerPayoutService()

    async def run(self, *, max_jobs: int, deadline_seconds: int) -> dict:
        if type(max_jobs) is not int or not 1 <= max_jobs <= 4 or not 20 <= deadline_seconds <= 45:
            raise ValueError("invalid owner payout worker bounds")
        outcomes: Counter[str] = Counter()
        for result in (
            await self.service.reconcile_due(max_orders=max_jobs),
            await self.service.transfer_due(max_orders=max_jobs),
            await self.service.reconcile_external_debits(max_orders=max_jobs),
            await self.service.reconcile_reversals(max_orders=max_jobs),
        ):
            outcomes.update(result)
        # Separate sandbox credentials never replace the live payment client.
        # Continue already reserved redemptions even if new earning is paused.
        if os.getenv("STRIPE_CONNECT_SECRET_KEY"):
            from hushh_mcp.services.hashcoin_redemption_service import HashcoinRedemptionService

            outcomes.update(await HashcoinRedemptionService().reconcile_due(max_items=max_jobs))
        if not payout_enabled() and not any(
            outcomes.get(key) for key in ("checked", "claimed", "reversal_due")
        ):
            outcomes["disabled"] = 1
        return {"outcomes": dict(outcomes)}
