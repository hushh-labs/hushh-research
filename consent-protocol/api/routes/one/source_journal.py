"""Private committed source change hints for unlocked owner clients."""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Coroutine
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.middleware import require_vault_owner_token
from hushh_mcp.services.source_journal_service import (
    MAX_PAGE_SIZE,
    SourceJournalService,
    SourceJournalUnavailable,
)

logger = logging.getLogger(__name__)
_NO_STORE = {"Cache-Control": "private, no-store"}
_CURSOR = re.compile(r"^(0|[1-9][0-9]{0,18})$")
_LIMIT = re.compile(r"^[1-9][0-9]{0,2}$")


class _PrivateRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def private_handler(request: Request) -> Response:
            try:
                response = await handler(request)
            except StarletteHTTPException as exc:
                raise HTTPException(
                    exc.status_code, exc.detail, headers={**(exc.headers or {}), **_NO_STORE}
                ) from None
            except RequestValidationError:
                raise _error(422, "INVALID_JOURNAL_QUERY", "Check the replay cursor.") from None
            response.headers.update(_NO_STORE)
            return response

        return private_handler


router = APIRouter(
    prefix="/api/one/source-journal", tags=["One Source Journal"], route_class=_PrivateRoute
)


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status, detail={"code": code, "message": message}, headers=_NO_STORE
    )


@router.get("/connectors")
async def get_connector_events(
    after: str = "0",
    limit: str = "100",
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if not _CURSOR.fullmatch(after) or int(after) > 2**63 - 1:
        raise _error(422, "INVALID_JOURNAL_CURSOR", "Reload connector information.")
    if not _LIMIT.fullmatch(limit) or int(limit) > MAX_PAGE_SIZE:
        raise _error(422, "INVALID_JOURNAL_QUERY", "Check the replay page size.")
    try:
        return cast(
            dict[str, Any],
            await SourceJournalService().connector_events(
                user_id=token_data["user_id"], after=int(after), limit=int(limit)
            ),
        )
    except (SourceJournalUnavailable, ValueError) as exc:
        logger.warning("source_journal.unavailable type=%s", type(exc).__name__)
        raise _error(503, "JOURNAL_UNAVAILABLE", "Connector changes are unavailable.") from None
    except Exception as exc:
        logger.error("source_journal.unexpected type=%s", type(exc).__name__)
        raise _error(503, "JOURNAL_UNAVAILABLE", "Connector changes are unavailable.") from None


@router.get("/events")
async def get_source_events(
    after: str = "0",
    limit: str = "100",
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    if not _CURSOR.fullmatch(after) or int(after) > 2**63 - 1:
        raise _error(422, "INVALID_JOURNAL_CURSOR", "Reload source information.")
    if not _LIMIT.fullmatch(limit) or int(limit) > MAX_PAGE_SIZE:
        raise _error(422, "INVALID_JOURNAL_QUERY", "Check the replay page size.")
    try:
        return cast(
            dict[str, Any],
            await SourceJournalService().events(
                user_id=token_data["user_id"], after=int(after), limit=int(limit)
            ),
        )
    except (SourceJournalUnavailable, ValueError) as exc:
        logger.warning("source_journal.unavailable type=%s", type(exc).__name__)
        raise _error(503, "JOURNAL_UNAVAILABLE", "Source changes are unavailable.") from None
    except Exception as exc:
        logger.error("source_journal.unexpected type=%s", type(exc).__name__)
        raise _error(503, "JOURNAL_UNAVAILABLE", "Source changes are unavailable.") from None


__all__ = ["router"]
