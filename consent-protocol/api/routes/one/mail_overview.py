"""Browser-facing reads for the Mail Overview: recent mail, search, exact open, reply source.

Every route authenticates the vault owner, admits only a Shared owner through the
hub content guard, resolves the connected Mail account on the server and refuses
(never falls back) when the browser's expected account is not that account. The
contract lives in ``hushh_mcp.services.mail_overview``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services import mail_overview, mail_overview_brief
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service
from hushh_mcp.services.mail_overview import MailOverviewError
from hushh_mcp.services.owner_placement_guard import hub_content_owner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/mail/overview", tags=["One Mail Overview"])

# The Google account the browser last saw, as the connection status reports it.
_ExpectedAccount = Field(default=None, min_length=1, max_length=256)


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_account: str | None = _ExpectedAccount


class RecentRequest(_Request):
    limit: int = Field(default=mail_overview.DEFAULT_RECENT_ROWS, ge=1, le=mail_overview.ROW_LIMIT)


class SearchRequest(_Request):
    # An explicit query, never the empty string: nothing here turns "search" into "recent".
    query: str = Field(min_length=1, max_length=512)
    limit: int = Field(default=mail_overview.ROW_LIMIT, ge=1, le=mail_overview.ROW_LIMIT)


class SourceRequest(_Request):
    source_id: str = Field(pattern=mail_overview.SOURCE_ID_PATTERN)


def _owner(token_data: dict[str, Any]) -> str:
    return str(token_data.get("user_id") or "").strip()


def _http(exc: MailOverviewError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code, detail={"code": exc.code, "message": exc.message}
    )


def _no_store(response: Response) -> None:
    # Mail content: never cached by a proxy or a shared cache.
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"


@router.post("/brief")
async def brief(
    payload: _Request,
    response: Response,
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    """What needs the owner and what changed, each item verified against the mail it cites."""
    _no_store(response)
    try:
        result: dict[str, Any] = await mail_overview_brief.build_brief(
            gmail=get_gmail_receipts_service(),
            user_id=_owner(token_data),
            consent_token=str(token_data.get("token") or ""),
            expected_account=payload.expected_account,
        )
        return result
    except MailOverviewError as exc:
        logger.warning("one.mail_overview.brief_failed code=%s", exc.code)
        raise _http(exc) from None


@router.post("/completed")
async def completed(
    payload: _Request,
    response: Response,
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    """Confirmed sends only: a recorded successful send found in the connected mailbox."""
    _no_store(response)
    try:
        result: dict[str, Any] = await mail_overview_brief.completed_items(
            gmail=get_gmail_receipts_service(),
            user_id=_owner(token_data),
            expected_account=payload.expected_account,
        )
        return result
    except MailOverviewError as exc:
        logger.warning("one.mail_overview.completed_failed code=%s", exc.code)
        raise _http(exc) from None


@router.post("/recent")
async def recent_mail(
    payload: RecentRequest,
    response: Response,
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    _no_store(response)
    try:
        result: dict[str, Any] = await mail_overview.list_messages(
            gmail=get_gmail_receipts_service(),
            user_id=_owner(token_data),
            query="",
            limit=payload.limit,
            expected_account=payload.expected_account,
        )
        return result
    except MailOverviewError as exc:
        logger.warning("one.mail_overview.recent_failed code=%s", exc.code)
        raise _http(exc) from None


@router.post("/search")
async def search_mail(
    payload: SearchRequest,
    response: Response,
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    _no_store(response)
    try:
        result: dict[str, Any] = await mail_overview.list_messages(
            gmail=get_gmail_receipts_service(),
            user_id=_owner(token_data),
            query=payload.query,
            limit=payload.limit,
            expected_account=payload.expected_account,
        )
        return result
    except MailOverviewError as exc:
        # The query is mail-derived input: only the failure code is ever logged.
        logger.warning("one.mail_overview.search_failed code=%s", exc.code)
        raise _http(exc) from None


@router.post("/open")
async def open_mail(
    payload: SourceRequest,
    response: Response,
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    _no_store(response)
    try:
        result: dict[str, Any] = await mail_overview.open_message(
            gmail=get_gmail_receipts_service(),
            user_id=_owner(token_data),
            source_id=payload.source_id,
            expected_account=payload.expected_account,
        )
        return result
    except MailOverviewError as exc:
        logger.warning("one.mail_overview.open_failed code=%s", exc.code)
        raise _http(exc) from None


@router.post("/reply-source")
async def reply_source(
    payload: SourceRequest,
    response: Response,
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    _no_store(response)
    try:
        result: dict[str, Any] = await mail_overview.prepare_reply(
            gmail=get_gmail_receipts_service(),
            user_id=_owner(token_data),
            source_id=payload.source_id,
            expected_account=payload.expected_account,
        )
        return result
    except MailOverviewError as exc:
        logger.warning("one.mail_overview.reply_source_failed code=%s", exc.code)
        raise _http(exc) from None
