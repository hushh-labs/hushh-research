"""Owner-authenticated hosted payout setup; no account or mode overrides."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class OnboardBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    purpose: Literal["verify"] | None = None
    attempt_id: UUID | None = None
