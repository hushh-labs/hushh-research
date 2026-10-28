"""Typed requests for the connected Calendar workspace."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool


class CalendarDay(BaseModel):
    date: str = Field(min_length=10, max_length=10)
    time_zone: str = Field(min_length=1, max_length=128)


class CalendarInsightsDay(CalendarDay):
    account_id: str = Field(default="default", min_length=1, max_length=128)


class CalendarMeetingPage(CalendarInsightsDay):
    cursor: str | None = Field(default=None, min_length=40, max_length=40000)
    query: str = Field(default="", max_length=120)
    kind: str = Field(default="all", pattern="^(all|recording|notes)$")


class CalendarMeetingSelection(BaseModel):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    expected_account_email: str | None = Field(default=None, min_length=1, max_length=512)
    expected_grant: str | None = Field(default=None, min_length=64, max_length=64)
    occurrence_id: str | None = Field(default=None, min_length=64, max_length=64)
    calendar_id: str = Field(min_length=1, max_length=1024)
    event_id: str = Field(min_length=1, max_length=2048)
    date: str | None = Field(default=None, min_length=10, max_length=10)
    time_zone: str | None = Field(default=None, min_length=1, max_length=128)


class CalendarMeetingDownload(CalendarMeetingSelection):
    file_id: str = Field(min_length=10, max_length=255)


class CalendarOpeningWindow(CalendarDay):
    start_time: str = Field(default="09:00", max_length=5)
    end_time: str = Field(default="17:00", max_length=5)
    duration_minutes: Literal[15, 30, 60] = 30


class CalendarAvailabilityWindow(CalendarDay):
    start_time: Literal["00:00"] = "00:00"
    end_time: Literal["24:00"] = "24:00"
    duration_minutes: Literal[15, 30, 60] = 30
    calendar_overrides: dict[str, StrictBool] | None = Field(default=None, max_length=100)


class CalendarAttendanceReview(CalendarDay):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    start_time: str = Field(default="09:00", max_length=5)
    end_time: str = Field(default="17:00", max_length=5)
    duration_minutes: int = Field(default=30, ge=1, le=1440)
    event_id: str = Field(min_length=1, max_length=2048)
    calendar_id: str = Field(default="primary", min_length=1, max_length=1024)
    response_status: Literal["accepted", "declined", "tentative"] = "declined"
    expected_account_email: str | None = Field(default=None, max_length=512)
    offer_times: bool = False
    send_message: StrictBool = False
    mail_only_retry: StrictBool = False
    exact_time: StrictBool = False
    message: str = Field(default="", max_length=8000)


class CalendarInvitationsWindow(BaseModel):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    selected_calendar_id: str | None = Field(default=None, max_length=1024)
    selected_event_id: str | None = Field(default=None, max_length=2048)
    start_at: str | None = Field(default=None, max_length=64)
    end_at: str | None = Field(default=None, max_length=64)
    time_zone: str = Field(default="UTC", min_length=1, max_length=128)


class CalendarAttendanceConfirm(BaseModel):
    account_id: str = Field(default="default", min_length=1, max_length=128)
    review_id: str = Field(min_length=16, max_length=128)
    review_token: str = Field(min_length=40, max_length=40000)


class CalendarRsvpReview(BaseModel):
    """A calendar-only response; Mail and proposed-time fields are forbidden."""

    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(default="default", min_length=1, max_length=128)
    event_id: str = Field(min_length=1, max_length=2048)
    calendar_id: str = Field(default="primary", min_length=1, max_length=1024)
    response_status: Literal["accepted", "declined"]
    time_zone: str = Field(default="UTC", min_length=1, max_length=128)
    expected_account_email: str | None = Field(default=None, max_length=512)


class CalendarRsvpConfirm(CalendarAttendanceConfirm):
    model_config = ConfigDict(extra="forbid")


class CalendarWorkspaceAttendanceReview(CalendarAttendanceReview):
    """Explicit first-party Calendar action, including reviewed organizer Mail."""

    model_config = ConfigDict(extra="forbid")
    response_status: Literal["accepted", "declined"] = "declined"


class CalendarWorkspaceAttendanceConfirm(CalendarAttendanceConfirm):
    model_config = ConfigDict(extra="forbid")


class CalendarPublicOptions(BaseModel):
    token: str = Field(min_length=40, max_length=40000)


class CalendarBoardDay(CalendarDay):
    duration_minutes: Literal[15, 30, 60] = 30
    calendar_overrides_by_account: dict[str, dict[str, StrictBool]] | None = Field(
        default=None, max_length=3
    )


class CalendarEventRef(BaseModel):
    account_id: str = Field(min_length=1, max_length=128)
    calendar_id: str = Field(min_length=1, max_length=1024)
    event_id: str = Field(min_length=1, max_length=2048)


class CalendarDeclineChoice(CalendarEventRef):
    message: str = Field(min_length=1, max_length=8000)


class CalendarConflictReviewRequest(CalendarDay):
    keep: CalendarEventRef
    decline: list[CalendarDeclineChoice] = Field(min_length=1, max_length=2)


class CalendarConflictConfirmRequest(BaseModel):
    review_id: str = Field(min_length=16, max_length=128)
    review_token: str = Field(min_length=40, max_length=200000)


class CalendarWorkspaceConflictReview(CalendarConflictReviewRequest):
    model_config = ConfigDict(extra="forbid")


class CalendarWorkspaceConflictConfirm(CalendarConflictConfirmRequest):
    model_config = ConfigDict(extra="forbid")
