"""Owner-bound Google Calendar account photos for presentation only."""

from __future__ import annotations

import asyncio
import re
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

from cachetools import TTLCache

from hushh_mcp.services.google_oauth_attempt import connection_generation

_GOOGLE_PICTURE_HOST = re.compile(r"lh[3-6](?:-tt|-d[a-gz])?\.(?:google|googleusercontent)\.com")


class CalendarPhotoOwner(Protocol):
    async def access_token(
        self,
        *,
        user_id: str,
        service: Literal["calendar"],
        access_level: Literal["read"],
        account_id: str,
    ) -> str: ...

    async def _userinfo(self, access_token: str) -> dict[str, Any]: ...

    async def _connection(self, user_id: str) -> dict[str, Any] | None: ...

    async def _calendar_account(self, user_id: str, account_id: str) -> dict[str, Any] | None: ...


def _google_picture_url(value: object | None) -> str | None:
    """Only expose Google's avatar URL family from verified userinfo."""
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or url.port is not None
            or url.query
            or url.fragment
            or not url.hostname
            or not _GOOGLE_PICTURE_HOST.fullmatch(url.hostname)
            or not re.match(r"^/a(?:-)?/", url.path)
        ):
            return None
    except ValueError:
        return None
    return value


class CalendarProfilePhotos:
    """Resolve photos through the matching grant, then fence on its generation."""

    def __init__(self, owner: CalendarPhotoOwner) -> None:
        self.owner = owner
        self.cache: TTLCache[tuple[str, str, str, str], str] = TTLCache(maxsize=512, ttl=900)
        self.failure_cache: TTLCache[tuple[str, str, str, str], bool] = TTLCache(
            maxsize=512, ttl=60
        )

    async def lookup(self, *, user_id: str, account_id: str, row: dict[str, Any]) -> str | None:
        subject = str(row.get("provider_subject") or "").strip()
        if row.get("status") != "connected" or not subject:
            return None
        generation = connection_generation(row)
        key = (user_id, account_id, subject, generation)
        cached = self.cache.get(key)
        if cached:
            return cached
        if key in self.failure_cache:
            return None
        try:
            async with asyncio.timeout(8):
                token = await self.owner.access_token(
                    user_id=user_id,
                    service="calendar",
                    access_level="read",
                    account_id=account_id,
                )
                profile = await self.owner._userinfo(token)
            current = (
                await self.owner._connection(user_id)
                if account_id == "default"
                else await self.owner._calendar_account(user_id, account_id)
            )
            if (
                not current
                or current.get("status") != "connected"
                or connection_generation(current) != generation
                or str(profile.get("sub") or "").strip() != subject
            ):
                return None
            picture = _google_picture_url(profile.get("picture"))
        except Exception:
            # A photo lookup cannot make Calendar status unavailable. Cache the
            # fallback briefly so a provider failure does not flood polling.
            picture = None
        if picture:
            self.cache[key] = picture
        else:
            self.failure_cache[key] = True
        return picture
