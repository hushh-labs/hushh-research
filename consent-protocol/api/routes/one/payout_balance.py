"""The owner's connected-account Stripe balance ("In Stripe").

GET /api/one/payouts/account/balance

Served from a webhook- and worker-maintained snapshot with a bounded inline
refresh. Owner-scoped by the vault owner token; Cache-Control: private, no-store.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response

from api.middleware import require_vault_owner_token

router = APIRouter(prefix="/api/one/payouts", tags=["One Packet Payouts"])
logger = logging.getLogger(__name__)

_NO_STORE = {"Cache-Control": "private, no-store"}


def _balances() -> Any:
    from hushh_mcp.services.stripe_connect_balances import StripeConnectBalances

    return StripeConnectBalances()


@router.get("/account/balance")
async def get_account_balance(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    """Snapshot read; refreshes inline (<= 2.5 s, single flight) only when stale."""
    response.headers["Cache-Control"] = "private, no-store"
    try:
        balance: dict[str, Any] = await _balances().owner_balance(user_id=token_data["user_id"])
        return balance
    except Exception as exc:
        logger.warning(
            "connect_balance.unavailable code=%s", getattr(exc, "code", type(exc).__name__)
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "BALANCE_UNAVAILABLE",
                "message": "Stripe balance is unavailable. Try again.",
            },
            headers=_NO_STORE,
        ) from None
