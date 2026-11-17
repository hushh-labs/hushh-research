"""Connected Calendar workspace APIs, separate from lifecycle/chat/setup contracts."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from api.middleware import (
    require_firebase_auth,
    verify_user_id_match,
)
from api.middlewares.observability import get_request_id
from api.middlewares.rate_limit import limiter
from api.routes.one.calendar import _http
from api.routes.one.calendar_workspace_models import (
    CalendarAttendanceConfirm,
    CalendarAttendanceReview,
    CalendarAvailabilityWindow,
    CalendarBoardDay,
    CalendarConflictConfirmRequest,
    CalendarConflictReviewRequest,
    CalendarDay,
    CalendarInsightsDay,
    CalendarInvitationsWindow,
    CalendarMeetingDownload,
    CalendarMeetingFileRequest,
    CalendarMeetingPage,
    CalendarMeetingRequiredSelection,
    CalendarMeetingSelection,
    CalendarMeetingStatusBatch,
    CalendarPublicOptions,
    CalendarRsvpConfirm,
    CalendarRsvpReview,
    CalendarWorkspaceAttendanceConfirm,
    CalendarWorkspaceAttendanceReview,
    CalendarWorkspaceConflictConfirm,
    CalendarWorkspaceConflictReview,
)
from api.routes.one.calendar_workspace_models import (
    CalendarDeclineChoice as CalendarDeclineChoice,
)
from api.routes.one.calendar_workspace_models import (
    CalendarEventRef as CalendarEventRef,
)
from api.routes.one.calendar_workspace_models import (
    CalendarOpeningWindow as CalendarOpeningWindow,
)
from hushh_mcp.services.calendar_directory_portraits import invitation_response_with_portraits
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.owner_placement_guard import (
    admit_hub_content,
    hub_content_firebase,
    hub_content_firebase_read_only,
    hub_content_owner,
)

router = APIRouter(prefix="/api/one/calendar", tags=["One Calendar Workspace"])


# Schedule reads require Firebase identity and the owner's Google Calendar grant.
# Calendar mutations below have separate, explicit Firebase + Google grant
# boundaries; read authority alone never grants a mutation.
def _schedule(account_id: str = "default"):
    if account_id != "default":
        from hushh_mcp.services.calendar_account_board_service import account_schedule

        return account_schedule(account_id)
    from hushh_mcp.services.calendar_schedule_service import get_calendar_schedule_service

    return get_calendar_schedule_service()


def _selected_schedule(account_id: str):
    return _schedule() if account_id == "default" else _schedule(account_id)


@router.post("/board/day")
async def calendar_board_day(
    payload: CalendarBoardDay,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        from hushh_mcp.services.calendar_account_board_service import CalendarAccountBoardService

        response.headers["Cache-Control"] = "private, no-store"
        return await CalendarAccountBoardService().day(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/conflicts/review")
async def calendar_conflict_review(
    payload: CalendarConflictReviewRequest,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        from hushh_mcp.services.calendar_conflict_service import CalendarConflictService

        return await CalendarConflictService().review(
            user_id=token["user_id"], **payload.model_dump()
        )
    except (GmailDeliveryError, GmailApiError) as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "reason_code": exc.code, "message": str(exc)},
        ) from exc
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/conflicts/confirm")
async def calendar_conflict_confirm(
    payload: CalendarConflictConfirmRequest,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    try:
        from hushh_mcp.services.calendar_conflict_service import CalendarConflictService

        return await CalendarConflictService().confirm(
            user_id=token["user_id"], **payload.model_dump()
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/conflicts/workspace/review")
async def calendar_workspace_conflict_review(
    payload: CalendarWorkspaceConflictReview,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
):
    """Prepare exact Calendar and organizer Mail terms for direct workspace review."""
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        from hushh_mcp.services.calendar_conflict_service import CalendarConflictService

        response.headers["Cache-Control"] = "private, no-store"
        return await CalendarConflictService().review(user_id=firebase_uid, **payload.model_dump())
    except (GmailDeliveryError, GmailApiError) as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "reason_code": exc.code, "message": str(exc)},
        ) from exc
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/conflicts/workspace/confirm")
async def calendar_workspace_conflict_confirm(
    payload: CalendarWorkspaceConflictConfirm,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
):
    try:
        from hushh_mcp.services.calendar_conflict_service import CalendarConflictService

        response.headers["Cache-Control"] = "private, no-store"
        return await CalendarConflictService().confirm(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/schedule/today")
async def schedule_today(
    payload: CalendarDay,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _schedule().today(user_id=firebase_uid, **payload.model_dump())
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/schedule/availability")
async def schedule_availability(
    payload: CalendarAvailabilityWindow,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _schedule().free_windows(
            user_id=firebase_uid, **payload.model_dump(exclude_none=True)
        )
    except Exception as exc:
        # Correlate classified failures without account IDs or provider payloads.
        logging.getLogger(__name__).warning(
            "calendar.availability.failed request_id=%s reason_code=%s status=%s",
            get_request_id(),
            exc.reason_code if isinstance(exc, GoogleConnectionError) else "backend_failure",
            exc.status_code if isinstance(exc, GoogleConnectionError) else 503,
        )
        error = _http(exc)
        error.headers = {**(error.headers or {}), "Cache-Control": "private, no-store"}
        options = getattr(exc, "calendar_options", None)
        if (
            isinstance(exc, GoogleConnectionError)
            and options is not None
            and isinstance(error.detail, dict)
        ):
            error.detail = {**error.detail, "calendar_options": options}
        raise error from exc


@router.post("/invitations")
async def invitations(
    payload: CalendarInvitationsWindow,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await invitation_response_with_portraits(
            firebase_uid, _selected_schedule(payload.account_id), payload
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/review")
async def attendance_review(
    payload: CalendarAttendanceReview,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        return await _selected_schedule(payload.account_id).review(
            user_id=token["user_id"], **payload.model_dump(exclude={"account_id"})
        )
    except (GmailDeliveryError, GmailApiError) as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "reason_code": exc.code, "message": str(exc)},
        ) from exc
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/rsvp/review")
async def attendance_rsvp_review(
    payload: CalendarRsvpReview,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
):
    """Review only the signed-in owner's Calendar RSVP under its Google grant."""
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _selected_schedule(payload.account_id).review(
            user_id=firebase_uid,
            **payload.model_dump(exclude={"account_id"}, exclude_none=True),
            review_kind="rsvp",
            offer_times=False,
            send_message=False,
            mail_only_retry=False,
            exact_time=False,
            message="",
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/confirm")
async def attendance_confirm(
    payload: CalendarAttendanceConfirm,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    try:
        return await _selected_schedule(payload.account_id).confirm(
            user_id=token["user_id"], **payload.model_dump(exclude={"account_id"})
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/rsvp/confirm")
async def attendance_rsvp_confirm(
    payload: CalendarRsvpConfirm,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
):
    """Confirm only a sealed, mail-free RSVP; never consume a Mail review here."""
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _selected_schedule(payload.account_id).confirm_rsvp(
            user_id=firebase_uid,
            **payload.model_dump(exclude={"account_id"}),
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/workspace/review")
async def attendance_workspace_review(
    payload: CalendarWorkspaceAttendanceReview,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
):
    """Prepare a first-party Calendar action with exact owner-reviewed terms."""
    from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _selected_schedule(payload.account_id).review(
            user_id=firebase_uid,
            **payload.model_dump(exclude={"account_id"}),
            review_kind="workspace",
        )
    except (GmailDeliveryError, GmailApiError) as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "reason_code": exc.code, "message": str(exc)},
        ) from exc
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/attendance/workspace/confirm")
async def attendance_workspace_confirm(
    payload: CalendarWorkspaceAttendanceConfirm,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
):
    try:
        response.headers["Cache-Control"] = "private, no-store"
        return await _selected_schedule(payload.account_id).confirm(
            user_id=firebase_uid,
            **payload.model_dump(exclude={"account_id"}),
            review_kind="workspace",
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/rescheduling/options")
@limiter.limit("10/minute")
async def public_rescheduling_options(request: Request, payload: CalendarPublicOptions):
    # The encrypted, expiring capability grants only the reviewed free slots.
    # No owner token, event reads or booking/mutation authority is exposed.
    from fastapi.responses import JSONResponse

    from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService

    try:
        plan = CalendarScheduleService._open(payload.token, "calendar-public-v1")
        return JSONResponse(
            await _selected_schedule(plan.get("account_id", "default")).public_options(
                token=payload.token
            ),
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
        )
    except Exception as exc:
        raise _http(exc) from exc


def _insights(account_id="default"):
    from hushh_mcp.services.calendar_insights_service import CalendarInsightsService

    return CalendarInsightsService(schedule=_selected_schedule(account_id), account_id=account_id)


def _artifacts(account_id="default"):
    from hushh_mcp.services.calendar_meeting_artifacts import CalendarMeetingArtifacts

    return CalendarMeetingArtifacts(insights=_insights(account_id))


@router.post("/insights")
async def insights(
    payload: CalendarInsightsDay,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return await _insights(payload.account_id).overview(
            user_id=firebase_uid, **payload.model_dump(exclude={"account_id"})
        )
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/meetings")
async def meeting_library(
    payload: CalendarMeetingPage,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        result = await _insights(payload.account_id).library(
            user_id=firebase_uid, **payload.model_dump(exclude={"account_id"})
        )
        await admit_hub_content(firebase_uid, "one_calendar_meeting_library")
        return result
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/meetings/detail")
async def meeting_detail(
    payload: CalendarMeetingSelection,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    from api.routes.one.calendar_meeting_actions import meeting_detail as action

    result = await action(payload, response, firebase_uid, artifacts=_artifacts, http_error=_http)
    await admit_hub_content(firebase_uid, "one_calendar_meeting_detail")
    return result


@router.post("/meetings/requests", status_code=202)
async def request_meeting_files(
    payload: CalendarMeetingFileRequest,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    from api.routes.one.calendar_meeting_request_actions import create_request

    verify_user_id_match(firebase_uid, token["user_id"])
    return await create_request(payload, response, token, http_error=_http)


@router.post("/meetings/request-readiness")
async def meeting_request_readiness(
    payload: CalendarMeetingRequiredSelection,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    from api.routes.one.calendar_meeting_request_actions import request_readiness

    verify_user_id_match(firebase_uid, token["user_id"])
    return await request_readiness(payload, response, token, http_error=_http)


@router.post("/meetings/request-statuses")
async def meeting_request_statuses(
    payload: CalendarMeetingStatusBatch,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    response.headers["Cache-Control"] = "private, no-store"
    from api.routes.drive_sharing_owner import ContentOwner

    owner = ContentOwner(token["user_id"], token["token"])
    await owner.require_current()
    semaphore = asyncio.Semaphore(3)

    async def one(selection):
        async with semaphore:
            await owner.require_current()
            try:
                result = await _artifacts(selection.account_id).approved_status(
                    user_id=owner.user_id, **selection.model_dump(exclude={"account_id"})
                )
            except Exception:
                return {"occurrence_id": selection.occurrence_id, "status": "unverified"}
            await owner.require_current()
            return result

    meetings = await asyncio.gather(*(one(item) for item in payload.meetings))
    await owner.require_current()
    return {"meetings": meetings}


@router.post("/meetings/approved-detail")
async def approved_meeting_detail(
    payload: CalendarMeetingRequiredSelection,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    from api.routes.drive_sharing_owner import ContentOwner
    from api.routes.one.calendar_meeting_actions import meeting_detail as action

    verify_user_id_match(firebase_uid, token["user_id"])
    owner = ContentOwner(token["user_id"], token["token"])
    await owner.require_current()
    result = await action(
        payload,
        response,
        owner.user_id,
        artifacts=_artifacts,
        http_error=_http,
        include_approved=True,
    )
    await owner.require_current()
    return result


@router.post("/meetings/download")
async def meeting_download(
    payload: CalendarMeetingDownload,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    """Recheck the exact occurrence and file, then hand off to Google download."""
    return await _meeting_file_action(payload, response, firebase_uid, download=True)


@router.post("/meetings/open")
async def meeting_open(
    payload: CalendarMeetingDownload,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase_read_only),
):
    """Recheck the exact occurrence and file before opening it in Google."""
    return await _meeting_file_action(payload, response, firebase_uid, download=False)


@router.post("/meetings/approved-open")
async def approved_meeting_open(
    payload: CalendarMeetingDownload,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    return await _approved_meeting_file_action(
        payload, response, token, firebase_uid, download=False
    )


@router.post("/meetings/approved-download")
async def approved_meeting_download(
    payload: CalendarMeetingDownload,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    return await _approved_meeting_file_action(
        payload, response, token, firebase_uid, download=True
    )


async def _approved_meeting_file_action(payload, response, token, firebase_uid, *, download):
    from api.routes.drive_sharing_owner import ContentOwner
    from api.routes.one.calendar_meeting_actions import meeting_file_action

    verify_user_id_match(firebase_uid, token["user_id"])
    owner = ContentOwner(token["user_id"], token["token"])
    await owner.require_current()
    result = await meeting_file_action(
        payload,
        response,
        owner.user_id,
        download=download,
        artifacts=_artifacts,
        http_error=_http,
        include_approved=True,
    )
    await owner.require_current()
    return result


async def _meeting_file_action(payload, response, firebase_uid, *, download):
    from api.routes.one.calendar_meeting_actions import meeting_file_action

    result = await meeting_file_action(
        payload,
        response,
        firebase_uid,
        download=download,
        artifacts=_artifacts,
        http_error=_http,
    )
    await admit_hub_content(firebase_uid, "one_calendar_meeting_file_action")
    return result


@router.post("/meetings/context")
async def meeting_context(
    payload: CalendarMeetingSelection,
    response: Response,
    token: dict = Depends(hub_content_owner),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, token["user_id"])
    if payload.account_id != "default":
        raise HTTPException(
            status_code=403,
            detail={"message": "Meeting chat uses the original Calendar connection."},
        )
    from api.routes.one.calendar_meeting_actions import meeting_chat_context

    return await meeting_chat_context(
        payload,
        response,
        firebase_uid,
        artifacts=_artifacts,
        http_error=_http,
    )
