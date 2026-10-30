"""Google Calendar inside the owner's own agent: its own login, its own proposal log.

``GoogleCalendarService`` asks two things of its surroundings: an access token for a
service at a level (``connections.access_token``) and somewhere to keep a prepared
change until the owner confirms it (``proposals``). On the hub both are database
rows. In an agent that runs in the owner's own cloud:

* :class:`PodGoogleConnections` answers ``access_token`` from the login sealed to the
  agent (``PodGoogleTokenSource``), scope-narrowed to the level asked for;
* :class:`PodCalendarProposalStore` keeps the plan in the owner's own sealed log
  (``pod_action_proposals``), claimed once by the owner's confirmation.

:func:`pod_calendar_service` builds that service, and only inside an owner-cloud
agent; everywhere else it returns None and the hub's service is used unchanged.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal, Optional

from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    _SERVICE_SCOPES,
    GoogleConnectionError,
    _scopes_cover,
)
from hushh_mcp.services.pod_action_proposals import PodActionProposalStore, pod_action_proposals
from hushh_mcp.services.pod_connector_tokens import (
    CREDENTIALS_UNAVAILABLE,
    NEEDS_REAUTH,
    NOT_CONNECTED,
    PROVIDER_UNREACHABLE,
    SCOPE_NOT_GRANTED,
    ConnectorTokenError,
    google_token_source,
)

#: Typed grant failures may offer owner reauthorization. HTTP status alone must
#: never turn an owner mismatch or provider outage into a connection directive.
_STATUS = {NOT_CONNECTED: 401, NEEDS_REAUTH: 401, CREDENTIALS_UNAVAILABLE: 503}
_REASONS = {
    NOT_CONNECTED: "google_not_connected",
    NEEDS_REAUTH: "google_reauthorization_required",
    SCOPE_NOT_GRANTED: "google_permission_required",
}
_SERVICES = frozenset({"calendar", "gmail", "drive"})


def _pod_owner() -> str:
    from hushh_mcp.services.pod_owner_cloud import pod_owner_user_id  # noqa: PLC0415

    return str(pod_owner_user_id())


class PodGoogleConnections:
    """``GoogleConnectionService.access_token``'s contract, from the agent's own login."""

    def __init__(self, *, token_source: Any = None, owner_user_id: str = "") -> None:
        self._source = token_source
        self._owner = owner_user_id
        self.credential_id: Optional[str] = None

    def require_current(self, service: str = "calendar") -> credentials.ConnectorCredential:
        try:
            held = credentials.active_connector_credential(service)
        except credentials.ConnectorCredentialsUnavailable:
            raise GoogleConnectionError("Google connection unavailable", status_code=503) from None
        if held is None or held.status != credentials.STATUS_CONNECTED:
            raise GoogleConnectionError(
                "Connect Google first",
                status_code=401,
                reason_code=_REASONS[
                    NEEDS_REAUTH
                    if held and held.status == credentials.STATUS_NEEDS_REAUTH
                    else NOT_CONNECTED
                ],
            )
        if self.credential_id is not None and held.credential_id != self.credential_id:
            raise GoogleConnectionError("Google connection changed; review again", status_code=409)
        self.credential_id = held.credential_id
        return held

    def _owner_credential(
        self, user_id: str, service: str
    ) -> credentials.ConnectorCredential | None:
        if not user_id or user_id != (self._owner or _pod_owner()) or service not in _SERVICES:
            return None
        try:
            return credentials.active_connector_credential(service)
        except credentials.ConnectorCredentialsUnavailable:
            raise GoogleConnectionError("Google connection unavailable", status_code=503) from None

    async def read_grant_binding(
        self, *, user_id: str, service: Literal["drive", "calendar"]
    ) -> tuple[str, ...] | None:
        held = self._owner_credential(user_id, service)
        required = set(_SERVICE_SCOPES.get(service, {}).get("read", ()))
        if (
            held is None
            or held.status != credentials.STATUS_CONNECTED
            or not required
            or not _scopes_cover(set(held.granted_scopes), required)
        ):
            return None
        # Refresh rotates generation without changing the approved account/grant.
        # Reconnect, revocation or scope changes must invalidate an in-flight read.
        return (
            user_id,
            service,
            held.credential_id,
            held.account_subject,
            str(held.connected_at_ms),
            *sorted(held.granted_scopes),
        )

    async def has_service_scope(self, *, user_id: str, service: str, scope: str) -> bool:
        held = self._owner_credential(user_id, service)
        return bool(
            held
            and held.status == credentials.STATUS_CONNECTED
            and _scopes_cover(set(held.granted_scopes), {scope})
        )

    async def status(self, *, user_id: str, service: str) -> dict[str, Any]:
        held = self._owner_credential(user_id, service)
        connected = bool(held and held.status == credentials.STATUS_CONNECTED)
        return {"connected": connected, "status": held.status if held else "disconnected"}

    async def access_token(
        self, *, user_id: str, service: Any, access_level: Literal["read", "manage"]
    ) -> str:
        if not user_id or user_id != (self._owner or _pod_owner()):
            raise GoogleConnectionError("Google connection owner mismatch", status_code=403)
        if service not in _SERVICES:
            # Contacts never borrow this door; they have their own in-agent reader.
            raise GoogleConnectionError("Google service unavailable here", status_code=403)
        source = self._source if self._source is not None else google_token_source()
        self.require_current(service)
        try:
            token = str(await source.access_token(service, access_level))
        except ConnectorTokenError as exc:
            status = _STATUS.get(exc.code, 502 if exc.code == PROVIDER_UNREACHABLE else 403)
            raise GoogleConnectionError(
                "Google connection is not ready on your agent",
                status_code=status,
                reason_code=_REASONS.get(exc.code),
            ) from None
        self.require_current(service)
        return token


class PodCalendarProposalStore:
    """``CalendarProposalStore`` over the owner's own log (kind ``calendar``)."""

    KIND = "calendar"

    def __init__(
        self,
        store: Optional[PodActionProposalStore] = None,
        connections: Optional[PodGoogleConnections] = None,
    ) -> None:
        self._store = store
        self._connections = connections or PodGoogleConnections()

    def _proposals(self) -> PodActionProposalStore:
        return self._store if self._store is not None else pod_action_proposals()

    async def purge(self, *, user_id: str) -> None:
        # Expiry is checked on every claim; an append-only log has nothing to delete.
        return None

    async def issue(
        self, *, user_id: str, action: str, plan: dict[str, Any], expected_etag: Optional[str]
    ) -> tuple[str, datetime]:
        bound = self._connections.require_current().credential_id
        issued = await self._proposals().issue(
            kind=self.KIND,
            owner_id=user_id,
            payload={
                "action": action,
                "plan": plan,
                "expected_event_etag": expected_etag,
                "credential_id": bound,
            },
        )
        self._connections.require_current()
        expires_at = datetime.fromtimestamp(issued["expires_at_ms"] / 1000, tz=UTC)
        return issued["proposal_id"], expires_at

    async def claim(self, *, user_id: str, proposal_id: str) -> Optional[dict[str, Any]]:
        payload = await self._proposals().claim(
            proposal_id=proposal_id, owner_id=user_id, kind=self.KIND
        )
        if not payload or not isinstance(payload.get("plan"), dict):
            return None
        self._connections.credential_id = str(payload.get("credential_id") or "")
        try:
            self._connections.require_current()
        except GoogleConnectionError:
            await self._proposals().settle(proposal_id=proposal_id, status="failed")
            raise
        return {
            "action": payload.get("action"),
            "plan": dict(payload["plan"]),
            "expected_event_etag": payload.get("expected_event_etag"),
        }

    async def finish(self, *, user_id: str, proposal_id: str, executed: bool) -> None:
        await self._proposals().settle(
            proposal_id=proposal_id, status="executed" if executed else "failed"
        )

    async def forget_executed(self, *, user_id: str, proposal_id: str) -> None:
        # Settled is final: the plan stays sealed in the owner's own log, never readable
        # again by a claim, and never anywhere Hussh can read it.
        return None


