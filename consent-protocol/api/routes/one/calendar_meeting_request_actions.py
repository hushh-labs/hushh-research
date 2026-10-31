"""Owner-bound Calendar meeting request actions: create and read-only readiness."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any


async def _owned(
    token: dict, response: Any, operation: Callable[[Any], Awaitable[Any]], http_error
):
    from api.routes.drive_sharing_owner import ContentOwner, sharing_error
    from hushh_mcp.services.drive_sharing_contract import DriveSharingError

    response.headers["Cache-Control"] = "private, no-store"
    owner = ContentOwner(token["user_id"], token["token"])
    try:
        await owner.require_current()
        result = await operation(owner)
        await owner.require_current()
        return result
    except DriveSharingError as exc:
        raise sharing_error(exc) from None
    except Exception as exc:
        raise http_error(exc) from exc


async def create_request(payload, response, token: dict, *, http_error):
    """Bind a selected Calendar attendee and occurrence to a manual Drive request."""
    from hushh_mcp.services.calendar_meeting_request_service import CalendarMeetingRequestService
    from hushh_mcp.services.drive_sharing_service import DriveSharingService

    async def run(owner):
        service = CalendarMeetingRequestService(
            sharing=DriveSharingService(require_owner=owner.require_current)
        )
        return await service.create(
            user_id=owner.user_id,
            **payload.model_dump(exclude={"expected_account_email"}),
        )

    return await _owned(token, response, run, http_error)


async def request_readiness(payload, response, token: dict, *, http_error):
    """Report whether the verified organizer can receive a request now. Read-only, advisory."""
    from hushh_mcp.services.calendar_meeting_request_service import request_readiness as readiness

    async def run(owner):
        return await readiness(
            user_id=owner.user_id,
            **payload.model_dump(exclude={"expected_account_email"}),
        )

    return await _owned(token, response, run, http_error)
