"""Bounded owner earning settlement in the private Drive sharing drain."""

from __future__ import annotations

import logging
from collections import Counter

from hushh_mcp.services.drive_request_owner_payout_service import (
    DriveRequestOwnerPayoutService,
    payout_enabled,
)
from hushh_mcp.services.stripe_mode import connect_config

logger = logging.getLogger(__name__)


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
        try:
            connect_config()
        except ValueError:
            pass
        else:
            from hushh_mcp.services.hashcoin_redemption_service import HashcoinRedemptionService
            from hushh_mcp.services.stripe_connect_bank_payouts import StripeConnectBankPayouts

            outcomes.update(await HashcoinRedemptionService().reconcile_due(max_items=max_jobs))
            try:
                outcomes.update(
                    await StripeConnectBankPayouts(connect_mode=True).reconcile_due(
                        max_accounts=1, max_payouts_per_account=20
                    )
                )
            except Exception as exc:
                # Bank status polling cannot interrupt financial reconciliation.
                logger.warning("bank_payout.reconcile_deferred type=%s", type(exc).__name__)
                outcomes["bank_provider_deferred"] += 1
        if not payout_enabled() and not any(
            outcomes.get(key) for key in ("checked", "claimed", "reversal_due")
        ):
            outcomes["disabled"] = 1
        return {"outcomes": dict(outcomes)}
