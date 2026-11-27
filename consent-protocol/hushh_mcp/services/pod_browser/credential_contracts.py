"""Private credential-use ports. Model calls carry handles and explicit targets only."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import Field, model_validator

from .contracts import BrowserBinding, BrowserRefused, StrictContract
from .origin import public_origin


class CredentialDescriptor(StrictContract):
    handle: str = Field(pattern=r"^(?:sec_[a-f0-9]{16}|owner_selection)$")
    origin: str = Field(min_length=1, max_length=4096)
    record_revision: int = Field(ge=1)

    @model_validator(mode="after")
    def exact_origin(self):
        if public_origin(self.origin) != self.origin:
            raise ValueError("Exact credential origin required")
        return self


@dataclass(repr=False)
class CredentialLease:
    username: bytearray
    password: bytearray
    recheck: Callable[[], Awaitable[None]] = field(repr=False)
    totp_secret: bytearray | None = field(default=None, repr=False)
    submission: object | None = field(default=None, repr=False)
    expected_target: dict | None = field(default=None, repr=False)
    envelope: dict | None = field(default=None, repr=False)

    def clear(self) -> None:
        # This erases owned mutable broker buffers, not Python/driver/Chromium
        # copies. Qualification must measure those separate lifetimes.
        for value in (self.username, self.password, self.totp_secret):
            if isinstance(value, bytearray):
                value[:] = b"\0" * len(value)
        self.submission = self.expected_target = self.envelope = None


class BrowserCredentialSource(Protocol):
    async def catalog(
        self, binding: BrowserBinding, origin: str
    ) -> tuple[CredentialDescriptor, ...]: ...

    def open(
        self, binding: BrowserBinding, descriptor: CredentialDescriptor
    ) -> AbstractAsyncContextManager[CredentialLease]: ...

    async def validate_transient(
        self, binding: BrowserBinding, aad: dict, selection: dict
    ) -> None: ...

    def open_transient(
        self,
        binding: BrowserBinding,
        request: CredentialUseRequest,
        envelope: dict,
        selection: dict,
        *,
        claim: Callable[[], Awaitable[None]],
    ) -> AbstractAsyncContextManager[CredentialLease]: ...


class CredentialTarget(StrictContract):
    x: int = Field(ge=0, le=1919)
    y: int = Field(ge=0, le=1079)


class CredentialTargets(StrictContract):
    username: CredentialTarget
    password: CredentialTarget
    submit: CredentialTarget
    otp: CredentialTarget | None = None


class CredentialUseRequest(StrictContract):
    operation_id: str = Field(pattern=r"^[A-Za-z0-9_-]{8,128}$")
    handle: str = Field(pattern=r"^(?:sec_[a-f0-9]{16}|owner_selection)$")
    origin: str = Field(min_length=1, max_length=4096)
    control_epoch: int = Field(ge=1)
    targets: CredentialTargets

    @model_validator(mode="after")
    def exact_origin(self):
        if public_origin(self.origin) != self.origin:
            raise ValueError("Exact credential origin required")
        points = [self.targets.username, self.targets.password, self.targets.submit]
        if self.targets.otp:
            points.append(self.targets.otp)
        if len({(point.x, point.y) for point in points}) != len(points):
            raise ValueError("Distinct credential targets required")
        return self


def require_credential_execution(readiness) -> None:
    readiness.require_ready()
    if not (
        readiness.credential_entry_verified
        and readiness.credential_cleanup_verified
        and readiness.credential_isolation_verified
        and readiness.chromium_sandbox
    ):
        raise BrowserRefused("BROWSER_CREDENTIAL_EXECUTION_UNQUALIFIED")
