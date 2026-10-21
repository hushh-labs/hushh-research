"""Prepare one short-lived Stripe Checkout before announcing payment in Feed."""

from __future__ import annotations

import asyncio
import os
from collections import Counter

from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DriveRequestPaymentCheckoutWorker:
    def __init__(self, service: DriveRequestPaymentService | None = None) -> None:
        self.service = service or DriveRequestPaymentService()

    async def run(self, *, max_jobs: int, deadline_seconds: int, v1_only: bool = False) -> dict:
        if type(max_jobs) is not int or not 1 <= max_jobs <= 4 or not 20 <= deadline_seconds <= 35:
            raise ValueError("invalid Drive payment checkout bounds")
        if type(v1_only) is not bool:
            raise ValueError("invalid Drive payment checkout mode")
        if not os.getenv("STRIPE_SECRET_KEY") or not os.getenv("STRIPE_WEBHOOK_SECRET"):
            return {"outcomes": {"disabled": 1}}

        outcomes: Counter[str] = Counter()
        deadline = asyncio.get_running_loop().time() + deadline_seconds
        candidates = await self.service.due_checkout_orders(
            limit=max_jobs * 5, **({"v1_only": True} if v1_only else {})
        )
        provider_attempts = 0
        for order in candidates:
            if provider_attempts >= max_jobs:
                break
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining < 5:
                outcomes["deadline"] += 1
                break
            try:
                async with asyncio.timeout(min(remaining, 8)):
                    result = await self.service.checkout(
                        requester_user_id=order["requester_user_id"],
                        request_id=order["request_id"],
                        **({"v1_only": True} if v1_only else {}),
                    )
            except (DriveSharingError, DriveReadError) as error:
                if str(error) == "payment_unavailable":
                    provider_attempts += 1
                    outcomes["unavailable"] += 1
                    continue
                # A stale pending order is not one of the bounded provider
                # attempts. Requeue it behind later orders and keep scanning
                # this bounded candidate page for an eligible payment.
                await self.service.defer_unready_checkout_order(
                    **order, **({"v1_only": True} if v1_only else {})
                )
                outcomes["not_ready"] += 1
            except TimeoutError:
                provider_attempts += 1
                outcomes["unavailable"] += 1
            else:
                provider_attempts += 1
                outcomes[
                    "existing_access" if result.get("existingAccess") is True else "ready"
                ] += 1
        if not candidates:
            outcomes["not_claimed"] += 1
        return {"outcomes": dict(outcomes)}
