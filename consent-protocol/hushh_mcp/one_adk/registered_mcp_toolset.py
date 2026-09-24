"""One native ADK registry view, with authenticated resources owned by the turn.

This view contains no credential resolver or second connector catalog. Admitted
curated providers use their existing credential authorities through the shared
resolver; providers without native admission retain their existing adapters.
"""

import asyncio
import json

from google.adk.tools.base_toolset import BaseToolset

from hushh_mcp.one_adk.governed_mcp_toolset import native_registration_admitted
from hushh_mcp.one_adk.mcp_call_approval import review_or_resume_call
from hushh_mcp.one_adk.mcp_turn_scope import current_mcp_turn
from hushh_mcp.services.external_connector_registry_service import (
    get_external_connector_registry_service,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError


class RegisteredMcpToolset(BaseToolset):
    """Context-free root registration; owner-scoped tools resolved on each turn."""

    def __init__(self):
        super().__init__()
        # Installed ADK caches only by invocation ID, not owner/generation.
        # Our task-local scope owns reuse and each call revalidates credentials.
        self._use_invocation_cache = False

    def clear_invocation_catalog(self):
        # ADK still assigns this field even when lookup caching is disabled.
        # Drop closed tool/session references at the owning turn's teardown.
        self._cached_prefixed_tools = None
        self._cached_invocation_id = None

    async def close(self):
        self.clear_invocation_catalog()

    async def get_tools(self, readonly_context=None):
        try:
            return await self._discover(readonly_context)
        except ExternalMcpError:
            raise
        except Exception:
            # ADK may log toolset discovery exceptions. No SQL, provider body,
            # endpoint or credential diagnostic may escape this boundary.
            raise ExternalMcpError(
                "Connector discovery unavailable.", code="MCP_CATALOG_UNAVAILABLE"
            ) from None

    async def _discover(self, readonly_context):
        context = readonly_context
        if (
            context is None
            or not context.user_id
            or context.user_id != context.state.get("hussh:user_id")
            or context.state.get("temp:one_execution_surface") != "typed_chat"
        ):
            return []
        scope = current_mcp_turn()
        if context.state.get("hussh:conversation_id") != scope.conversation_id:
            raise ExternalMcpError("Connector turn changed.", code="MCP_TURN_UNAVAILABLE")
        scope.track_catalog_view(self)
        async with asyncio.timeout(20):
            definitions = await get_external_connector_registry_service().list_active_connectors(
                user_id=context.user_id
            )
            admitted = [
                item for item in definitions if native_registration_admitted(item, context.user_id)
            ]
            if len(admitted) > 32:
                raise ExternalMcpError("Connector limit reached.", code="MCP_TURN_LIMIT")
            semaphore = asyncio.Semaphore(4)

            async def discover(definition):
                async with semaphore:
                    try:
                        toolset = await scope.acquire(
                            context, definition.connector_id, authorize_call=review_or_resume_call
                        )
                        tools = await toolset.get_tools(context)
                        for tool in tools:
                            tool.description = (
                                f"Connected app: {json.dumps(definition.display_name)}. "
                                f"{tool.description or ''}"
                            )
                        return tools
                    except ExternalMcpError:
                        # A disconnected/revoked provider must not disable other
                        # connectors. Settings remains the owning status surface.
                        return []

            async with asyncio.TaskGroup() as group:
                tasks = [group.create_task(discover(item)) for item in admitted]
        tools = [tool for task in tasks for tool in task.result()]
        if len(tools) > 500 or len({tool.name for tool in tools}) != len(tools):
            raise ExternalMcpError("Connector catalog limit reached.", code="MCP_CATALOG_CHANGED")
        return tools
