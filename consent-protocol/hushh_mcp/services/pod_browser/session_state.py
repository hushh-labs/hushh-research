"""Strict, approved-origin Playwright state; no browser profile or passkeys."""

from __future__ import annotations

import json
import time
from urllib.parse import urlsplit

from pydantic import Field, model_validator

from .contracts import BrowserRefused, StrictContract
from .origin import public_origin

MAX_SESSION_BYTES = 1024 * 1024


class PersistentCookie(StrictContract):
    name: str = Field(min_length=1, max_length=4096)
    value: str = Field(max_length=65536, repr=False)
    domain: str = Field(min_length=1, max_length=253)
    path: str = Field(pattern=r"^/", max_length=4096)
    expires: float = Field(gt=0, allow_inf_nan=False)
    httpOnly: bool
    secure: bool
    sameSite: str = Field(pattern=r"^(Strict|Lax|None)$")


class LocalStorageValue(StrictContract):
    name: str = Field(min_length=1, max_length=4096)
    value: str = Field(max_length=MAX_SESSION_BYTES, repr=False)


class SiteStorage(StrictContract):
    origin: str = Field(max_length=4096)
    localStorage: tuple[LocalStorageValue, ...] = Field(max_length=4096, repr=False)


class RememberedState(StrictContract):
    cookies: tuple[PersistentCookie, ...] = Field(max_length=4096, repr=False)
    origins: tuple[SiteStorage, ...] = Field(max_length=20, repr=False)

    @model_validator(mode="after")
    def bound_serialization(self):
        if len(self.model_dump_json().encode()) > MAX_SESSION_BYTES:
            raise ValueError("remembered state exceeds limit")
        return self

    def for_origins(self, approved: frozenset[str], *, now: float | None = None) -> RememberedState:
        now = time.time() if now is None else now
        if not 1 <= len(approved) <= 20 or any(
            public_origin(origin) != origin for origin in approved
        ):
            raise BrowserRefused("BROWSER_SESSION_ORIGINS_REFUSED")
        hosts = {urlsplit(origin).hostname for origin in approved}
        if any(
            public_origin(entry.origin) != entry.origin or entry.origin not in approved
            for entry in self.origins
        ):
            raise BrowserRefused("BROWSER_SESSION_ORIGINS_REFUSED")
        # A parent-domain cookie needs that parent explicitly admitted. It never
        # grants network authority to siblings: the broker still checks origins.
        if any(cookie.domain.lstrip(".") not in hosts for cookie in self.cookies):
            raise BrowserRefused("BROWSER_SESSION_ORIGINS_REFUSED")
        return self.model_copy(
            update={"cookies": tuple(c for c in self.cookies if c.expires > now)}
        )


def persistent_state(raw: dict, approved: frozenset[str], *, now: float) -> RememberedState:
    # Called on private in-memory storageState, not an arbitrary file or profile.
    # Session-only cookies remain in the live context and end when it closes.
    if (
        not isinstance(raw, dict)
        or set(raw) != {"cookies", "origins"}
        or not isinstance(raw["cookies"], list)
    ):
        raise BrowserRefused("BROWSER_SESSION_STATE_UNSUPPORTED")
    try:
        # Validate expiry types even for cookies being excluded; malformed
        # browser state must not become a silent partial save.
        cookies = []
        for cookie in raw["cookies"]:
            if not isinstance(cookie, dict) or type(cookie.get("expires")) not in {int, float}:
                raise ValueError("invalid cookie expiry")
            if cookie["expires"] > now:
                cookies.append(cookie)
        data = {**raw, "cookies": cookies}
        return RememberedState.model_validate_json(json.dumps(data)).for_origins(approved, now=now)
    except (ValueError, TypeError):
        raise BrowserRefused("BROWSER_SESSION_STATE_REFUSED") from None
