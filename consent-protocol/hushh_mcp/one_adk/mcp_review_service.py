"""Authenticated browser review using the same native ADK MCP toolset.

No prompt, private result, approval arguments or credential is persisted here.
The existing encrypted session, registry and action ledger retain authority.
"""

from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from google.adk.agents.context import Context
from google.adk.agents.invocation_context import InvocationContext
from google.adk.sessions import Session

from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.governed_mcp_toolset import validated_mcp_arguments
from hushh_mcp.one_adk.mcp_call_approval import McpCallApproval
from hushh_mcp.one_adk.mcp_pending_call import pending_call_details, restore_pending_call
from hushh_mcp.one_adk.mcp_turn_scope import mcp_turn_scope
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


@asynccontextmanager
async def review_tool(
    *,
    token: dict[str, Any],
    connector_id: str,
    conversation_id: str,
    tool_name: str,
):
    owner = str(token["user_id"])
    registry = get_external_connector_registry_service()
    definition = await registry.get_connector(connector_id, user_id=owner)
    # Curated providers retain their existing adapters/admission until parity.
    # In particular, selected-file credentials cannot become account-wide access.
    if definition is None or definition.owner_user_id != owner:
        raise ExternalMcpError(
            "Connector unavailable.", code="MCP_CONNECTION_CHANGED", status_code=404
        )
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
            },
        ),
    )
    context = Context(invocation, function_call_id=uuid4().hex)
    async with mcp_turn_scope(conversation_id) as scope:
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
) -> dict[str, Any]:
    if pending_handle:
        return await prepare_pending_review(
            token=token,
            connector_id=connector_id,
            conversation_id=conversation_id,
            tool_name=tool_name,
            pending_handle=pending_handle,
        )
    async with review_tool(
        token=token, connector_id=connector_id, conversation_id=conversation_id, tool_name=tool_name
    ) as (context, tool):
        approval = current_approval(context, tool, arguments)
        issued = await approval.issue(ActionDirectiveStore())
        return {
            "directiveId": issued.directive_id,
            "expiresAt": issued.expires_at.isoformat(),
            "connectorId": connector_id,
            "toolName": tool_name,
            "toolLabel": tool.descriptor["name"],
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
) -> dict[str, Any]:
    if pending_handle:
        pending = await prepare_pending_review(
            token=token,
            connector_id=connector_id,
            conversation_id=conversation_id,
            tool_name=tool_name,
            pending_handle=pending_handle,
        )
        if directive_id != pending["directiveId"] or arguments != pending["arguments"]:
            raise ActionDirectiveAuthorityError("Pending call changed. Review again.")
    ledger = ActionDirectiveStore()
    async with review_tool(
        token=token, connector_id=connector_id, conversation_id=conversation_id, tool_name=tool_name
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
    *, token, connector_id, conversation_id, tool_name, pending_handle
):
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
            "arguments": approval.arguments,
            "status": "review_required",
            "pendingHandle": pending_handle,
        }
