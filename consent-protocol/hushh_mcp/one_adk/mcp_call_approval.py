"""Bind native MCP calls to the existing app's one-use action ledger.

This module is not an authorization store or model-facing confirmation tool.
The authenticated Chat review endpoint owns confirmation; the native tool's
approval port consumes that receipt immediately before provider dispatch.
Only HMACs enter the ledger. Review arguments stay in request/browser memory.
"""

from __future__ import annotations

import json
import re
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.one_adk.governed_mcp_toolset import (
    AuthorizeCall,
    McpConnectionBinding,
    mcp_tool_name,
)
from hushh_mcp.one_adk.mcp_pending_call import capture_pending_call
from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret
from hushh_mcp.services.action_directive_ledger import (
    MCP_ACTION_ID,
    ActionConfirmationReceipt,
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    BoundActionTerms,
    IssuedActionDirective,
)

STATE_MCP_APPROVAL = "temp:hussh:mcp_approval"


async def review_or_resume_call(context, binding, tool_name, revision, arguments):
    """Pause using native ADK, or consume app authority for its exact resume.

    The ADK confirmation boolean is never execution permission. Only a current
    authenticated receipt, checked against the existing ledger, admits dispatch.
    """
    confirmation = getattr(context, "tool_confirmation", None)
    if confirmation is not None:
        if confirmation.confirmed is not True:
            return {"status": "blocked", "error": "MCP_REVIEW_DECLINED", "retryable": False}
        return await consume_resume_receipt(context, binding, tool_name, revision, arguments)
    approval = McpCallApproval.from_call(context, binding, tool_name, revision, arguments)
    issued = await approval.issue(ActionDirectiveStore())
    public_name = mcp_tool_name(binding.connector_id, tool_name)
    pending = capture_pending_call(context, tool_name=public_name, arguments=arguments)
    context.request_confirmation(
        hint="Review this connector call before continuing.",
        payload={
            "kind": "mcp_call_review",
            "version": 1,
            "connectorId": binding.connector_id,
            "toolName": public_name,
            "directiveId": issued.directive_id,
            "pendingHandle": pending,
            "expiresAt": issued.expires_at.isoformat(),
        },
    )
    context.actions.skip_summarization = True
    return {"status": "review_required"}


def admit_resume_receipt(forwarded: dict, *, owner_id: str, conversation_id: str) -> str:
    """Remove the browser receipt from forwarded props before ADK sees them.

    Shape validation is not approval. The ledger remains the authority when
    the native tool attempts to consume the exact current call.
    """
    value = forwarded.pop("mcpApproval", None)
    if value is None:
        return ""
    if not owner_id or not conversation_id or not isinstance(value, dict):
        raise ActionDirectiveAuthorityError("Unlock before confirming a connector call.")
    patterns = {
        "directiveId": r"dir_[0-9a-f]{32}",
        "toolName": r"mcp_[0-9a-f]{40}",
        "connectorId": r"[A-Za-z0-9_-]{1,128}",
        "receipt": r"[A-Za-z0-9_-]{32,128}",
    }
    if set(value) not in (set(patterns), set(patterns) | {"pendingHandle"}) or any(
        not isinstance(value[key], str) or re.fullmatch(pattern, value[key]) is None
        for key, pattern in patterns.items()
    ):
        raise ActionDirectiveAuthorityError("Invalid connector confirmation.")
    if "pendingHandle" in value and (
        not isinstance(value["pendingHandle"], str)
        or re.fullmatch(r"one_secret_ref:[A-Za-z0-9_-]{32}", value["pendingHandle"]) is None
    ):
        raise ActionDirectiveAuthorityError("Invalid connector review reference.")
    return store_request_secret(json.dumps({**value, "owner": owner_id, "thread": conversation_id}))


async def consume_resume_receipt(context, binding, tool_name, revision, arguments):
    """Native tool approval port for a current authenticated browser resume."""
    reference = context.state.get(STATE_MCP_APPROVAL)
    if not isinstance(reference, str) or not reference.startswith("one_secret_ref:"):
        raise ActionDirectiveAuthorityError("Connector review is required.")
    try:
        value = json.loads(resolve_request_secret(reference))
    except (TypeError, ValueError):
        raise ActionDirectiveAuthorityError("Connector review expired.") from None
    if not isinstance(value, dict) or any(
        (
            value.get("owner") != context.user_id,
            value.get("owner") != binding.owner_id,
            value.get("thread") != context.state.get("hussh:conversation_id"),
            value.get("connectorId") != binding.connector_id,
            value.get("toolName") != mcp_tool_name(binding.connector_id, tool_name),
        )
    ):
        raise ActionDirectiveAuthorityError("Connector review changed.")
    authorize = receipt_authorizer(
        ActionDirectiveStore(), directive_id=value["directiveId"], receipt=value["receipt"]
    )
    return await authorize(context, binding, tool_name, revision, arguments)


