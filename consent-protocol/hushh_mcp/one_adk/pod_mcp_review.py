"""Preview an existing pod-native pending call without revealing it to the hub."""

from hushh_mcp.one_adk.mcp_pending_call import (
    pending_call_details,
    private_pending_call_scope,
    restore_pending_call,
)
from hushh_mcp.one_adk.mcp_review_service import current_approval, review_tool
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.pod_mcp_approval import PodMcpTerms


async def prepare_private_review(owner, connector_id, body):
    with private_pending_call_scope():
        return await _prepare_private_review(owner, connector_id, body)


async def _prepare_private_review(owner, connector_id, body):
    await owner.require_access()
    if not body.pendingHandle or body.arguments or body.connectorConfiguration is None:
        raise ActionDirectiveAuthorityError("Review the pending private connector call.")
    session = await owner.sessions.get_session(
        app_name="hussh_one", user_id=owner.owner, session_id=body.conversationId
    )
    if session is None:
        raise ActionDirectiveAuthorityError("Private conversation unavailable.")
    pending = await pending_call_details(session, body.pendingHandle)
    await restore_pending_call(session, body.pendingHandle)
    review = pending.get("review") or {}
    recorded = PodMcpTerms.model_validate(review.get("podReview"))
    if review.get("connectorId") != connector_id or pending["tool_name"] != body.toolName:
        raise ActionDirectiveAuthorityError("Pending private connector changed.")
    async with review_tool(
        token={"user_id": owner.owner, "token": owner.authority.local_token(owner.claims)},
        connector_id=connector_id,
        conversation_id=body.conversationId,
        tool_name=body.toolName,
        configuration=body.connectorConfiguration,
        sessions=owner.sessions,
        owner_admission=owner._mcp_owner_admission,
        vault_only=True,
    ) as (context, tool):
        approval = current_approval(context, tool, pending["arguments"])
        from dataclasses import replace

        approval = replace(approval, call_id=pending["call_id"])
        if recorded.model_copy(update={"serviceUid": None}) != owner.mcp_approval.terms(approval):
            raise ActionDirectiveAuthorityError("Private connector terms changed.")
        await owner.require_access()
        return {
            "status": "review_required",
            "directiveId": review["directiveId"],
            "expiresAt": review["expiresAt"],
            "pendingHandle": body.pendingHandle,
            "connectorId": connector_id,
            "toolName": body.toolName,
            "connectorLabel": context.state.get("temp:mcp_connector_label", "Connected app"),
            "toolLabel": tool.descriptor["name"],
            "arguments": approval.arguments,
            "podReview": recorded.model_dump(),
        }
