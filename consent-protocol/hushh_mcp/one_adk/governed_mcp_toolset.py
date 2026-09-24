"""Owner-bound native ADK MCP tools with application-owned admission.

Provider-specific dispatch does not belong here. The connection resolver and
approval callback are ports into the existing credential and confirmation
authorities, not alternative stores. Construct per owner/connection; never put
an authenticated instance on a shared static root agent.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from google.adk.telemetry.tracing import _should_report_mcp_http_exchanges
from google.adk.tools.mcp_tool.mcp_session_manager import (
    StreamableHTTPConnectionParams,
    _http_debug_var,
)
from google.adk.tools.mcp_tool.mcp_tool import _RESERVED_TOOL_NAMES, McpTool
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from jsonschema import Draft202012Validator
from mcp.types import CallToolResult, Tool

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.services.external_connector_credentials_service import (
    get_external_connector_credentials_service,
)
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.external_connector_registry_service import (
    get_external_connector_registry_service,
)
from hushh_mcp.services.external_mcp_client import (
    ExternalMcpError,
    _list_session_tools,
    _normalize_and_cap,
)
from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client, validate_mcp_endpoint


@dataclass(frozen=True)
class McpConnectionBinding:
    owner_id: str = field(repr=False)
    connector_id: str
    generation: int
    credential_version: int
    endpoint: str = field(repr=False)


@dataclass(frozen=True)
class ResolvedMcpConnection:
    binding: McpConnectionBinding
    headers: dict[str, str] = field(repr=False)


async def resolve_registered_connection(context: Any, connector_id: str) -> ResolvedMcpConnection:
    """Resolve an existing registry credential under current Chat owner authority.

    Google account grants owned by other services still require their existing
    credential adapters; this port never substitutes selected-file credentials
    for account-wide Workspace access. No credential is retained in tool state.
    """
    owner = context.user_id
    state = context.state
    if (
        not owner
        or owner != state.get("hussh:user_id")
        or state.get("temp:one_execution_surface") != "typed_chat"
        or not await validate_first_party_owner_token(
            owner, resolve_request_secret(state.get("hussh:consent_token"))
        )
    ):
        raise ExternalMcpError(
            "Connector owner authority is unavailable.", code="MCP_OWNER_MISMATCH"
        )
    connector = await get_external_connector_registry_service().get_connector(
        connector_id, user_id=owner
    )
    if connector is None or not connector.is_active or connector.transport_kind != "mcp":
        raise ExternalMcpError("Connector unavailable.", code="MCP_CONNECTION_CHANGED")
    row = await ExternalConnectorLifecycleStore().read(user_id=owner, connector_id=connector_id)
    if not row or row.get("status") != "connected" or not row.get("credential_ciphertext"):
        raise ExternalMcpError("Connect this service first.", code="MCP_CONNECTION_CHANGED")
    expiry = row.get("credential_expires_at")
    if expiry is not None and (
        not isinstance(expiry, datetime) or expiry.tzinfo is None or expiry <= datetime.now(UTC)
    ):
        raise ExternalMcpError("Reconnect this service.", code="MCP_CREDENTIAL_EXPIRED")
    binding = McpConnectionBinding(
        owner,
        connector_id,
        int(row["connection_generation"]),
        int(row["credential_version"]),
        connector.mcp_endpoint,
    )
    validate_mcp_endpoint(binding.endpoint)
    secret = get_external_connector_credentials_service().open_credential(
        user_id=owner, connector_id=connector_id, row=row
    )
    if connector.auth_style == "api_key":
        header = connector.api_key_header_name or "Authorization"
        if header.lower() not in {"authorization", "x-api-key", "api-key"}:
            raise ExternalMcpError("Unsupported credential header.", code="MCP_CREDENTIAL_INVALID")
        credential = secret.get("apiKey")
    elif connector.auth_style == "oauth":
        header = "Authorization"
        token = secret.get("accessToken")
        credential = f"Bearer {token}" if isinstance(token, str) and token else None
    else:
        raise ExternalMcpError("Unsupported credential type.", code="MCP_CREDENTIAL_INVALID")
    if (
        not isinstance(credential, str)
        or not credential.strip()
        or any(ord(c) < 32 or ord(c) == 127 for c in credential)
    ):
        raise ExternalMcpError("Reconnect this service.", code="MCP_CREDENTIAL_INVALID")
    return ResolvedMcpConnection(binding, {header: credential})


ResolveConnection = Callable[[Any], Awaitable[ResolvedMcpConnection]]
# None permits this exact call; a dict is a safe pending/blocked app response.
# The callback must consume existing app authority, never trust MCP annotations.
AuthorizeCall = Callable[
    [Any, McpConnectionBinding, str, str, dict[str, Any]], Awaitable[dict[str, Any] | None]
]


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


class GovernedMcpToolset(McpToolset):
    """Use ADK's native session/tool machinery without ambient owner authority.

    Catalogs are revision-bound for the lifetime of returned tools. Refresh is
    explicit; old tool objects stop working even when their discovery was in
    flight. This class deliberately does not enable sampling, elicitation, or
    provider UI resources. Their authority is not implied by tools/list.
    """

    def __init__(
        self,
        *,
        binding: McpConnectionBinding,
        resolve_connection: ResolveConnection,
        authorize_call: AuthorizeCall,
        timeout_seconds: float = 20,
    ) -> None:
        validate_mcp_endpoint(binding.endpoint)
        if not binding.owner_id or not binding.connector_id or binding.generation < 1:
            raise ValueError("Invalid MCP connection binding")
        if binding.credential_version < 1 or not 0 < timeout_seconds <= 60:
            raise ValueError("Invalid MCP execution limits")
        self.binding = binding
        self.resolve_connection = resolve_connection
        self.authorize_call = authorize_call
        self.timeout_seconds = timeout_seconds
        self.catalog_epoch = 0
        self._catalog_digest: str | None = None
        self._discovery_sequence = 0
        super().__init__(
            connection_params=StreamableHTTPConnectionParams(
                url=binding.endpoint,
                timeout=timeout_seconds,
                httpx_client_factory=create_public_mcp_http_client,
            ),
            header_provider=self._current_headers,
            tool_list_cache_ttl_seconds=None,
        )

    def refresh(self) -> None:
        self.catalog_epoch += 1

    async def _current_headers(self, context: Any) -> dict[str, str]:
        # The pinned SDK's HTTP diagnostics can capture custom credentials and
        # private response bodies independently of normal no-content telemetry.
        # Refuse this mode; do not mutate process-wide telemetry configuration.
        if _http_debug_var.get(None) is not None or _should_report_mcp_http_exchanges():
            raise ExternalMcpError(
                "Private connector diagnostics are disabled.", code="MCP_UNSAFE_TELEMETRY"
            )
        if context is None or context.user_id != self.binding.owner_id:
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        current = await self.resolve_connection(context)
        if current.binding != self.binding:
            raise ExternalMcpError("Connector connection changed.", code="MCP_CONNECTION_CHANGED")
        return dict(current.headers)

    async def get_tools(self, readonly_context=None):
        self._discovery_sequence += 1
        sequence = self._discovery_sequence
        epoch = self.catalog_epoch
        manager = self._mcp_session_manager
        try:
            async with asyncio.timeout(self.timeout_seconds):
                headers = await self._current_headers(readonly_context)
                session = await manager.create_session(headers=headers)
                manager._begin_session_use(headers)
                try:
                    catalog = await _list_session_tools(session)
                finally:
                    manager._end_session_use(headers)
                await self._current_headers(readonly_context)
        except ExternalMcpError:
            raise
        except Exception:
            raise ExternalMcpError(
                "Connector discovery failed.", code="MCP_DISCOVERY_FAILED"
            ) from None
        if epoch != self.catalog_epoch or sequence != self._discovery_sequence:
            raise ExternalMcpError("Connector tools changed.", code="MCP_CATALOG_CHANGED")
        revision = _digest(catalog)
        if self._catalog_digest is not None and self._catalog_digest != revision:
            self.refresh()
        self._catalog_digest = revision
        epoch = self.catalog_epoch
        return [
            _GovernedMcpTool(toolset=self, descriptor=item, revision=revision, epoch=epoch)
            for item in catalog
            if item["name"] not in _RESERVED_TOOL_NAMES
        ]


class _GovernedMcpTool(McpTool):
    def __init__(self, *, toolset, descriptor, revision, epoch):
        super().__init__(
            mcp_tool=Tool.model_validate(descriptor),
            mcp_session_manager=toolset._mcp_session_manager,
            header_provider=toolset._current_headers,
        )
        self.toolset = toolset
        self.descriptor = deepcopy(descriptor)
        self.revision = revision
        self.epoch = epoch
        # Opaque, stable ADK-safe names avoid collisions and provider name
        # interpolation. Native MCPTool retains the original wire tool name.
        self.name = "mcp_" + _digest([toolset.binding.connector_id, descriptor["name"]])[:40]

    async def _create_session(self, *, headers):
        # ADK's decorated implementation logs raw exception text before a
        # setup retry. Keep one attempt and let our sanitized boundary handle it.
        return await self._mcp_session_manager.create_session(headers=headers)

    async def run_async(self, *, args, tool_context):
        try:
            async with asyncio.timeout(self.toolset.timeout_seconds):
                return await self._run_governed(args=args, tool_context=tool_context)
        except TimeoutError:
            return {"error": "MCP_CALL_UNAVAILABLE", "outcome": "unknown", "retryable": False}

    async def _run_governed(self, *, args, tool_context):
        owner = self.toolset
        dispatched = False
        try:
            await owner.get_tools(tool_context)
            if self.epoch != owner.catalog_epoch:
                raise ExternalMcpError("Connector tools changed.", code="MCP_CATALOG_CHANGED")
            arguments = deepcopy(args)
            if len(json.dumps(arguments, allow_nan=False).encode()) > 32_000:
                return {"error": "MCP_ARGUMENTS_LIMIT"}
            # No coercion or dropped constraints; invalid calls never reach
            # approval or the provider. No remote schema retrieval is admitted.
            if not Draft202012Validator(self.descriptor["inputSchema"]).is_valid(arguments):
                return {"error": "MCP_ARGUMENTS_INVALID"}
            pending = await owner.authorize_call(
                tool_context,
                owner.binding,
                self.descriptor["name"],
                self.revision,
                deepcopy(arguments),
            )
            if pending is not None:
                return pending
            await owner.get_tools(tool_context)
            if self.epoch != owner.catalog_epoch:
                return {"error": "MCP_CATALOG_CHANGED"}
            # Call the native implementation exactly once. Bypass its optional
            # graceful-error wrapper, which can log raw provider exceptions.
            async with asyncio.timeout(owner.timeout_seconds):
                dispatched = True
                result = await super()._run_async_impl(
                    args=arguments, tool_context=tool_context, credential=None
                )
            await owner._current_headers(tool_context)
            if self.epoch != owner.catalog_epoch:
                return {"error": "MCP_CATALOG_CHANGED", "outcome": "unknown", "retryable": False}
            normalized = _normalize_and_cap(CallToolResult.model_validate(result))
            if normalized.is_error:
                return {"error": "MCP_PROVIDER_ERROR", "outcome": "unknown", "retryable": False}
            return {
                "isError": normalized.is_error,
                "result": normalized.payload,
                "truncated": normalized.truncated,
            }
        except ExternalMcpError as error:
            if dispatched:
                return {"error": error.code, "outcome": "unknown", "retryable": False}
            return {"error": error.code}
        except Exception:
            # A transport failure does not prove an external mutation failed.
            # No automatic retry, exception text, arguments or result logging.
            return {"error": "MCP_CALL_UNAVAILABLE", "outcome": "unknown", "retryable": False}
