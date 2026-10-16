"""Bounded owner earning settlement in the private Drive sharing drain."""

from __future__ import annotations

import asyncio
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

    async def run(self, *, max_jobs: int, deadline_seconds: int, v1_only: bool = False) -> dict:
        if type(max_jobs) is not int or not 1 <= max_jobs <= 4 or not 20 <= deadline_seconds <= 45:
            raise ValueError("invalid owner payout worker bounds")
        if type(v1_only) is not bool:
            raise ValueError("invalid owner payout worker mode")
        started = asyncio.get_running_loop().time()
        outcomes: Counter[str] = Counter()
        v1_kwargs = {"v1_only": True} if v1_only else {}
        for result in (
            await self.service.reconcile_due(max_orders=max_jobs, **v1_kwargs),
            await self.service.transfer_due(max_orders=max_jobs, **v1_kwargs),
            await self.service.reconcile_external_debits(max_orders=max_jobs, **v1_kwargs),
            await self.service.reconcile_reversals(max_orders=max_jobs, **v1_kwargs),
        ):
            outcomes.update(result)
        # Separate sandbox credentials never replace the live payment client.
        # Continue already reserved redemptions even if new earning is paused.
        if not v1_only:
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
                # Read-only Connect ledger upkeep spends only what this tick has left:
                # at most two due balance refreshes and one payout itemisation.
                remaining = deadline_seconds - (asyncio.get_running_loop().time() - started) - 2
                try:
                    from hushh_mcp.services.stripe_connect_balances import StripeConnectBalances

                    async with asyncio.timeout(max(remaining, 0.1)):
                        outcomes.update(
                            await StripeConnectBalances().run_due(
                                max_refreshes=2, max_reconciliations=1, budget_seconds=remaining
                            )
                        )
                except Exception as exc:
                    logger.warning("connect_balance.run_deferred type=%s", type(exc).__name__)
                    outcomes["balance_refresh_deferred"] += 1
        if not payout_enabled() and not any(
            outcomes.get(key) for key in ("checked", "claimed", "reversal_due")
        ):
            outcomes["disabled"] = 1
        return {"outcomes": dict(outcomes)}
