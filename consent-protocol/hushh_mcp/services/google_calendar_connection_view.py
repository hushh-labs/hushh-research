"""Account-bound port over the existing Google Calendar connection service."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from hushh_mcp.services.google_calendar_meeting_grant import CalendarGrantIdentity
    from hushh_mcp.services.google_connection_service import GoogleConnectionService, GoogleService


class CalendarAccountConnectionView:
    """A narrow account-bound authority port for the existing Calendar runtime."""

    def __init__(self, owner: GoogleConnectionService, account_id: str) -> None:
        if not account_id or len(account_id) > 128:
            from hushh_mcp.services.google_connection_service import GoogleConnectionError

            raise GoogleConnectionError("Choose a valid Calendar account", status_code=422)
        self.owner = owner
        self.account_id = account_id

    async def access_token(
        self, *, user_id: str, service: GoogleService, access_level: Literal["read", "manage"]
    ) -> str:
        return await self.owner.access_token(
            user_id=user_id, service=service, access_level=access_level, account_id=self.account_id
        )

    async def status(self, *, user_id: str, service: str) -> dict[str, Any]:
        return await self.owner.status(user_id=user_id, service=service, account_id=self.account_id)

    async def has_service_scope(self, *, user_id: str, service: GoogleService, scope: str) -> bool:
        return await self.owner.has_service_scope(
            user_id=user_id, service=service, scope=scope, account_id=self.account_id
        )

    async def read_grant_binding(
        self, *, user_id: str, service: Literal["drive", "calendar"]
    ) -> tuple[str, ...] | None:
        return await self.owner.read_grant_binding(
            user_id=user_id, service=service, account_id=self.account_id
        )

    async def read_calendar_grant_identity(self, *, user_id: str) -> CalendarGrantIdentity | None:
        return await self.owner.read_calendar_grant_identity(
            user_id=user_id, account_id=self.account_id
        )
