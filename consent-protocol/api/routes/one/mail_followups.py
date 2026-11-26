"""Interactive Mail follow-ups for the Shared owner's existing Gmail grant."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from api.utils.private_no_store import PRIVATE_NO_STORE_HEADERS, PrivateNoStoreRoute
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataReader
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service
from hushh_mcp.services.google_connection_service import get_google_connection_service
from hushh_mcp.services.owner_placement_guard import hub_content_owner, require_hub_content_current
from hushh_mcp.services.pod_mail_followups import (
    Document,
    Search,
    Selection,
    Source,
    Track,
    Tracked,
    assess_mail,
)
from hushh_mcp.services.shared_mail_accounts import SharedAdditionalGmail, additional_mailboxes

router = APIRouter(prefix="/api/one/mail/followups", route_class=PrivateNoStoreRoute)
INPUTS = {
    "account": Selection,
    "disconnect": Selection,
    "search": Search,
    "open": Source,
    "track": Track,
    "check": Tracked,
    "draft": Track,
    "document": Document,
}


def custody_key():
    key = get_core_security_settings().app_signing_key
    if not key:
        raise HTTPException(503)
    return key.encode()


async def shared_mail(operation, request, claims):
    owner, token = claims["user_id"], claims["token"]
    gmail = get_gmail_receipts_service()

    async def authorized():
        if (
            not connector_feature_enabled("gmail_chat_reads", owner)
            or await validate_first_party_owner_token(owner, token) is None
        ):
            raise HTTPException(403)

    async def mailbox():
        await require_hub_content_current(owner, "mail_followups", authorized)
        row = await asyncio.to_thread(gmail._fetch_connection_row, user_id=owner)
        if (
            not row
            or row.get("status") != "connected"
            or row.get("revoked") is not False
            or not all(
                row.get(key) for key in ("google_sub", "google_email", "followup_read_generation")
            )
        ):
            raise HTTPException(409)
        return {
            "account": str(row["google_sub"]),
            "connection": str(row["followup_read_generation"]),
            "address": str(row["google_email"]),
        }

    try:
        async with asyncio.timeout(45):
            await require_hub_content_current(owner, "mail_followups", authorized)
            data = bytearray()
            async for chunk in request.stream():
                if len(data) + len(chunk) > 32768:
                    raise HTTPException(413)
                data.extend(chunk)
            if operation == "inventory":
                if data != b"{}":
                    raise HTTPException(422)
                try:
                    primary = await mailbox()
                except HTTPException as exc:
                    if exc.status_code != 409:
                        raise
                    primary = None
                result = {
                    "default": primary,
                    "additional": await additional_mailboxes(
                        get_google_connection_service(), owner
                    ),
                }
                await require_hub_content_current(owner, "mail_followups", authorized)
            else:
                try:
                    selected = INPUTS[operation].model_validate_json(data)
                except ValueError:
                    raise HTTPException(422) from None
                if selected.account.startswith("additional/"):
                    google = get_google_connection_service()
                    slot = selected.account.removeprefix("additional/")
                    if not slot or slot == "default":
                        raise HTTPException(409)

                    async def binding_now():
                        await require_hub_content_current(owner, "mail_followups", authorized)
                        binding = await google.read_grant_binding(
                            user_id=owner, service="gmail", account_id=slot
                        )
                        if not binding or len(binding) != 8 or binding[-1] != selected.connection:
                            raise HTTPException(409)
                        return binding

                    binding = await binding_now()
                    box = next(
                        (
                            r
                            for r in await additional_mailboxes(google, owner)
                            if r["account"] == selected.account
                            and r["connection"] == selected.connection
                        ),
                        None,
                    )
                    if not box:
                        raise HTTPException(409)
                    if operation == "disconnect":
                        await google.disconnect_mail_read_grant(
                            user_id=owner, account_id=slot, expected_generation=selected.connection
                        )
                        return JSONResponse(
                            {"disconnected": True}, headers=PRIVATE_NO_STORE_HEADERS
                        )
                    port = SharedAdditionalGmail(google, owner, box, binding)
                    subject = binding[3]

                    async def check():
                        if await binding_now() != binding:
                            raise HTTPException(409)
                else:
                    if operation == "disconnect":
                        raise HTTPException(409)
                    box = await mailbox()
                    if (selected.account, selected.connection) != (
                        box["account"],
                        box["connection"],
                    ):
                        raise HTTPException(409)
                    port = gmail
                    subject = box["account"]

                    async def check():
                        if await mailbox() != box:
                            raise HTTPException(409)

                def reader():
                    return GmailMetadataReader(
                        gmail=port,
                        user_id=owner,
                        require_access=check,
                        expect_account=subject,
                        expose_message_links=True,
                    )

                result = await assess_mail(
                    operation,
                    selected,
                    owner=owner,
                    new_reader=reader,
                    credential_id=box["connection"],
                    key_resolver=custody_key,
                    owner_address=lambda: box["address"],
                    consent_token=token,
                    model_factory=lambda: None,
                )
                await check()
            return JSONResponse(result, headers=PRIVATE_NO_STORE_HEADERS)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            503, detail={"code": "MAIL_FOLLOWUP_UNAVAILABLE"}, headers=PRIVATE_NO_STORE_HEADERS
        ) from None


def register(operation):
    async def handle(request: Request, owner: dict = Depends(hub_content_owner)):
        return await shared_mail(operation, request, owner)

    router.add_api_route(
        "/" + operation, handle, methods=["POST"], name="shared_mail_followup_" + operation
    )


for name in ("inventory", *INPUTS):
    register(name)
