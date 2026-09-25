"""Authenticated browser review using the same native ADK MCP toolset.

No prompt, private result, approval arguments or credential is persisted here.
The existing encrypted session, registry and action ledger retain authority.
"""

from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from google.adk.agents.context import Context
from google.adk.agents.invocation_context import InvocationContext
from google.adk.sessions import InMemorySessionService, Session

from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.governed_mcp_toolset import (
    native_registration_admitted,
    validated_mcp_arguments,
)
from hushh_mcp.one_adk.mcp_call_approval import McpCallApproval
from hushh_mcp.one_adk.mcp_pending_call import pending_call_details, restore_pending_call
from hushh_mcp.one_adk.mcp_turn_scope import mcp_turn_scope, validate_mcp_turn_configurations
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.external_connector_registry_service import (
    get_external_connector_registry_service,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError


async def _never_execute(*_):
    return {"status": "permission_required"}


async def discover_catalog(
    *, token: dict[str, Any], connector_id: str, configuration: dict[str, Any]
):
    """Explicit Settings refresh; discover through the Chat toolset, never invoke."""
    owner = str(token["user_id"])
    records = validate_mcp_turn_configurations([configuration])
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
                user_id=owner,
                state={
                    "hussh:user_id": owner,
                    "hussh:conversation_id": thread,
                    "hussh:consent_token": store_request_secret(token["token"]),
                    "temp:one_execution_surface": "typed_chat",
                },
            ),
        )
    )
    async with mcp_turn_scope(thread, owner_id=owner, configurations=[record]) as scope:
        toolset = await scope.acquire(context, connector_id, authorize_call=_never_execute)
        tools = await toolset.get_tools(context)
        # Server-provided names are untrusted display text, not permission or
        # instructions. Exclude schemas/results/credentials from this UI view.
        return {
            "connectorId": connector_id,
            "configurationRevision": record["revision"],
            "status": "available" if tools else "empty",
            "tools": [
                {
                    "id": tool.name,
                    "name": tool.descriptor["name"],
                    "revision": tool.revision,
                    "permission": "ask_first",
                }
                for tool in tools
            ],
        }


@asynccontextmanager
async def review_tool(
    *,
    token: dict[str, Any],
    connector_id: str,
    conversation_id: str,
    tool_name: str,
    configuration: dict[str, Any] | None = None,
):
    owner = str(token["user_id"])
    if configuration is not None:
        records = validate_mcp_turn_configurations([configuration])
        record = records.get(connector_id)
        if record is None or not record["enabled"]:
            raise ExternalMcpError(
                "Connector unavailable.", code="MCP_CONNECTION_CHANGED", status_code=404
            )
        connector_label = record["displayName"]
    else:
        registry = get_external_connector_registry_service()
        definition = await registry.get_connector(connector_id, user_id=owner)
        if not native_registration_admitted(definition, owner):
            raise ExternalMcpError(
                "Connector unavailable.", code="MCP_CONNECTION_CHANGED", status_code=404
            )
        connector_label = definition.display_name
    sessions = EncryptedAdkSessionService()
    session = await sessions.get_session(
        app_name="hussh_one", user_id=owner, session_id=conversation_id
    )
    if session is None:
        raise ExternalMcpError(
            "Conversation unavailable.", code="MCP_CONVERSATION_MISSING", status_code=404
        )
    # Do not supply recovered conversation content to an external server. Only
    # authenticated invocation metadata is needed to run this reviewed call.
    invocation = InvocationContext(
        session_service=sessions,
        invocation_id=uuid4().hex,
        session=Session(
            id=conversation_id,
            app_name="hussh_one",
            user_id=owner,
            state={
                "hussh:user_id": owner,
                "hussh:conversation_id": conversation_id,
                "hussh:consent_token": store_request_secret(token["token"]),
                "temp:one_execution_surface": "typed_chat",
                "temp:hussh:workspace_chat_admission": True,
                "temp:mcp_connector_label": connector_label,
            },
        ),
    )
    context = Context(invocation, function_call_id=uuid4().hex)
    async with mcp_turn_scope(
        conversation_id,
        owner_id=owner,
        configurations=[configuration] if configuration is not None else None,
    ) as scope:
        toolset = await scope.acquire(context, connector_id, authorize_call=_never_execute)
        tools = await toolset.get_tools(context)
        tool = next((item for item in tools if item.name == tool_name), None)
        if tool is None:
            raise ExternalMcpError(
                "Refresh this connector's tools.", code="MCP_CATALOG_CHANGED", status_code=409
            )
        yield context, tool


