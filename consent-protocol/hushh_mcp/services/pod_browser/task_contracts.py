"""Owner task contracts. Authority and execution facts are never request fields."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol

from pydantic import Field, model_validator

from .consent import BrowserConsentPort, Purpose
from .contracts import (
    BrowserAuthorityPort,
    BrowserBinding,
    BrowserExecutionPort,
    BrowserReadiness,
    StrictContract,
)
from .control import BrowserControl
from .information import BrowserModelProcessing, InformationField
from .origin import public_origin

Phase = Literal[
    "running", "needs_owner", "completed", "unavailable", "outcome_uncertain", "cancelled"
]


class BrowserTaskRequest(StrictContract):
    request_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{8,128}$")
    goal: str = Field(min_length=1, max_length=4096, repr=False)
    allowed_origins: tuple[str, ...] = Field(min_length=1, max_length=20, repr=False)
    fields: tuple[InformationField, ...] = Field(default=(), max_length=16)

    @model_validator(mode="after")
    def exact_selection(self):
        if len(set(self.allowed_origins)) != len(self.allowed_origins) or any(
            public_origin(origin) != origin for origin in self.allowed_origins
        ):
            raise ValueError("explicit public origins required")
        if len(set(self.fields)) != len(self.fields):
            raise ValueError("duplicate selected fields")
        return self


class BrowserCapability(StrictContract):
    available: bool
    code: str = Field(max_length=128)
    remembered_sessions_available: bool = False
    owner_id: str | None = Field(default=None, max_length=256)
    pod_id: str | None = Field(default=None, max_length=256)
    incarnation: str | None = Field(default=None, max_length=256)
    environment: Literal["development"] | None = None


class BrowserReviewOffer(StrictContract):
    review_id: str = Field(min_length=1, max_length=128)
    purpose: Purpose
    # Private terms are available only to the authenticated owner's review UI.
    # This object, like a screenshot, is never persisted in a task checkpoint.
    terms: dict = Field(repr=False)


class BrowserTaskSnapshot(StrictContract):
    binding: BrowserBinding
    phase: Phase
    control_owner: Literal["agent", "owner", "stopped", "uncertain"]
    control_epoch: int = Field(ge=1)
    next_sequence: int = Field(ge=1)
    revision: int = Field(ge=1)
    capability: BrowserCapability
    code: str | None = Field(default=None, max_length=128)
    summary: str | None = Field(default=None, max_length=2000, repr=False)
    review: BrowserReviewOffer | None = Field(default=None, repr=False)
    approved_origins: tuple[str, ...] = Field(default=(), max_length=20, repr=False)


class BrowserTaskReceipt(StrictContract):
    """Invocation metadata safe for One; private task output needs its own export."""

    binding: BrowserBinding
    phase: Phase
    revision: int = Field(ge=1)
    code: str | None = Field(default=None, max_length=128)
    review_id: str | None = Field(default=None, max_length=128)
    review_purpose: Purpose | None = None


@dataclass(frozen=True)
class BrowserOwnerAccess:
    owner_id: str
    pod_id: str
    incarnation: str
    expires_at: int
    # Rechecks the exact session/subject, incarnation lease, and update fence.
    check: Callable[[], Awaitable[None]] = field(repr=False)


class BrowserReviewAuthorityPort(BrowserConsentPort, Protocol):
    """Narrow existing action-ledger coordination. No pod SQL credentials.

    ``offer`` forwards an opaque private commitment and bound metadata to the
    existing authority; ``confirm`` is reachable only from authenticated owner
    control. Neither method accepts a caller assertion of approval/readiness.
    """

    async def offer_review(
        self, binding: BrowserBinding, purpose: Purpose, private_terms: dict
    ) -> BrowserReviewOffer: ...

    async def confirm_review(self, binding: BrowserBinding, review_id: str) -> None: ...


class BrowserLauncherPort(Protocol):
    """Trusted qualified native launcher and bridge, not a request-side adapter."""

    readiness: BrowserReadiness

    async def launch(
        self,
        binding: BrowserBinding,
        *,
        allowed_origins: tuple[str, ...],
        consent: BrowserConsentPort,
        authority: BrowserAuthorityPort,
    ) -> BrowserExecutionPort: ...


class BrowserModelPort(Protocol):
    model_name: str
    transport: str

    async def run(
        self, *, control: BrowserControl, processing: BrowserModelProcessing, goal: str
    ) -> object:
        """Returns BrowserTaskResultV1 after ephemeral model/session teardown.

        Cancellation must acknowledge that teardown before raising. Unconfirmed
        cleanup raises BROWSER_MODEL_STOP_UNCONFIRMED; the update permit stays held.
        """
        ...


class BrowserTaskLogPort(Protocol):
    """The existing sealed PodCommitLog; never a parallel state store."""

    async def require_open(self) -> None: ...
    async def append(self, kind: str, payload: dict) -> object: ...
    async def replay(self) -> list[dict]: ...
