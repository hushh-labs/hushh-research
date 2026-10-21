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
    from hushh_mcp.services.pod_upgrade_admission import ADMISSION, pod_incarnation

    permit = await ADMISSION.acquire_turn(incarnation=pod_incarnation())
    try:
        with private_pending_call_scope(owner.mcp_pending):
            return await _prepare_private_review(owner, connector_id, body)
    finally:
        await permit.release()


async def _prepare_private_review(owner, connector_id, body, *, configuration_admissions=None):
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
        configuration_admissions=configuration_admissions,
        vault_only=True,
    ) as (context, tool):
        approval = current_approval(context, tool, pending["arguments"])
        from dataclasses import replace

        approval = replace(approval, call_id=pending["call_id"])
        current = owner.mcp_approval.terms(approval).model_copy(
            update={"serviceUid": recorded.serviceUid}
        )
        if (
            recorded.model_dump(exclude={"epoch"}) != current.model_dump(exclude={"epoch"})
            or recorded.epoch > current.epoch
        ):
            raise ActionDirectiveAuthorityError("Private connector terms changed.")
        original_directive = body.directiveId or review["directiveId"]
        if intent := pending.get("rebind"):
            target = PodMcpTerms.model_validate(intent["target"])
            if (
                intent["previous"] != review
                or target.epoch > current.epoch
                or target.model_dump(exclude={"epoch"}) != current.model_dump(exclude={"epoch"})
            ):
                raise ActionDirectiveAuthorityError("Private connector recovery changed.")
            replacement = await owner.mcp_approval.rebind(previous=review, target=target)
            pending = await owner.mcp_pending.replace_review(
                session, body.pendingHandle, expected=review, review=replacement
            )
            review, recorded = pending["review"], target
        if recorded.epoch < current.epoch:
            await owner.mcp_pending.begin_rebind(
                session, body.pendingHandle, expected=review, target=current.model_dump()
            )
            replacement = await owner.mcp_approval.rebind(previous=review, target=current)
            pending = await owner.mcp_pending.replace_review(
                session, body.pendingHandle, expected=review, review=replacement
            )
            review, recorded = pending["review"], current
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
            **(
                {"replacesDirectiveId": original_directive}
                if original_directive != review["directiveId"]
                else {}
            ),
        }
