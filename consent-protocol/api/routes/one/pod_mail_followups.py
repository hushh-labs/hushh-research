"""Read and assess one owner's selected mail inside their private agent."""

from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from api.routes.one.pod_todo_sources import _admit, _door, _refuse, private_workspace_model
from api.utils.private_no_store import PrivateNoStoreRoute
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError
from hushh_mcp.services.pod_mail_followups import (
    Document,
    Search,
    Selection,
    Source,
    Track,
    Tracked,
    run_mail,
)

router = APIRouter(prefix="/api/one/pod/gmail/followups", route_class=PrivateNoStoreRoute)


async def mail_followups(
    operation: Literal["account", "search", "open", "track", "check", "draft", "document"],
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
                if len(data) + len(chunk) > 8192:
                    raise _refuse(413, "MAIL_REQUEST_TOO_LARGE")
                data.extend(chunk)
            classes = {
                "account": Selection,
                "search": Search,
                "open": Source,
                "track": Track,
                "check": Tracked,
                "draft": Track,
                "document": Document,
            }
            try:
                selection = (
                    classes[operation].model_validate_json(data) if operation in classes else None
                )
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
    except GmailMetadataError as exc:
        raise _refuse(409, "MAIL_" + exc.code.upper()) from None
    except Exception:
        raise _refuse(503, "MAIL_FOLLOWUP_UNAVAILABLE") from None


def register(operation: str) -> None:
    async def handle(
        request: Request,
        authorization: str | None = Header(default=None),
        x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    ):
        return await mail_followups(operation, request, authorization, x_consent_token)

    router.add_api_route(
        "/" + operation, handle, methods=["POST"], name="mail_followup_" + operation
    )


for operation in ("account", "search", "open", "track", "check", "draft", "document"):
    register(operation)
