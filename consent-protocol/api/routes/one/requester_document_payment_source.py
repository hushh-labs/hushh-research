"""Private, complete source snapshot for a requester's document payments."""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.middleware import require_vault_owner_token
from hushh_mcp.services.requester_document_payment_source import (
    RequesterDocumentPaymentSourceCapacity,
    RequesterDocumentPaymentSourceService,
    RequesterDocumentPaymentSourceUnavailable,
)

logger = logging.getLogger(__name__)
_NO_STORE = "private, no-store"


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"code": code, "message": message},
        headers={"Cache-Control": _NO_STORE},
    )


class _PrivateRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def private_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                raise HTTPException(
                    exc.status_code,
                    exc.detail,
                    headers={**(exc.headers or {}), "Cache-Control": _NO_STORE},
                ) from None
            except RequestValidationError:
                raise _error(422, "INVALID_SOURCE_QUERY", "Check the source request.") from None
            response.headers["Cache-Control"] = _NO_STORE
            return response

        return private_handler


router = APIRouter(
    prefix="/api/one/source-snapshots",
    tags=["One Source Snapshots"],
    route_class=_PrivateRoute,
)


@router.get("/document-request-payments")
async def requester_document_payments(
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    try:
        return cast(
            dict[str, Any],
            await RequesterDocumentPaymentSourceService().snapshot(user_id=token_data["user_id"]),
        )
    except RequesterDocumentPaymentSourceCapacity:
        raise _error(
            503,
            "SOURCE_CAPACITY_EXCEEDED",
            "Payment history exceeds the verified source limit.",
        ) from None
    except (RequesterDocumentPaymentSourceUnavailable, ValueError) as exc:
        logger.warning("requester_payment_source.unavailable type=%s", type(exc).__name__)
        raise _error(503, "SOURCE_UNAVAILABLE", "Payment history is unavailable.") from None
    except Exception as exc:
        logger.error("requester_payment_source.unexpected type=%s", type(exc).__name__)
        raise _error(503, "SOURCE_UNAVAILABLE", "Payment history is unavailable.") from None


__all__ = ["router"]
