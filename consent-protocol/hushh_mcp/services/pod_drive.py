"""Google Drive inside the owner's own agent, on the Drive login sealed to that agent.

The hub's Drive tools sit on four hub-only things, and an owner-cloud agent has none
of them. Each is refused here by name rather than quietly worked around:

* ``external_connector_*`` OAuth rows (``ExternalConnectorOAuthService.drive()``:
  ``current_credential``), where the hub keeps the Drive login;
* the connector lifecycle rows (``lifecycle.read``) the hub fences each call with;
* ``action_directive_ledger`` (``ActionDirectiveStore``), where a reviewed share or
  trash waits for the owner;
* ``validate_first_party_owner_token``, the hub's database check of an owner token.

In their place: the agent's own login (``PodGoogleTokenSource``, ``drive`` at
``read`` or ``manage``), a fence on that login's credential id, the owner's own sealed
log for reviewed writes (``pod_action_proposals``, kind ``drive``), and the owner's
own session for confirmation (``POST /api/one/pod/actions/{proposal_id}/confirm``).
The REST operations themselves (search, read, create, copy, move, comment, share,
trash) are ``GoogleDriveRestTransport``'s, unchanged.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Optional

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_rest_transport import (
    _WRITE_OPERATIONS,
    GoogleDriveRestTransport,
)
from hushh_mcp.services.google_drive_write_adapter import DriveWriteError
from hushh_mcp.services.pod_action_proposals import PodActionProposalStore, pod_action_proposals
from hushh_mcp.services.pod_connector_tokens import (
    NEEDS_REAUTH,
    NOT_CONNECTED,
    ConnectorTokenError,
    google_token_source,
)

logger = logging.getLogger(__name__)
DRIVE = "drive"
KIND = "drive"

#: Every hub table the hub's Drive tools read, refused in the agent (see the docstring).
HUB_TABLES_REFUSED: tuple[str, ...] = (
    "external_connector_oauth_credentials",
    "external_connector_lifecycle",
    "action_directive_ledger",
    "first_party_owner_tokens",
)


class HubDriveTableRefused(RuntimeError):
    """A hub Drive path asked for a hub table inside the owner's agent."""


class _HubOAuthRefused:
    """Stands where the hub's Drive OAuth service would be; any use is a refusal."""

    def __getattr__(self, name: str) -> Any:
        raise HubDriveTableRefused(f"{name} reads {', '.join(HUB_TABLES_REFUSED[:2])}")


def held_drive() -> Optional[store.ConnectorCredential]:
    """The agent's Drive login, or None. An unreadable store is ``reconnect_required``."""
    try:
        return store.active_connector_credential(DRIVE)
    except store.ConnectorCredentialsUnavailable:
        raise DriveOAuthError("connector_unavailable", status_code=503) from None


def _token_error(exc: ConnectorTokenError) -> DriveOAuthError:
    if exc.code in {NOT_CONNECTED, NEEDS_REAUTH}:
        return DriveOAuthError("reconnect_required", status_code=401)
    return DriveOAuthError("connector_unavailable", status_code=403)