@dataclass(frozen=True)
class McpCallApproval:
    """Current, server-resolved call terms; not a client-supplied capability.

    Construct after native tool discovery/schema validation and fresh owner
    connection resolution. On confirmation reconstruct from the current catalog
    and connection, never from the historical card's schema or binding.
    """

    owner_id: str = field(repr=False)
    conversation_id: str = field(repr=False)
    binding: McpConnectionBinding = field(repr=False)
    tool_name: str
    catalog_revision: str
    arguments: dict[str, Any] = field(repr=False)

    @classmethod
    def from_call(
        cls,
        context: Any,
        binding: McpConnectionBinding,
        tool_name: str,
        catalog_revision: str,
        arguments: dict[str, Any],
    ) -> McpCallApproval:
        state = context.state
        conversation = state.get("hussh:conversation_id")
        if (
            context.user_id != binding.owner_id
            or state.get("hussh:user_id") != binding.owner_id
            or state.get("temp:one_execution_surface") != "typed_chat"
            or not isinstance(conversation, str)
            or not conversation
            or not tool_name
            or not catalog_revision
        ):
            raise ActionDirectiveAuthorityError("MCP review owner or conversation changed.")
        return cls(
            binding.owner_id,
            conversation,
            binding,
            tool_name,
            catalog_revision,
            deepcopy(arguments),
        )

    @property
    def terms(self) -> BoundActionTerms:
        return BoundActionTerms(
            action_contract={
                "action_id": MCP_ACTION_ID,
                "execution_policy": "confirm_required",
                "activation_policy": "trusted_activation_required",
                "tool": self.tool_name,
                "catalog_revision": self.catalog_revision,
            },
            slots=deepcopy(self.arguments),
            resource_binding={
                "owner": self.owner_id,
                "connector": self.binding.connector_id,
                "endpoint": self.binding.endpoint,
                "connection_generation": self.binding.generation,
                "credential_version": self.binding.credential_version,
            },
        )

    @property
    def identity(self) -> dict[str, Any]:
        return {
            "user_id": self.owner_id,
            "session_id": self.conversation_id,
            "adk_app_name": "hussh_one",
            "action_id": MCP_ACTION_ID,
            "context_revision": f"mcp:{self.catalog_revision}",
        }

    async def issue(self, store: ActionDirectiveStore) -> IssuedActionDirective:
        terms = self.terms
        return await store.issue(
            **self.identity,
            channel="adk_chat",
            action_contract=terms.action_contract,
            slots=terms.slots,
            resource_binding=terms.resource_binding,
            trusted_activation_required=True,
        )

    async def confirm(
        self, store: ActionDirectiveStore, *, directive_id: str, confirmed: bool
    ) -> ActionConfirmationReceipt:
        # Only the authenticated app review route calls this. A model/tool
        # argument, MCP annotation or browser-local tool ID is not a gesture.
        if confirmed is not True:
            raise ActionDirectiveAuthorityError("Explicit MCP call approval is required.")
        return await store.confirm(
            **self.identity,
            directive_id=directive_id,
            trusted_activation=True,
            terms=self.terms,
        )

    async def consume(
        self, store: ActionDirectiveStore, *, directive_id: str, receipt: str
    ) -> None:
        await store.consume(
            **self.identity,
            directive_id=directive_id,
            receipt=receipt,
            terms=self.terms,
        )


def receipt_authorizer(
    store: ActionDirectiveStore, *, directive_id: str, receipt: str
) -> AuthorizeCall:
    """Request-local native tool callback, never attached to a shared root.

    Called by GovernedMcpTool only after current discovery/schema/owner checks.
    A changed tool, argument, grant or conversation fails at the ledger; there
    is no fallback to a new directive or automatic external-operation retry.
    """
    if store._connection is not None:
        raise ActionDirectiveAuthorityError("MCP dispatch requires committed approval consumption.")

    async def authorize(context, binding, tool_name, revision, arguments):
        current = McpCallApproval.from_call(context, binding, tool_name, revision, arguments)
        await current.consume(store, directive_id=directive_id, receipt=receipt)
        return None

    return authorize