def calendar_runs_locally() -> bool:
    """True inside an owner-cloud agent: Calendar is read and changed here, never via the hub."""
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent  # noqa: PLC0415

    return bool(owner_cloud_agent())


def calendar_reads_via_door() -> bool:
    """Compatibility facade for the tool-runtime Calendar admission port."""
    from hushh_mcp.one_adk.pod_connector_tools import calendar_reads_via_door as admitted

    return admitted()


async def calendar_turn_refusal(tool_context: Any) -> Optional[dict[str, Any]]:
    """Compatibility facade for the tool-runtime Calendar owner check."""
    from hushh_mcp.one_adk.pod_connector_tools import calendar_turn_refusal as refusal

    return await refusal(tool_context)


def pod_calendar_service() -> Any:
    """A ``GoogleCalendarService`` on the agent's own login and log, or None off owner cloud."""
    if not calendar_runs_locally():
        return None
    connections = PodGoogleConnections()
    return PodCalendarService(
        connections=connections, proposals=PodCalendarProposalStore(connections=connections)
    )


class PodCalendarService(GoogleCalendarService):
    """One Calendar operation, fenced to the credential with which it started."""

    connections: PodGoogleConnections

    async def _request(self, **options: Any) -> dict[str, Any]:
        result = await super()._request(**options)
        try:
            self.connections.require_current()
        except GoogleConnectionError:
            if options.get("method") != "GET":
                raise GoogleConnectionError(
                    "Calendar change outcome is unknown; check Calendar before retrying",
                    status_code=502,
                ) from None
            raise
        return dict(result)


__all__ = [
    "PodCalendarProposalStore",
    "PodGoogleConnections",
    "calendar_reads_via_door",
    "calendar_turn_refusal",
    "calendar_runs_locally",
    "pod_calendar_service",
]
