"""Settings' "refresh tools" for a private connector, run inside the owner's agent.

The hub's ``mcp_review_service.discover_catalog`` admits its turn with a hub-verified
vault-owner token, and the browser has to send the connector's access token to the
hub to use it. For an owner whose agent runs in their own cloud, the same discovery
runs here instead: the connector configuration (and the credential inside it) goes
only to the owner's agent, and the turn is admitted by this pod's own session
authority, never by a hub call.

Discovery only. Every tool is listed under ``_never_execute``, so nothing a server
returns can run; names are untrusted display text and no schema, result or
credential is returned.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from google.adk.agents.context import Context
from google.adk.agents.invocation_context import InvocationContext
from google.adk.sessions import InMemorySessionService, Session

from hushh_mcp.one_adk.governed_mcp_toolset import (
    _annotated_read_only,
    mcp_review_outcome,
    mcp_tool_fingerprint,
)
from hushh_mcp.one_adk.mcp_review_service import _never_execute
from hushh_mcp.one_adk.mcp_turn_scope import mcp_turn_scope, validate_mcp_turn_configurations
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.services.external_mcp_client import ExternalMcpError


def _tool_view(toolset: Any, tool: Any, blocked: set[tuple[str, str]], blocked_ids: set[str]):
    fingerprint = mcp_tool_fingerprint(tool.descriptor)
    review = mcp_review_outcome(
        toolset.review_policy, tool.descriptor, forced=tool.name in blocked_ids
    )
    return {
        "id": tool.name,
        "name": tool.descriptor["name"],
        "revision": tool.revision,
        "fingerprint": fingerprint,
        "permission": "blocked" if (tool.name, fingerprint) in blocked else "ask_first",
        "review": "required" if review == "required" else "not_required",
        "access": "read" if _annotated_read_only(tool.descriptor) else "write",
    }


async def discover_private_catalog(owner: Any, connector_id: str, configuration: dict[str, Any]):
    """The same response shape as the hub's catalog route, admitted by the pod."""
    await owner.require_access()
    records = validate_mcp_turn_configurations([configuration])
    from hushh_mcp.one_adk.pod_custody_mcp import merge_turn_configurations  # noqa: PLC0415
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent  # noqa: PLC0415

    if owner_cloud_agent() and not merge_turn_configurations(list(records.values()), []):
        raise ExternalMcpError("Connector unavailable.", code="MCP_CONNECTION_CHANGED")
    record = records.get(connector_id)
    if record is None or not record["enabled"]:
        raise ExternalMcpError(
            "Connector unavailable.", code="MCP_CONNECTION_CHANGED", status_code=404
        )
    thread = f"catalog-{uuid4().hex}"
    context = Context(
        InvocationContext(
            session_service=InMemorySessionService(),
            invocation_id=uuid4().hex,
            session=Session(
                id=thread,
                app_name="hussh_one",
                user_id=owner.owner,
                state={
                    "hussh:user_id": owner.owner,
                    "hussh:conversation_id": thread,
                    "hussh:consent_token": store_request_secret(
                        owner.authority.local_token(owner.claims)
                    ),
                    "temp:one_execution_surface": "typed_chat",
                },
            ),
        )
    )
    # Settings keeps blocked tools visible so the owner can unblock them.
    visible_record = {**record, "blockedTools": []}
    blocked = {(entry["id"], entry["fingerprint"]) for entry in record.get("blockedTools", [])}
    blocked_ids = {tool_id for tool_id, _ in blocked}
    async with mcp_turn_scope(
        thread,
        owner_id=owner.owner,
        configurations=[visible_record],
        owner_admission=owner._mcp_owner_admission,
        vault_only=True,
    ) as scope:
        toolset = await scope.acquire(context, connector_id, authorize_call=_never_execute)
        tools = await toolset.get_tools(context)
        await owner.require_access()
        return {
            "connectorId": connector_id,
            "configurationRevision": record["revision"],
            "status": "available" if tools else "empty",
            "tools": [_tool_view(toolset, tool, blocked, blocked_ids) for tool in tools],
        }


__all__ = ["discover_private_catalog"]
