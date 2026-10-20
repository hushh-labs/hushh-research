"""Opaque coordination metadata; private terms stay in the owner pod/browser."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from hushh_mcp.services.action_directive_ledger import BoundActionTerms

from .consent import ACTION_PREFIX, Purpose
from .contracts import BrowserBinding, StrictContract


class BrowserHubReview(StrictContract):
    binding: BrowserBinding
    purpose: Purpose
    commitment: str = Field(pattern=r"^[a-f0-9]{64}$")
    pod_key_id: str = Field(min_length=1, max_length=128)
    environment: Literal["dev", "development"]
    epoch: int = Field(ge=1)
    service_uid: str | None = Field(default=None, min_length=1, max_length=256)

    @property
    def identity(self) -> dict:
        return {
            "user_id": self.binding.owner_id,
            "session_id": self.binding.task_id,
            "action_id": ACTION_PREFIX + self.purpose,
            "context_revision": self.commitment,
        }

    @property
    def terms(self) -> BoundActionTerms:
        return BoundActionTerms(
            action_contract={"action_id": ACTION_PREFIX + self.purpose, "version": 1},
            slots={"commitment": self.commitment},
            resource_binding={
                "kind": "pod_browser_review_v1",
                **self.model_dump(exclude={"commitment", "purpose"}),
            },
        )


class BrowserHubMutation(StrictContract):
    review: BrowserHubReview
    directive_id: str | None = Field(default=None, pattern=r"^dir_[a-f0-9]{32}$")
    receipt: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{32,128}$", repr=False)
