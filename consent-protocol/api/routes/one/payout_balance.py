"""The owner's connected-account Stripe balance ("In Stripe").

GET /api/one/payouts/account/balance

Served from a webhook- and worker-maintained snapshot with a bounded inline
refresh. Owner-scoped by the vault owner token; every response, including auth
and validation failures, is Cache-Control: private, no-store.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.middleware import require_vault_owner_token

logger = logging.getLogger(__name__)

_NO_STORE = {"Cache-Control": "private, no-store"}


class _PrivateRoute(APIRoute):
    """Auth (401/403/423), validation and route errors are private and uncached too."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def private_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                headers = {**(exc.headers or {}), **_NO_STORE}
                raise HTTPException(exc.status_code, exc.detail, headers=headers) from None
            except RequestValidationError:
                raise HTTPException(
                    status_code=422,
                    detail={"code": "INVALID_BALANCE_REQUEST", "message": "Check the request."},
                    headers=_NO_STORE,
                ) from None
            response.headers.update(_NO_STORE)
            return response

        return private_handler


router = APIRouter(
    prefix="/api/one/payouts", tags=["One Packet Payouts"], route_class=_PrivateRoute
)


def _balances() -> Any:
    from hushh_mcp.services.stripe_connect_balances import StripeConnectBalances

    return StripeConnectBalances()


@router.get("/account/balance")
async def get_account_balance(
    response: Response, token_data: dict = Depends(require_vault_owner_token)
) -> dict[str, Any]:
    """Snapshot read; refreshes inline (<= 2.5 s, single flight) only when stale."""
    response.headers.update(_NO_STORE)
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
