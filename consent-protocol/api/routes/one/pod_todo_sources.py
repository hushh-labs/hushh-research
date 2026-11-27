"""Bounded Calendar/email reads and explicitly approved suggestions in the owner's pod.

No hub content door, provider mutation or body/snippet read. Only the explicit
suggestion door invokes a model through the owner's existing runtime selection.
These doors require the owner's app session with pkm.read, not pod.status.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from api.routes.one.pod_owner_door import admit_owner_local, owner_local_door
from api.utils.private_no_store import PrivateNoStoreRoute
from hushh_mcp.services.pod_session_authority import SCOPE_PKM_READ

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"], route_class=PrivateNoStoreRoute)
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
    from hushh_mcp.services.pod_owner_cloud import (
        personal_sandbox_workspace_runtime,
        pod_owner_user_id,
    )
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
    # Match the existing local Google ports; legacy managed hosting is not newly admitted.
    if not personal_sandbox_workspace_runtime():
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


async def _suggestion_owner(door: dict[str, Any]) -> str:
    from hushh_mcp.services.pod_owner_cloud import pod_owner_user_id
    from hushh_mcp.services.pod_session_authority import active_session_authority

    claims = await admit_owner_local(
        door["consent_token"],
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_PKM_READ,
    )
    await active_session_authority().require_held()
    if claims["user_id"] != pod_owner_user_id():
        raise _refuse(403, "POD_OWNER_CHANGED")
    return str(claims["user_id"])


def private_workspace_model() -> Any:
    from api.routes.one import pod_turn
    from hushh_mcp.one_adk.text_runtime import _runtime_model

    payload = pod_turn.PodTurnRequest(message="private-task-suggestions")
    provider, model = pod_turn._resolve_model()
    payload, (provider, model, mode) = pod_turn._resolve_owner_target(payload, provider, model)
    # This surface never borrows the Shared service's model credentials.
    if mode not in {"user_adc", "hosted_pod_adc", "sentinel_vertex", "byok", "user_azure_mi"}:
        raise _refuse(503, "PRIVATE_TASK_MODEL_UNAVAILABLE")
    return _runtime_model(
        runtime_model=model,
        runtime_mode=mode,
        runtime_provider=provider,
        runtime_credential=payload.runtime_credential,
        puppy_device_id=payload.puppy_device_id,
        runtime_credential_transport=payload.runtime_credential_transport,
        runtime_vertex_project=payload.vertex_project,
        runtime_vertex_location=payload.vertex_location,
    )


async def _private_todo_gene(**kwargs: Any) -> object:
    from hushh_mcp.services.one_todo_suggestions import run_todo_gene

    return await run_todo_gene(**kwargs, model=private_workspace_model())


async def run_task_suggestions(body: Any, *, runner: Any = None, **door: Any) -> dict:
    from hushh_mcp.services.one_todo_suggestions import suggest_tasks

    owner = await _suggestion_owner(door)

    async def current() -> None:
        if await _suggestion_owner(door) != owner:
            raise _refuse(403, "POD_OWNER_CHANGED")

    result = await suggest_tasks(
        body,
        user_id=owner,
        consent_token=door["consent_token"],
        require_access=current,
        runner=runner or _private_todo_gene,
    )
    return dict(result.model_dump())


@router.get("/todos/suggestions/status")
async def task_suggestion_status_route(
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    from hushh_mcp.runtime_settings import one_todo_suggestions_enabled

    await _suggestion_owner(await _door(x_consent_token, authorization))
    return JSONResponse({"available": one_todo_suggestions_enabled()}, headers=_HEADERS)


@router.post("/todos/suggestions")
async def task_suggestions_route(
    request: Request,
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    from api.routes.one.pod_commands import _admitted
    from hushh_mcp.services.one_todo_suggestions import TaskSuggestionRequest

    door = await _door(x_consent_token, authorization)
    await _suggestion_owner(door)
    try:
        # Consume the authenticated bounded body before the existing disconnect
        # watcher starts reading receive(); it must not consume request chunks.
        raw = bytearray()
        async with asyncio.timeout(25):
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 160_000:
                    raise _refuse(413, "TASK_REQUEST_TOO_LARGE")
        try:
            body = TaskSuggestionRequest.model_validate_json(raw)
        except (ValidationError, ValueError):
            raise _refuse(422, "INVALID_TASK_REQUEST") from None
        # Existing bounded execution, drain admission, disconnect cancellation and cleanup.
        async with _admitted(authorization, request):
            try:
                result = await run_task_suggestions(body, **door)
            except HTTPException:
                raise
            except PermissionError:
                raise _refuse(403, "TASK_PROCESSING_APPROVAL_REQUIRED") from None
            except Exception:
                raise _refuse(503, "TASK_SUGGESTIONS_UNAVAILABLE") from None
        return JSONResponse(result, headers=_HEADERS)
    except HTTPException:
        raise
    except PermissionError:
        raise _refuse(403, "TASK_PROCESSING_APPROVAL_REQUIRED") from None
    except Exception:
        raise _refuse(503, "TASK_SUGGESTIONS_UNAVAILABLE") from None
