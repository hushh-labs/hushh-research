"""Bounded browser wire contracts, independent of ADK and cloud SDKs.

Bindings and readiness receipts are supplied by verified pod ingress, never by
model arguments. Private payloads must not enter hub task metadata or logs.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator

if TYPE_CHECKING:
    from .session_state import RememberedState


class BrowserRefused(RuntimeError):
    def __init__(self, code: str) -> None:
        # Stable codes only: ADK logs exceptions and URLs may contain credentials.
        self.code = code
        super().__init__(code)


class StrictContract(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        frozen=True,
        hide_input_in_errors=True,
        ser_json_bytes="base64",
        val_json_bytes="base64",
    )


class BrowserBinding(StrictContract):
    owner_id: str = Field(min_length=1, max_length=256)
    pod_id: str = Field(min_length=1, max_length=256)
    incarnation: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=128)
    environment: Literal["development"]
    expires_at: int = Field(gt=0)


class BrowserExecutionScope(StrictContract):
    """Host-created input identity; never part of a model/owner action payload."""

    sequence: int = Field(ge=1)
    control_epoch: int = Field(ge=1)
    actor: Literal["agent", "owner"]
    deadline_at: float = Field(gt=0, allow_inf_nan=False)

    def remaining(self, clock: Callable[[], float] = time.time) -> float:
        remaining = self.deadline_at - clock()
        if remaining <= 0:
            raise BrowserRefused("BROWSER_ACTION_DEADLINE_EXPIRED")
        return min(330.0, remaining)

    def require_action(self, action: BrowserAction, binding: BrowserBinding) -> None:
        if (
            self.sequence != action.sequence
            or self.control_epoch != action.control_epoch
            or self.deadline_at > binding.expires_at
        ):
            raise BrowserRefused("BROWSER_ACTION_SCOPE_REFUSED")


class BrowserReadiness(StrictContract):
    version: Literal[1, 2] = 1
    cloud: Literal["gcp", "azure"]
    component_digest: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    boundary: Literal["isolated_browser", "shared_owner_container"] = "isolated_browser"
    chromium_sandbox: bool = True
    browser_start_verified: bool = False
    runtime_uid_verified: bool = False
    lifecycle_verified: bool = False
    isolated: bool = False
    direct_egress_denied: bool = False
    broker_bridge_verified: bool = False
    ephemeral_bridge_verified: bool = False
    private_access_denied: bool = False
    model_transport_verified: bool = False
    model_name: str = Field(default="", max_length=128)
    model_transport: str = Field(default="", max_length=256)

    def require_ready(self) -> None:
        if self.version == 2:
            if (
                self.boundary != "shared_owner_container"
                or self.chromium_sandbox != (self.cloud == "gcp")
                or self.isolated
                or self.direct_egress_denied
                or self.private_access_denied
                or not all(
                    (
                        self.browser_start_verified,
                        self.runtime_uid_verified,
                        self.lifecycle_verified,
                        self.broker_bridge_verified,
                        self.ephemeral_bridge_verified,
                        self.model_transport_verified,
                        bool(self.model_name),
                        bool(self.model_transport),
                    )
                )
            ):
                raise BrowserRefused("BROWSER_EXECUTION_NOT_READY")
            return
        if not all(
            (
                self.isolated,
                self.direct_egress_denied,
                self.broker_bridge_verified,
                self.ephemeral_bridge_verified,
                self.private_access_denied,
                self.model_transport_verified,
                bool(self.model_name),
                bool(self.model_transport),
            )
        ):
            raise BrowserRefused("BROWSER_ISOLATION_NOT_READY")


Operation = Literal[
    "observe",
    "navigate",
    "click",
    "hover",
    "type",
    "scroll",
    "back",
    "forward",
    "keys",
    "drag",
    "resize",
]


class BrowserViewport(StrictContract):
    width: int = Field(default=1280, ge=320, le=1920)
    height: int = Field(default=720, ge=240, le=1080)


class BrowserAction(StrictContract):
    operation: Operation
    sequence: int = Field(ge=1)
    control_epoch: int = Field(ge=1)
    url: str | None = Field(default=None, max_length=4096, repr=False)
    x: int | None = Field(default=None, ge=0, le=1919)
    y: int | None = Field(default=None, ge=0, le=1079)
    destination_x: int | None = Field(default=None, ge=0, le=1919)
    destination_y: int | None = Field(default=None, ge=0, le=1079)
    text: str | None = Field(default=None, max_length=4096, repr=False)
    press_enter: bool = False
    clear_before_typing: bool = True
    focus_existing: bool = False
    direction: Literal["up", "down", "left", "right"] | None = None
    magnitude: int | None = Field(default=None, ge=1, le=2000)
    keys: tuple[str, ...] = ()
    width: int | None = Field(default=None, ge=320, le=1920)
    height: int | None = Field(default=None, ge=240, le=1080)

    @model_validator(mode="after")
    def validate_arguments(self) -> BrowserAction:
        required = {
            "navigate": {"url"},
            "click": {"x", "y"},
            "hover": {"x", "y"},
            "type": {"x", "y", "text"},
            "scroll": {"direction", "magnitude"},
            "keys": {"keys"},
            "drag": {"x", "y", "destination_x", "destination_y"},
            "resize": {"width", "height"},
        }.get(self.operation, set())
        optional = (
            {"press_enter", "clear_before_typing", "focus_existing"}
            if self.operation == "type"
            else set()
        )
        if self.operation == "scroll":
            optional = {"x", "y"}
            if (self.x is None) != (self.y is None):
                raise ValueError("Both scroll coordinates are required")
        if self.operation == "type" and self.focus_existing:
            required = {"text"}
            optional |= {"x", "y"}
            if (self.x is None) != (self.y is None):
                raise ValueError("Both typing coordinates are required when supplied")
        supplied = self.model_fields_set - {"operation", "sequence", "control_epoch"}
        if not required <= supplied or supplied - required - optional:
            raise ValueError("Invalid browser action arguments")
        if any(getattr(self, name) is None for name in required):
            raise ValueError("Missing browser action argument")
        if self.operation == "keys" and (
            not self.keys
            or len(self.keys) > 4
            or any(not key or len(key) > 32 for key in self.keys)
        ):
            raise ValueError("Invalid browser keys")
        return self


class BrowserFrame(StrictContract):
    sequence: int = Field(ge=0)
    width: int = Field(ge=320, le=1920)
    height: int = Field(ge=240, le=1080)
    png: bytes = Field(min_length=8, max_length=4 * 1024 * 1024, repr=False)
    url: str = Field(max_length=4096, repr=False)

    @model_validator(mode="after")
    def require_png(self) -> BrowserFrame:
        if not self.png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Invalid browser frame")
        return self


class BrowserExecutionPort(Protocol):
    async def initialize(self) -> None: ...

    async def execute(
        self, action: BrowserAction, *, scope: BrowserExecutionScope | None = None
    ) -> BrowserFrame: ...

    async def close(self) -> None: ...


class BrowserSessionExecutionPort(BrowserExecutionPort, Protocol):
    async def export_session(self, approved_origins: frozenset[str]) -> RememberedState: ...

    async def import_session(
        self, state: RememberedState, approved_origins: frozenset[str]
    ) -> None: ...


class BrowserRequest(StrictContract):
    scope: BrowserExecutionScope | None = Field(default=None, repr=False)
    url: str = Field(max_length=4096, repr=False)
    method: str = Field(max_length=16)
    headers: tuple[tuple[str, str], ...] = Field(default=(), repr=False)
    body: bytes = Field(default=b"", max_length=65536, repr=False)

    def commitment(self) -> str:
        terms = json.dumps(
            [self.method, self.url, sorted(self.headers), hashlib.sha256(self.body).hexdigest()],
            separators=(",", ":"),
            ensure_ascii=True,
        )
        if self.scope is not None:
            terms += self.scope.model_dump_json()
        return hashlib.sha256(terms.encode()).hexdigest()


class BrowserResponse(StrictContract):
    status: int = Field(ge=100, le=599)
    headers: tuple[tuple[str, str], ...] = Field(repr=False)
    body: bytes = Field(max_length=4 * 1024 * 1024, repr=False)
    download_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


class BrowserNetworkPermit(StrictContract):
    # Classified by the owning, approved action contract, not website text or
    # a model-provided "safe" flag. Missing policy is refused, never read-only.
    effect_receipt_required: bool


class BrowserAuthorityPort(Protocol):
    """Adapter to existing admission, approval and dispatch receipt owners.

    authorize_action verifies exact reviewed terms; journal_dispatch persists
    before an effect. An uncertain receipt must never be automatically replayed.
    None of these calls accepts confirmation assertions supplied by a model.
    """

    async def check_binding(self, binding: BrowserBinding) -> None: ...

    async def authorize_action(
        self,
        binding: BrowserBinding,
        action: BrowserAction,
        *,
        scope: BrowserExecutionScope | None = None,
    ) -> None: ...

    async def journal_dispatch(self, binding: BrowserBinding, action: BrowserAction) -> None: ...

    async def settle_dispatch(
        self, binding: BrowserBinding, action: BrowserAction, *, uncertain: bool
    ) -> None: ...
