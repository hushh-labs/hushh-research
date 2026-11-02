"""Bounded Calendar and email metadata for the owner's task list, read in their pod.

No hub content door, model invocation, provider mutation or body/snippet read.
These doors require the owner's app session with pkm.read, not pod.status.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from api.routes.one.pod_owner_door import admit_owner_local, owner_local_door
from hushh_mcp.services.pod_session_authority import SCOPE_PKM_READ

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])
_HEADERS = {"Cache-Control": "private, no-store"}


def _refuse(status: int, code: str) -> HTTPException:
    return HTTPException(
        status_code=status, detail={"code": code, "reason_code": code.lower()}, headers=_HEADERS
    )


class CalendarWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_at: str = Field(strict=True, max_length=64)
    end_at: str = Field(strict=True, max_length=64)

    @model_validator(mode="after")
    def bounded(self) -> CalendarWindow:
        start = datetime.fromisoformat(self.start_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(self.end_at.replace("Z", "+00:00"))
        if (
            start.tzinfo is None
            or end.tzinfo is None
            or not timedelta(0) < end - start <= timedelta(days=7)
        ):
            raise ValueError("Calendar window must be offset-aware and at most seven days")
        return self


async def _admit(door: dict[str, Any]) -> str:
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent, pod_owner_user_id
    from hushh_mcp.services.pod_session_authority import (
        PodSessionRefused,
        active_session_authority,
    )

    claims = await admit_owner_local(
        door["consent_token"],
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_PKM_READ,
    )
    try:
        await active_session_authority().require_held()
    except PodSessionRefused:
        raise _refuse(409, "POD_SESSION_CHANGED") from None
    # Match the existing local Google ports; managed hosting is not newly admitted.
    if not owner_cloud_agent():
        raise _refuse(503, "OWNER_GOOGLE_READ_UNAVAILABLE")
    if claims["user_id"] != pod_owner_user_id():
        raise _refuse(403, "POD_OWNER_CHANGED")
    return str(claims["user_id"])


def _key(owner: str, account: str, identity: str) -> str:
    return hashlib.sha256(json.dumps([owner, account, identity]).encode()).hexdigest()


def _calendar_event(event: dict, owner: str, account: str) -> dict:
    result = {key: event.get(key) for key in ("title", "start", "end", "status")}
    result["id"] = _key(owner, account, f"primary:{event['id']}")
    for key in ("start", "end"):
        raw = result[key]
        result[key] = (
            {k: v for k, v in raw.items() if k in {"date", "dateTime", "timeZone"}}
            if isinstance(raw, dict)
            else None
        )
    meeting = event.get("conference_url")
    try:
        url = urlsplit(meeting) if isinstance(meeting, str) else None
        if (
            url
            and url.scheme == "https"
            and url.hostname == "meet.google.com"
            and not url.username
            and not url.password
            and not url.port
        ):
            result["conference_url"] = meeting
    except ValueError:
        pass
    return result


async def run_calendar_events(window: CalendarWindow, **door: Any) -> dict:
    from hushh_mcp.services.google_connection_service import GoogleConnectionError
    from hushh_mcp.services.pod_google_connections import pod_calendar_service

    owner = await _admit(door)
    service = pod_calendar_service()
    if service is None:
        raise _refuse(503, "OWNER_GOOGLE_READ_UNAVAILABLE")
    try:
        held = service.connections.require_current()
        binding = await service.connections.read_grant_binding(user_id=owner, service="calendar")
        if not binding:
            raise _refuse(409, "CALENDAR_PERMISSION_REQUIRED")
        events: dict[str, dict] = {}
        cursor = None
        cursors: set[str] = set()
        page: dict = {}
        for _ in range(5):
            await _admit(door)
            page = await service.list_events(
                user_id=owner,
                start_at=window.start_at,
                end_at=window.end_at,
                max_results=100,
                page_token=cursor,
                expected_binding=binding,
            )
            if len(page["events"]) > 100:
                raise _refuse(502, "CALENDAR_INVALID_RESPONSE")
            for item in page["events"]:
                if not isinstance(item.get("id"), str) or not item["id"]:
                    raise _refuse(502, "CALENDAR_INVALID_RESPONSE")
                events[item["id"]] = _calendar_event(item, owner, held.account_subject)
            if not page.get("has_more"):
                break
            cursor = page.get("next_page_token")
            if not isinstance(cursor, str) or not cursor or cursor in cursors:
                raise _refuse(502, "CALENDAR_INVALID_RESPONSE")
            cursors.add(cursor)
        await _admit(door)
        if (
            await service.connections.read_grant_binding(user_id=owner, service="calendar")
            != binding
        ):
            raise _refuse(409, "GOOGLE_CONNECTION_CHANGED")
        service.connections.require_current()
        return {
            "events": list(events.values()),
            "time_zone": page.get("time_zone"),
            "truncated": bool(page.get("has_more")),
        }
    except GoogleConnectionError as exc:
        reason = (exc.reason_code or "calendar_read_unavailable").replace("google_", "calendar_", 1)
        # Provider grant failure must not masquerade as an expired app session.
        raise _refuse(409 if exc.status_code in {401, 403} else exc.status_code, reason) from None


async def run_mail_todos(**door: Any) -> dict:
    from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError
    from hushh_mcp.services.pod_gmail_local import PodLocalEmailReadPort

    owner = await _admit(door)

    async def current() -> None:
        if await _admit(door) != owner:
            raise _refuse(403, "POD_OWNER_CHANGED")

    port = PodLocalEmailReadPort(owner, owner_session=True)
    try:
        reader = port.metadata_reader(gmail=port, user_id=owner, require_access=current)
        page = await reader.read("list_needs_reply", {"limit": 25, "mailbox": "inbox"})
        rows = page["untrusted_external_content"]
        identities = reader.offered_message_ids()
        if len(rows) != len(identities):
            raise _refuse(502, "MAIL_INVALID_RESPONSE")
        items = []
        for row, identity in zip(rows, identities, strict=True):
            sender = str(row.get("sender") or "").strip()
            subject = str(row.get("subject") or "(no subject)").strip()
            items.append(
                {
                    "key": _key(owner, reader.account, identity),
                    "title": f"{'Reply to ' + sender if sender else 'Reply'}: {subject}"[:240],
                }
            )
        await current()
        await reader.require_current()
        return {
            "items": items,
            "complete": not page.get("truncated", True),
            "scope": "recent_threads",
        }
    except GmailMetadataError as exc:
        raise _refuse(503 if exc.code == "retryable" else 409, "MAIL_READ_UNAVAILABLE") from None


async def _door(x_consent_token: str | None, authorization: str | None) -> dict:
    return await owner_local_door(x_consent_token, authorization, scope=SCOPE_PKM_READ, held=True)


@router.post("/calendar/events")
async def calendar_events_route(
    request: Request,
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    door = await _door(x_consent_token, authorization)
    await _admit(door)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2048:
            raise _refuse(413, "CALENDAR_WINDOW_INVALID")
    try:
        window = CalendarWindow.model_validate_json(body)
    except (ValidationError, ValueError):
        raise _refuse(422, "CALENDAR_WINDOW_INVALID") from None
    return JSONResponse(await run_calendar_events(window, **door), headers=_HEADERS)


@router.get("/gmail/todos")
async def mail_todos_route(
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    return JSONResponse(
        await run_mail_todos(**await _door(x_consent_token, authorization)), headers=_HEADERS
    )