def current_approval(context: Context, tool: Any, arguments: dict[str, Any]) -> McpCallApproval:
    args = validated_mcp_arguments(tool.descriptor["inputSchema"], arguments)
    return McpCallApproval.from_call(
        context, tool.toolset.binding, tool.descriptor["name"], tool.revision, args
    )


async def prepare_review(
    *,
    token: dict[str, Any],
    connector_id: str,
    conversation_id: str,
    tool_name: str,
    arguments: dict[str, Any],
    pending_handle: str | None = None,
    configuration: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if pending_handle:
        return await prepare_pending_review(
            token=token,
            connector_id=connector_id,
            conversation_id=conversation_id,
            tool_name=tool_name,
            pending_handle=pending_handle,
            configuration=configuration,
        )
    async with review_tool(
        token=token,
        connector_id=connector_id,
        conversation_id=conversation_id,
        tool_name=tool_name,
        configuration=configuration,
    ) as (context, tool):
        approval = current_approval(context, tool, arguments)
        issued = await approval.issue(ActionDirectiveStore())
        return {
            "directiveId": issued.directive_id,
            "expiresAt": issued.expires_at.isoformat(),
            "connectorId": connector_id,
            "toolName": tool_name,
            "toolLabel": tool.descriptor["name"],
            "connectorLabel": context.state.get("temp:mcp_connector_label", "Connected app"),
            "arguments": approval.arguments,
            "status": "review_required",
        }


async def confirm_review(
    *,
    token: dict[str, Any],
    connector_id: str,
    conversation_id: str,
    tool_name: str,
    arguments: dict[str, Any],
    directive_id: str,
    confirmed: bool,
    pending_handle: str | None = None,
    configuration: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if pending_handle:
        pending = await prepare_pending_review(
            token=token,
            connector_id=connector_id,
            conversation_id=conversation_id,
            tool_name=tool_name,
            pending_handle=pending_handle,
            configuration=configuration,
        )
        if directive_id != pending["directiveId"] or arguments != pending["arguments"]:
            raise ActionDirectiveAuthorityError("Pending call changed. Review again.")
    ledger = ActionDirectiveStore()
    async with review_tool(
        token=token,
        connector_id=connector_id,
        conversation_id=conversation_id,
        tool_name=tool_name,
        configuration=configuration,
    ) as (context, tool):
        approval = current_approval(context, tool, arguments)
        receipt = await approval.confirm(ledger, directive_id=directive_id, confirmed=confirmed)
        # This is NOT a second execution path. The browser supplies this
        # ephemeral receipt to the resumed Chat call, whose native tool port
        # rechecks current authority and consumes once before dispatch. Never
        # retain this response in history, storage, diagnostics or model input.
        return {
            "status": "confirmed",
            "directiveId": directive_id,
            "receipt": receipt.receipt,
            "expiresAt": receipt.expires_at.isoformat(),
        }


async def prepare_pending_review(
    *,
    token: dict[str, Any],
    connector_id: str,
    conversation_id: str,
    tool_name: str,
    pending_handle: str,
    configuration: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Preview the already-issued native call; never issue another directive."""
    session = await EncryptedAdkSessionService().get_session(
        app_name="hussh_one",
        user_id=str(token["user_id"]),
        session_id=conversation_id,
    )
    if session is None:
        raise ActionDirectiveAuthorityError("Conversation unavailable.")
    pending = pending_call_details(session, pending_handle)
    restore_pending_call(session, pending_handle)  # Require both native call identities.
    review = pending.get("review")
    if (
        not isinstance(review, dict)
        or review.get("connectorId") != connector_id
        or pending["tool_name"] != tool_name
    ):
        raise ActionDirectiveAuthorityError("Pending call changed. Review again.")
    async with review_tool(
        token=token,
        connector_id=connector_id,
        conversation_id=conversation_id,
        tool_name=tool_name,
        configuration=configuration,
    ) as (context, tool):
        if tool.revision != review.get("catalogRevision"):
            raise ActionDirectiveAuthorityError("Connector tools changed. Review again.")
        approval = current_approval(context, tool, pending["arguments"])
        return {
            "directiveId": review["directiveId"],
            "expiresAt": review["expiresAt"],
            "connectorId": connector_id,
            "toolName": tool_name,
            "toolLabel": tool.descriptor["name"],
            "connectorLabel": context.state.get("temp:mcp_connector_label", "Connected app"),
            "arguments": approval.arguments,
            "status": "review_required",
            "pendingHandle": pending_handle,
        }
