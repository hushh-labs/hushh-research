"""Task-local MCP resources on the existing shared Chat runner.

The scope carries request-only configuration, not permission to execute tools.
Each acquisition resolves the current owner's connection; tool calls independently
revalidate owner authority and pass through application review. Vault projections
replace private DB definitions when supplied. The HTTP/review callers must admit
them outside persisted ADK state and discard their original request references.
No authenticated toolset is retained on the process-wide root agent.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from copy import deepcopy
from functools import partial
from typing import Any

from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.one_adk.governed_mcp_toolset import (
    AuthorizeCall,
    GovernedMcpToolset,
    McpConnectionBinding,
    ResolvedMcpConnection,
    mcp_tool_fingerprint,
    mcp_tool_name,
    resolve_registered_connection,
)
from hushh_mcp.one_adk.request_secrets import (
    consume_request_secret,
    resolve_request_secret,
    store_request_secret,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.mcp_public_http import validate_mcp_endpoint

logger = logging.getLogger(__name__)
# Most calls one request may send to connectors without exact-call review.
# A backstop: the external-read boundary already admits at most one unreviewed
# call per conversation. A code constant, never an environment flag.
UNREVIEWED_CALL_BUDGET = 6
_CURRENT: ContextVar[McpTurnResources | None] = ContextVar("one_mcp_turn_resources", default=None)
STATE_MCP_CONFIGURATION = "temp:hussh:mcp_configuration"


def admit_turn_configurations(forwarded: dict, *, owner_id: str, conversation_id: str) -> str:
    """Remove private input before the bridge can copy/serialize forwarded props."""
    if "mcpConfigurations" not in forwarded:
        return ""
    value = forwarded.pop("mcpConfigurations")
    if not owner_id:
        raise ExternalMcpError("Unlock your vault to use connectors.", code="MCP_OWNER_MISMATCH")
    records = validate_mcp_turn_configurations(value)
    return store_request_secret(
        json.dumps(
            {
                "owner": owner_id,
                "conversation": conversation_id,
                "configurations": list(records.values()),
            }
        ),
        ttl_seconds=60,
    )


def consume_turn_configurations(state: dict, *, owner_id: str, conversation_id: str):
    reference = state.pop(STATE_MCP_CONFIGURATION, "")
    if not reference:
        return None
    raw = consume_request_secret(reference)
    try:
        payload = json.loads(raw)
        if payload["owner"] != owner_id or payload["conversation"] != conversation_id:
            raise ValueError
        return list(validate_mcp_turn_configurations(payload["configurations"]).values())
    except (ValueError, TypeError, KeyError):
        raise ExternalMcpError(
            "Connector turn expired. Try again.", code="MCP_TURN_UNAVAILABLE"
        ) from None


def _vault_owner_token(secret: Any) -> bool:
    """A vault-owner token, under any auth scheme, never leaves for a server."""
    return (
        isinstance(secret, str) and re.match(r"^(?:\S+\s+)?HCT:", secret.strip(), re.I) is not None
    )


def validate_mcp_turn_configurations(value: Any) -> dict[str, dict[str, Any]]:
    """Validate a transient browser projection, never a stored authority record.

    Refresh tokens are deliberately not admitted. Endpoint DNS/rebinding checks
    remain in the governed HTTP transport; this performs syntax admission only.
    No validation diagnostic may include credentials or endpoint information.
    """
    try:
        if not isinstance(value, list) or len(value) > 32:
            raise ValueError
        if len(json.dumps(value, allow_nan=False).encode()) > 320_000:
            raise ValueError
        records = {}
        for raw in value:
            if not isinstance(raw, dict) or set(raw) not in (
                {
                    "version",
                    "connectorId",
                    "revision",
                    "displayName",
                    "endpoint",
                    "enabled",
                    "authentication",
                },
                {
                    "version",
                    "connectorId",
                    "revision",
                    "displayName",
                    "endpoint",
                    "enabled",
                    "authentication",
                    "blockedTools",
                },
            ):
                raise ValueError
            if (
                type(raw["version"]) is not int
                or raw["version"] != 1
                or type(raw["enabled"]) is not bool
            ):
                raise ValueError
            identifier = raw["connectorId"]
            if not isinstance(identifier, str) or not re.fullmatch(
                r"custom_[a-f0-9]{32}", identifier
            ):
                raise ValueError
            if identifier in records:
                raise ValueError
            revision = raw["revision"]
            if not isinstance(revision, str) or not re.fullmatch(
                r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", revision
            ):
                raise ValueError
            name = raw["displayName"]
            if (
                not isinstance(name, str)
                or not 1 <= len(name.strip()) <= 100
                or any(ord(c) < 32 or ord(c) == 127 for c in name)
            ):
                raise ValueError
            endpoint = raw["endpoint"]
            if not isinstance(endpoint, str) or len(endpoint) > 2048:
                raise ValueError
            validate_mcp_endpoint(endpoint)
            auth = raw["authentication"]
            if not isinstance(auth, dict):
                raise ValueError
            kind = auth.get("kind")
            if kind == "none" and set(auth) == {"kind"}:
                secret = None
            elif kind == "api_key" and set(auth) == {"kind", "header", "value"}:
                if auth["header"] not in {"Authorization", "X-API-Key", "Api-Key"}:
                    raise ValueError
                secret = auth["value"]
                if _vault_owner_token(secret):
                    raise ValueError
            elif kind == "oauth" and set(auth) == {"kind", "accessToken", "expiresAt"}:
                if type(auth["expiresAt"]) is not int or auth["expiresAt"] <= 0:
                    raise ValueError
                secret = auth["accessToken"]
                if _vault_owner_token(secret):
                    raise ValueError
            else:
                raise ValueError
            if kind != "none" and (
                not isinstance(secret, str)
                or not secret.strip()
                or len(secret) > 8192
                or any(ord(c) < 32 or ord(c) == 127 for c in secret)
            ):
                raise ValueError
            blocked_tools = raw.get("blockedTools", [])
            if not isinstance(blocked_tools, list) or len(blocked_tools) > 200:
                raise ValueError
            blocked_ids = set()
            for entry in blocked_tools:
                if not isinstance(entry, dict) or set(entry) != {"id", "fingerprint"}:
                    raise ValueError
                tool_id, fingerprint = entry["id"], entry["fingerprint"]
                if (
                    not isinstance(tool_id, str)
                    or not re.fullmatch(r"mcp_[a-f0-9]{40}", tool_id)
                    or tool_id in blocked_ids
                    or not isinstance(fingerprint, str)
                    or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
                ):
                    raise ValueError
                blocked_ids.add(tool_id)
            records[identifier] = deepcopy(raw)
        return records
    except Exception:
        raise ExternalMcpError(
            "Connector configuration unavailable.", code="MCP_CONFIGURATION_INVALID"
        ) from None


class McpTurnResources:
    def __init__(
        self, conversation_id: str, *, owner_id: str | None = None, configurations: Any = None
    ):
        self.conversation_id = conversation_id
        self._owner = owner_id
        self.has_vault_configurations = configurations is not None
        if configurations is not None and not owner_id:
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        self._configurations = (
            validate_mcp_turn_configurations(configurations) if configurations is not None else {}
        )
        self._closed = False
        self._unreviewed_calls = 0
        self._toolsets: dict[McpConnectionBinding, GovernedMcpToolset] = {}
        self._catalog_views: list[Any] = []

    def vault_catalog(self, owner_id: str) -> list[tuple[str, str]]:
        if self._closed or owner_id != self._owner:
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        return [
            (key, record["displayName"])
            for key, record in self._configurations.items()
            if record["enabled"]
        ]

    def setup_catalog(self, owner_id: str) -> list[dict[str, str]]:
        """Return only display metadata for the authenticated owner's setup UI."""
        if self._closed or owner_id != self._owner or not self.has_vault_configurations:
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        entries = []
        for record in self._configurations.values():
            auth = record["authentication"]
            if not record["enabled"]:
                status = "disabled"
            elif auth["kind"] == "oauth" and auth["expiresAt"] <= time.time():
                status = "reconnect_needed"
            else:
                status = "saved"
            entries.append(
                {"id": record["connectorId"], "name": record["displayName"], "status": status}
            )
        return sorted(entries, key=lambda entry: entry["name"].casefold())

    async def resolve_connection(self, context: Any, connector_id: str) -> ResolvedMcpConnection:
        if self._closed or context.state.get("hussh:conversation_id") != self.conversation_id:
            raise ExternalMcpError("Connector turn is unavailable.", code="MCP_TURN_UNAVAILABLE")
        if self._owner is not None and context.user_id != self._owner:
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        record = self._configurations.get(connector_id)
        if record is None:
            if self.has_vault_configurations:
                # An omitted/removed custom connector cannot be resurrected from
                # the superseded readable database registry during this turn.
                if connector_id.startswith("custom_"):
                    raise ExternalMcpError("Connector unavailable.", code="MCP_CONNECTION_CHANGED")
                return await resolve_registered_connection(context, connector_id, curated_only=True)
            return await resolve_registered_connection(context, connector_id)
        if (
            not self._owner
            or context.user_id != context.state.get("hussh:user_id")
            or context.state.get("temp:one_execution_surface") != "typed_chat"
            or not await validate_first_party_owner_token(
                context.user_id, resolve_request_secret(context.state.get("hussh:consent_token"))
            )
        ):
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        owner = self._owner
        if owner is None:
            # Vault configurations are admitted only for an owner-bound turn.
            raise ExternalMcpError("Connector owner mismatch.", code="MCP_OWNER_MISMATCH")
        if not record["enabled"]:
            raise ExternalMcpError("Connector unavailable.", code="MCP_CONNECTION_CHANGED")
        auth = record["authentication"]
        headers = {}
        if auth["kind"] == "oauth":
            if auth["expiresAt"] <= time.time():
                raise ExternalMcpError("Reconnect this service.", code="MCP_CREDENTIAL_EXPIRED")
            headers["Authorization"] = f"Bearer {auth['accessToken']}"
        elif auth["kind"] == "api_key":
            headers[auth["header"]] = auth["value"]
        # Full-record binding prevents reused client revisions from preserving an
        # old approval after an endpoint, credential, or configuration change.
        digest = hashlib.sha256(
            json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        blocked = {(item["id"], item["fingerprint"]) for item in record.get("blockedTools", [])}

        def admitted(catalog: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return [
                item
                for item in catalog
                if (mcp_tool_name(connector_id, item["name"]), mcp_tool_fingerprint(item))
                not in blocked
            ]

        return ResolvedMcpConnection(
            McpConnectionBinding(
                owner,
                connector_id,
                1,
                1,
                record["endpoint"],
                ("vault", record["revision"], digest),
            ),
            headers,
            catalog_policy=admitted,
            # Holding no person credential means no person authority is used.
            review_policy="credentialless" if auth["kind"] == "none" else "credentialed",
            forced_review_tool_ids=frozenset(item["id"] for item in record.get("blockedTools", [])),
        )

    def admit_unreviewed(self) -> bool:
        """Claim one unreviewed call from this turn's budget; False means review."""
        if self._closed or self._unreviewed_calls >= UNREVIEWED_CALL_BUDGET:
            return False
        self._unreviewed_calls += 1
        return True

    def track_catalog_view(self, view: Any) -> None:
        if self._closed:
            raise ExternalMcpError("Connector turn is unavailable.", code="MCP_TURN_UNAVAILABLE")
        if not any(item is view for item in self._catalog_views):
            self._catalog_views.append(view)

    async def acquire(
        self, context: Any, connector_id: str, *, authorize_call: AuthorizeCall
    ) -> GovernedMcpToolset:
        if self._closed or context.state.get("hussh:conversation_id") != self.conversation_id:
            raise ExternalMcpError("Connector turn is unavailable.", code="MCP_TURN_UNAVAILABLE")
        resolved = await self.resolve_connection(context, connector_id)
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
            resolve_connection=partial(self.resolve_connection, connector_id=connector_id),
            authorize_call=authorize_call,
            catalog_policy=resolved.catalog_policy,
            result_policy=resolved.result_policy,
            review_policy=resolved.review_policy,
            forced_review_tool_ids=resolved.forced_review_tool_ids,
            admit_unreviewed=self.admit_unreviewed,
        )
        self._toolsets[resolved.binding] = toolset
        return toolset

    async def close(self) -> None:
        self._closed = True
        self._configurations.clear()
        views, self._catalog_views = self._catalog_views, []
        for view in views:
            view.clear_invocation_catalog()
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
async def mcp_turn_scope(
    conversation_id: str, *, owner_id: str | None = None, configurations: Any = None
):
    scope = McpTurnResources(conversation_id, owner_id=owner_id, configurations=configurations)
    token = _CURRENT.set(scope)
    try:
        yield scope
    finally:
        try:
            await scope.close()
        finally:
            _CURRENT.reset(token)
