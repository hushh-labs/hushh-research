"""Reviewed Location decision wire contracts."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ReviewedLocationExtension(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    grant_id: UUID = Field(alias="grantId")
    expires_at: datetime | None = Field(default=None, alias="expiresAt")

    @field_validator("expires_at")
    @classmethod
    def aware_expiry(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Reviewed expiry needs a timezone")
        return value


class DeclineAccessRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    expected_request_revision: int | None = Field(
        default=None, alias="expectedRequestRevision", ge=1
    )


class ResolveAccessRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    # Required so a cached pre-standing-rule browser cannot make an automatic
    # call look like an explicit manual tap merely by omitting the new context.
    approval_mode: Literal["manual", "automatic"] = Field(alias="approvalMode")

    # Both default to None so an approval with no duration means "grant what
    # they asked for". Sending one still wins -- the owner can always give less
    # (or more) than was asked.
    duration_hours: float | None = Field(default=None, alias="durationHours", gt=0, le=24)
    duration_mode: str | None = Field(
        default=None,
        alias="durationMode",
        pattern="^(timed|until_stopped)$",
    )
    # Present only when the first-party client is applying the current
    # server-owned standing rule. The service locks and revalidates this exact
    # version before it writes a grant.
    auto_approve_rule_version: int | None = Field(
        default=None,
        alias="autoApproveRuleVersion",
        ge=1,
    )
    expected_request_revision: int | None = Field(
        default=None, alias="expectedRequestRevision", ge=1
    )

    reviewed_extension: ReviewedLocationExtension | None = Field(
        default=None, alias="reviewedExtension"
    )

    @model_validator(mode="after")
    def validate_approval_intent(self) -> "ResolveAccessRequest":
        automatic = self.approval_mode == "automatic"
        if not automatic and self.expected_request_revision is None:
            raise ValueError("Review the current request before approving")
        if self.reviewed_extension is not None and (
            automatic or self.expected_request_revision is None
        ):
            raise ValueError("Extension requires an explicit reviewed request")
        if automatic and self.auto_approve_rule_version is None:
            raise ValueError("automatic approval requires a current rule version")
        if automatic and (self.duration_hours is not None or self.duration_mode is not None):
            raise ValueError("automatic approval must use the requested duration")
        if not automatic and self.auto_approve_rule_version is not None:
            raise ValueError("manual approval cannot cite an automatic rule")
        return self
