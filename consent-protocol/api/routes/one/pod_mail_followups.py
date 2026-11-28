"""Read and assess one owner's selected mail inside their private agent."""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from api.routes.one.pod_todo_sources import _admit, _door, _refuse, private_workspace_model
from api.utils.private_no_store import PrivateNoStoreRoute
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError
from hushh_mcp.services.mail_overview import MailOverviewError
from hushh_mcp.services.pod_mail_followups import (
    Document,
    OpenMessage,
    Search,
    Selection,
    Track,
    Tracked,
    run_mail,
)

router = APIRouter(prefix="/api/one/pod/gmail/followups", route_class=PrivateNoStoreRoute)


MailOperation = Literal[
    "brief", "recent", "account", "search", "open", "track", "check", "draft", "document"
]
REQUEST_TYPES: dict[MailOperation, type[Selection]] = {
    "brief": Selection,
    "recent": Selection,
    "account": Selection,
    "search": Search,
    "open": OpenMessage,
    "track": Track,
    "check": Tracked,
    "draft": Track,
    "document": Document,
}


async def mail_followups(
    operation: MailOperation,
    request: Request,
    authorization: str | None = Header(default=None),
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
):
    door = await _door(x_consent_token, authorization)
    owner = await _admit(door)

    async def check():
        if await _admit(door) != owner:
            raise _refuse(403, "POD_OWNER_CHANGED")

    try:
        async with asyncio.timeout(45):
            data = bytearray()
            async for chunk in request.stream():
                if len(data) + len(chunk) > 32768:
                    raise _refuse(413, "MAIL_REQUEST_TOO_LARGE")
                data.extend(chunk)
            try:
                selection = REQUEST_TYPES[operation].model_validate_json(data)
            except ValidationError:
                raise _refuse(422, "INVALID_MAIL_REQUEST") from None
            result = await run_mail(
                operation,
                selection,
                owner=owner,
                check=check,
                consent_token=door["consent_token"],
                model_factory=private_workspace_model,
            )
            return JSONResponse(result, headers={"Cache-Control": "private, no-store"})
    except HTTPException:
        raise
    except MailOverviewError as exc:
        logging.getLogger(__name__).warning(
            "private_mail_read operation=%s code=%s", operation, exc.code
        )
        raise _refuse(exc.status_code, exc.code) from None
    except TimeoutError:
        logging.getLogger(__name__).warning(
            "private_mail_read operation=%s code=deadline", operation
        )
        raise _refuse(503, "MAIL_FOLLOWUP_UNAVAILABLE") from None
    except GmailMetadataError as exc:
        if exc.code == "retryable":
            logging.getLogger(__name__).warning(
                "private_mail_read operation=%s code=provider_unavailable", operation
            )
            raise _refuse(503, "MAIL_FOLLOWUP_UNAVAILABLE") from None
        raise _refuse(409, "MAIL_" + exc.code.upper()) from None
    except Exception:
        logging.getLogger(__name__).warning(
            "private_mail_read operation=%s code=unexpected", operation
        )
        raise _refuse(503, "MAIL_FOLLOWUP_UNAVAILABLE") from None


def register(operation: MailOperation) -> None:
    async def handle(
        request: Request,
        authorization: str | None = Header(default=None),
        x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    ):
        return await mail_followups(operation, request, authorization, x_consent_token)

    router.add_api_route(
        "/" + operation, handle, methods=["POST"], name="mail_followup_" + operation
    )


for operation in REQUEST_TYPES:
    register(operation)
