"""Task-local MCP resources on the existing shared Chat runner.

The scope carries no authentication authority. Each acquisition resolves the
current owner's registered connection; tool calls independently revalidate it.
No authenticated toolset is retained on the process-wide root agent.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from contextvars import ContextVar
from functools import partial
from typing import Any

from hushh_mcp.one_adk.governed_mcp_toolset import (
    AuthorizeCall,
    GovernedMcpToolset,
    McpConnectionBinding,
    resolve_registered_connection,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError

logger = logging.getLogger(__name__)
_CURRENT: ContextVar[McpTurnResources | None] = ContextVar("one_mcp_turn_resources", default=None)


class McpTurnResources:
    def __init__(self, conversation_id: str):
        self.conversation_id = conversation_id
        self._owner: str | None = None
        self._closed = False
        self._toolsets: dict[McpConnectionBinding, GovernedMcpToolset] = {}

    async def acquire(
        self, context: Any, connector_id: str, *, authorize_call: AuthorizeCall
    ) -> GovernedMcpToolset:
        if self._closed or context.state.get("hussh:conversation_id") != self.conversation_id:
            raise ExternalMcpError("Connector turn is unavailable.", code="MCP_TURN_UNAVAILABLE")
        resolved = await resolve_registered_connection(context, connector_id)
        if self._closed or (self._owner is not None and self._owner != resolved.binding.owner_id):
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        self._owner = resolved.binding.owner_id
        existing = self._toolsets.get(resolved.binding)
        if existing is not None:
            # A second caller cannot substitute a less restrictive approval port.
            if existing.authorize_call is not authorize_call:
                raise ExternalMcpError("Connector authority changed.", code="MCP_AUTHORITY_CHANGED")
            return existing
        if len(self._toolsets) >= 32:
            raise ExternalMcpError("Connector turn limit reached.", code="MCP_TURN_LIMIT")
        toolset = GovernedMcpToolset(
            binding=resolved.binding,
            resolve_connection=partial(resolve_registered_connection, connector_id=connector_id),
            authorize_call=authorize_call,
        )
        self._toolsets[resolved.binding] = toolset
        return toolset

    async def close(self) -> None:
        self._closed = True
        toolsets, self._toolsets = list(self._toolsets.values()), {}
        if not toolsets:
            return
        try:
            async with asyncio.timeout(5):
                outcomes = await asyncio.gather(
                    *(item.close() for item in toolsets), return_exceptions=True
                )
            if any(isinstance(item, BaseException) for item in outcomes):
                logger.warning("mcp_turn_cleanup_incomplete")
        except TimeoutError:
            logger.warning("mcp_turn_cleanup_timeout")


def current_mcp_turn() -> McpTurnResources:
    scope = _CURRENT.get()
    if scope is None or scope._closed:
        raise ExternalMcpError("Connector turn is unavailable.", code="MCP_TURN_UNAVAILABLE")
    return scope


@asynccontextmanager
async def mcp_turn_scope(conversation_id: str):
    scope = McpTurnResources(conversation_id)
    token = _CURRENT.set(scope)
    try:
        yield scope
    finally:
        try:
            await scope.close()
        finally:
            _CURRENT.reset(token)
