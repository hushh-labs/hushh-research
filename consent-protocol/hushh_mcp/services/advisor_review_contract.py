"""Explicit, recipient-sealed Finance introductions; never trading authority."""

from datetime import datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, StrictBool, StrictInt, field_validator, model_validator

from hushh_mcp.services.finance_sharing_contract import RecipientEnvelope, StrictObject


class CreateAdvisorReview(StrictObject):
    requestId: UUID
    advisorPersonRef: UUID
    envelope: RecipientEnvelope
    ownerEnvelope: RecipientEnvelope
    contentHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    introduction: str = Field(default="", max_length=600)
    approval: Literal["connect_and_share_finance_snapshot_v1"]
    durationSeconds: Literal[604800]


class ReviewDecision(StrictObject):
    action: Literal["accept", "decline", "withdraw", "stop"]


class MeetingTime(StrictObject):
    startAt: datetime
    endAt: datetime
    timeZone: str = Field(max_length=80)

    @model_validator(mode="after")
    def valid_time(self):
        from datetime import timedelta

        if self.startAt.tzinfo is None or self.endAt.tzinfo is None:
            raise ValueError("Meeting times need a time zone")
        if self.endAt - self.startAt not in {timedelta(minutes=n) for n in (15, 30, 60)}:
            raise ValueError("Choose a 15, 30 or 60 minute meeting")
        try:
            ZoneInfo(self.timeZone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Choose a valid time zone") from exc
        return self


class AdvisorPlan(StrictObject):
    amountCents: StrictInt = Field(ge=100, le=100000)
    currency: Literal["usd"] = "usd"
    services: str = Field(min_length=20, max_length=1500)
    cancellationTerms: str = Field(min_length=20, max_length=1500)
    interval: Literal["month"] = "month"

    @field_validator("services", "cancellationTerms", mode="before")
    @classmethod
    def meaningful_terms(cls, value):
        return value.strip() if isinstance(value, str) else value


class PlanCheckout(StrictObject):
    planRevision: StrictInt = Field(ge=1)
    acceptRecurringPayment: StrictBool

    @model_validator(mode="after")
    def confirmed(self):
        if not self.acceptRecurringPayment:
            raise ValueError("Recurring payment approval is required")
        return self


class MeetingAction(StrictObject):
    action: Literal["agree", "prepare", "confirm", "cancel", "complete", "check"]
    proposalId: str | None = Field(default=None, max_length=200)
