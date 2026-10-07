"""Which connector tools One gets inside the owner's own agent, and who may call them.

The hub's Workspace tools refuse inside any pod: their owner check reads hub state
(``validate_first_party_owner_token``) and their credentials are hub rows. An agent in
the owner's own cloud holds its own Google logins instead, so here:

* :func:`pod_tool_owner` is the in-agent owner check every connector tool shares. The
  turn state is built by the agent's own chat route from a verified app session
  (``pod_agent_chat.trusted_state``): the owner's user id, the typed-chat surface and
  a request-scoped ``pod-session:`` token. A hosted pod, the hub, a voice turn, or a
  state that does not carry all of these is refused;
* :func:`pod_connector_roster` is the tool list One adds in an owner-cloud agent:
  Drive (read, write, reviewed share and trash), reviewed Gmail mailbox changes and
  Contacts. Each tool still checks its own login at call time and asks the owner to
  connect when it is missing, so the list never depends on what is connected yet.

Calendar keeps its existing tools, which call :func:`pod_tool_owner` through
``pod_google_connections.calendar_turn_refusal`` before any local read or proposal.
"""

from __future__ import annotations

from typing import Any, Optional

from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent, pod_owner_user_id

_PROVIDERS = frozenset({"drive", "gmail", "contacts", "calendar"})


async def pod_tool_owner(tool_context: Any, provider: str) -> Optional[str]:
    """The owner's user id when this call may use ``provider`` in this agent; else None."""
    from hushh_mcp.one_adk.request_secrets import _PREFIX as REQUEST_SECRET_PREFIX  # noqa: PLC0415
    from hushh_mcp.one_adk.request_secrets import resolve_request_secret  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX  # noqa: PLC0415

    if provider not in _PROVIDERS or not owner_cloud_agent():
        return None
    state = getattr(tool_context, "state", None)
    if state is None or state.get("temp:one_execution_surface") != "typed_chat":
        return None
    owner = str(state.get("hussh:user_id") or "").strip()
    if not owner or getattr(tool_context, "user_id", None) != owner:
        return None
    if owner != pod_owner_user_id():
        return None
    reference = str(state.get("hussh:consent_token") or "")
    if not reference.startswith(REQUEST_SECRET_PREFIX):
        return None  # the route only ever stores a request-scoped reference here
    try:
        token = str(resolve_request_secret(reference) or "")
    except Exception:  # noqa: BLE001 - an expired or foreign reference is simply no owner
        return None
    return owner if token.startswith(LOCAL_TOKEN_PREFIX) else None


def pod_connector_roster() -> list[Any]:
    """One's connector tools in an owner-cloud agent; nothing anywhere else."""
    if not owner_cloud_agent():
        return []
    from hushh_mcp.agents.email.mailbox_tools import propose_gmail_mailbox_change
    from hushh_mcp.one_adk.drive_tools import discover_google_drive_tools, read_google_drive
    from hushh_mcp.one_adk.drive_write_tools import (
        comment_on_drive_file,
        copy_drive_file,
        create_drive_file,
        move_drive_file,
        propose_drive_file_share,
        propose_drive_file_trash,
    )
    from hushh_mcp.pod_connectors.contacts_tool import search_my_contacts

    return [
        discover_google_drive_tools,
        read_google_drive,
        create_drive_file,
        copy_drive_file,
        move_drive_file,
        comment_on_drive_file,
        propose_drive_file_share,
        propose_drive_file_trash,
        propose_gmail_mailbox_change,
        search_my_contacts,
    ]


__all__ = ["owner_cloud_agent", "pod_connector_roster", "pod_tool_owner"]
