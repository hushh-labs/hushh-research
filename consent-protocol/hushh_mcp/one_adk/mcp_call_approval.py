"""Bind native MCP calls to the existing app's one-use action ledger.

This module is not an authorization store or model-facing confirmation tool.
The authenticated Chat review endpoint owns confirmation; the native tool's
approval port consumes that receipt immediately before provider dispatch.
Only HMACs enter the ledger. Review arguments stay in request/browser memory.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.one_adk.governed_mcp_toolset import AuthorizeCall, McpConnectionBinding
from hushh_mcp.services.action_directive_ledger import (
    MCP_ACTION_ID,
    ActionConfirmationReceipt,
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    BoundActionTerms,
    IssuedActionDirective,
)


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