class PodDriveRestTransport(GoogleDriveRestTransport):
    """The hub transport's operations behind the agent's own Drive login."""

    def __init__(self, owner_user_id: str, *, token_source: Any = None, **adapters: Any) -> None:
        super().__init__(oauth=_HubOAuthRefused(), **adapters)
        self._owner = owner_user_id
        self._source = token_source

    async def _fenced(
        self,
        user_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        operations: dict[str, str],
        max_bytes: int,
        *,
        expected_generation: int | None = None,
    ) -> ExternalMcpToolResult:
        if not user_id or user_id != self._owner or tool_name not in operations:
            raise DriveOAuthError("connector_unavailable", status_code=403)
        if not isinstance(arguments, dict):
            raise DriveOAuthError("invalid_argument", status_code=400)
        try:
            encoded = json.dumps(arguments, allow_nan=False, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            raise DriveOAuthError("invalid_argument", status_code=400) from None
        if len(encoded) > max_bytes:
            raise DriveOAuthError("invalid_argument", status_code=400)
        writes = operations is _WRITE_OPERATIONS
        before = held_drive()
        if before is None or before.status != store.STATUS_CONNECTED:
            raise DriveOAuthError("reconnect_required", status_code=401)
        if expected_generation is not None and before.generation != expected_generation:
            raise DriveOAuthError("connection_changed", status_code=409)
        source = self._source if self._source is not None else google_token_source()
        try:
            token = str(await source.access_token(DRIVE, "manage" if writes else "read"))
        except ConnectorTokenError as exc:
            raise _token_error(exc) from None
        ready = held_drive()
        if (
            ready is None
            or ready.status != store.STATUS_CONNECTED
            or ready.credential_id != before.credential_id
        ):
            raise DriveOAuthError("connection_changed", status_code=409)
        payload: dict = await getattr(self, operations[tool_name])(arguments, token)
        after = held_drive()
        if (
            after is None
            or after.status != store.STATUS_CONNECTED
            or after.credential_id != before.credential_id
        ):
            if writes:
                # Sent under the login that was current then: never "failed", never retried.
                raise DriveWriteError("write_outcome_unknown", outcome_unknown=True)
            raise DriveOAuthError("connection_changed", status_code=409)
        return ExternalMcpToolResult(is_error=False, payload=payload, truncated=False)


def pod_drive_transport(owner_user_id: str) -> PodDriveRestTransport:
    return PodDriveRestTransport(owner_user_id)


def transport_for(owner_user_id: str, hub_transport: Any) -> GoogleDriveRestTransport:
    """The hub transport off-pod; inside a pod, only ever the agent's own login."""
    from hushh_mcp.runtime_settings import pod_mode

    return pod_drive_transport(owner_user_id) if pod_mode() else hub_transport()


async def pod_review(owner: str, conversation: str, action: str, exact: dict) -> PodDriveReview:
    """``drive_write_tools``' review step in the agent: the owner's log, not the ledger."""
    from hushh_mcp.one_adk.drive_write_tools import REVIEWED_ACTIONS

    return await propose_drive_review(
        owner_id=owner, action=action, tool_name=REVIEWED_ACTIONS[action][1], arguments=exact
    )


async def discover_drive_tools(token_source: Any = None) -> list[dict[str, Any]]:
    """Drive's read tool schemas, fetched with the agent's own read token."""
    from hushh_mcp.services.google_drive_mcp_service import GoogleDriveMcpService
    from hushh_mcp.services.google_drive_rest_transport import REST_TOOLS

    source = token_source if token_source is not None else google_token_source()
    try:
        token = str(await source.access_token(DRIVE, "read"))
    except ConnectorTokenError as exc:
        raise _token_error(exc) from None
    service = GoogleDriveMcpService(oauth=_HubOAuthRefused())
    tools = await service.discover_read_tools(access_token=token)
    return [tool for tool in tools if tool.get("name") in REST_TOOLS]


@dataclass(frozen=True)
class PodDriveReview:
    """The issued review, shaped like the hub ledger's answer the card is built from."""

    directive_id: str
    expires_at: datetime


async def propose_drive_review(
    *,
    owner_id: str,
    action: str,
    tool_name: str,
    arguments: dict[str, Any],
    proposals: Optional[PodActionProposalStore] = None,
) -> PodDriveReview:
    """Keep one reviewed share or trash in the owner's log, bound to this Drive login."""
    held = held_drive()
    if held is None or held.status != store.STATUS_CONNECTED:
        raise DriveOAuthError("reconnect_required", status_code=401)
    issued = await (proposals or pod_action_proposals()).issue(
        kind=KIND,
        owner_id=owner_id,
        payload={
            "action": action,
            "tool": tool_name,
            "arguments": dict(arguments),
            "credential_id": held.credential_id,
        },
        ttl_s=300,
    )
    return PodDriveReview(
        issued["proposal_id"], datetime.fromtimestamp(issued["expires_at_ms"] / 1000, UTC)
    )


async def execute_drive_review(
    *,
    owner_id: str,
    proposal_id: str,
    transport: Optional[GoogleDriveRestTransport] = None,
    proposals: Optional[PodActionProposalStore] = None,
) -> dict[str, Any]:
    """Run one reviewed Drive write after the owner's own session confirmed it. Once."""
    from hushh_mcp.one_adk.drive_write_tools import REVIEWED_ACTIONS, normalized_arguments

    book = proposals or pod_action_proposals()
    proposal = await book.claim(proposal_id=proposal_id, owner_id=owner_id, kind=KIND)
    if not proposal:
        raise DriveOAuthError("connection_changed", status_code=409)
    status = "failed"
    try:
        action = str(proposal.get("action") or "")
        if action not in REVIEWED_ACTIONS or proposal.get("tool") != REVIEWED_ACTIONS[action][1]:
            raise DriveWriteError("invalid_argument")
        exact = normalized_arguments(action, proposal.get("arguments"))
        held = held_drive()
        if held is None or held.credential_id != proposal.get("credential_id"):
            # Reviewed under another Drive login: refuse before anything is sent.
            raise DriveOAuthError("connection_changed", status_code=409)
        result = await (transport or pod_drive_transport(owner_id)).write_tool(
            user_id=owner_id, tool_name=REVIEWED_ACTIONS[action][1], arguments=exact
        )
        status = "executed"
        return {"status": "ok", "action": action, **result.payload}
    finally:
        await book.settle(proposal_id=proposal_id, status=status)


__all__ = [
    "HUB_TABLES_REFUSED",
    "HubDriveTableRefused",
    "PodDriveRestTransport",
    "PodDriveReview",
    "discover_drive_tools",
    "execute_drive_review",
    "held_drive",
    "pod_drive_transport",
    "pod_review",
    "propose_drive_review",
    "transport_for",
]
