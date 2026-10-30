"""Owner payout activity and receipts (read-only).

GET /api/one/payouts/activity        cursor-paginated owner activity
GET /api/one/payouts/activity/{id}   one receipt

Every route is owner-scoped by the vault owner token, returns
Cache-Control: private, no-store, and never exposes Stripe object IDs.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Coroutine
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.middleware import require_vault_owner_token

logger = logging.getLogger(__name__)
_NO_STORE = "private, no-store"
_LIMIT = re.compile(r"^[0-9]{1,2}$")
_URL_DECODED_OFFSET = re.compile(r" ([0-9]{2}:[0-9]{2})$")


class _PrivateRoute(APIRoute):
    """Every response, including auth and validation failures, is private and uncached."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def private_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                headers = {**(exc.headers or {}), "Cache-Control": _NO_STORE}
                raise HTTPException(exc.status_code, exc.detail, headers=headers) from None
            except RequestValidationError:
                raise _error(422, "INVALID_ACTIVITY_QUERY", "Check the activity filters.") from None
            response.headers["Cache-Control"] = _NO_STORE
            return response

        return private_handler


router = APIRouter(
    prefix="/api/one/payouts", tags=["One Packet Payouts"], route_class=_PrivateRoute
)


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"code": code, "message": message},
        headers={"Cache-Control": _NO_STORE},
    )


def _unavailable(exc: Exception) -> HTTPException:
    logger.warning("payout_activity.unavailable type=%s", type(exc).__name__)
    return _error(503, "ACTIVITY_UNAVAILABLE", "Activity is unavailable. Try again.")


def _since(value: str) -> datetime:
    # An unencoded "+" in a query string arrives as a space before the offset.
    stamp = _URL_DECODED_OFFSET.sub(r"+\1", value.strip())
    parsed = datetime.fromisoformat(stamp)
    if parsed.tzinfo is None:
        raise ValueError("since needs a time zone")
    return parsed


@router.get("/activity")
async def get_payout_activity(
    kind: str | None = None,
    mode: str | None = None,
    cursor: str | None = None,
    limit: str | None = None,
    since: str | None = None,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    from hushh_mcp.services.payout_activity_service import (
        ACTIVITY_KINDS,
        ACTIVITY_MODES,
        DEFAULT_LIMIT,
        MAX_CURSOR_CHARS,
        MAX_LIMIT,
        PayoutActivityError,
        PayoutActivityService,
    )
    from hushh_mcp.services.stripe_mode import configured_stripe_mode

    invalid = _error(422, "INVALID_ACTIVITY_QUERY", "Check the activity filters.")
    kind_value = kind if kind is not None else "all"
    if kind_value not in ACTIVITY_KINDS or (mode is not None and mode not in ACTIVITY_MODES):
        raise invalid
    limit_value = DEFAULT_LIMIT
    if limit is not None:
        if not _LIMIT.fullmatch(limit) or not 1 <= int(limit) <= MAX_LIMIT:
            raise invalid
        limit_value = int(limit)
    if cursor is not None and not 1 <= len(cursor) <= MAX_CURSOR_CHARS:
        raise _error(422, "INVALID_CURSOR", "Reload activity.")
    since_value = None
    if since is not None:
        if cursor is not None or len(since) > 64:
            raise invalid
        try:
            since_value = _since(since)
        except ValueError:
            raise invalid from None
    try:
        mode_value = mode if mode is not None else configured_stripe_mode()
        activity: dict[str, Any] = await PayoutActivityService().activity(
            user_id=token_data["user_id"],
            mode=mode_value,
            kind=kind_value,
            cursor=cursor,
            limit=limit_value,
            since=since_value,
        )
        return activity
    except PayoutActivityError as exc:
        if exc.code == "invalid_cursor":
            raise _error(422, "INVALID_CURSOR", "Reload activity.") from None
        raise invalid from None
    except Exception as exc:
        raise _unavailable(exc) from None


@router.get("/activity/{item_id}")
async def get_payout_activity_item(
    item_id: str,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    from hushh_mcp.services.payout_activity_service import (
        ITEM_ID,
        PayoutActivityError,
        PayoutActivityService,
    )

    if not ITEM_ID.fullmatch(item_id):
        raise _error(422, "INVALID_ITEM_ID", "This item link is not valid.")
    try:
        receipt: dict[str, Any] | None = await PayoutActivityService().receipt(
            user_id=token_data["user_id"], item_id=item_id
        )
    except PayoutActivityError:
        raise _error(422, "INVALID_ITEM_ID", "This item link is not valid.") from None
    except Exception as exc:
        raise _unavailable(exc) from None
    if receipt is None:
        raise _error(404, "ACTIVITY_ITEM_NOT_FOUND", "This item isn't available.")
    return receipt
