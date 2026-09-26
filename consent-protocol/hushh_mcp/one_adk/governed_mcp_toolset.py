"""Owner-bound native ADK MCP tools with application-owned admission.

Provider-specific dispatch does not belong here. The connection resolver and
approval callback are ports into the existing credential and confirmation
authorities, not alternative stores. Construct per owner/connection; never put
an authenticated instance on a shared static root agent.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, cast, get_args

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
from hushh_mcp.consent.audit_logger import get_audit_logger
from hushh_mcp.one_adk.external_read_boundary import mcp_call_may_skip_review
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.external_connector_credentials_service import (
    get_external_connector_credentials_service,
)
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.external_connector_registry_service import (
    get_external_connector_registry_service,
)
from hushh_mcp.services.external_mcp_client import (
    ExternalMcpAuthError,
    ExternalMcpError,
    _http_status_from_error,
    _list_session_tools,
    _normalize_and_cap,
)
from hushh_mcp.services.mcp_public_http import create_bounded_mcp_http_client, validate_mcp_endpoint


@dataclass(frozen=True)
class McpConnectionBinding:
    owner_id: str = field(repr=False)
    connector_id: str
    generation: int
    credential_version: int
    endpoint: str = field(repr=False)
    # Optional full observation from an existing provider credential owner.
    # Separate account/service-grant revisions must not be collapsed to an int.
    authority_revision: tuple[str, ...] = field(default=(), repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.authority_revision, tuple) or any(
            not isinstance(part, str) or not part.strip() for part in self.authority_revision
        ):
            raise ValueError("Invalid MCP authority revision")


# Founder decision 2026-09-25, "reads free, writes reviewed":
#   always         every call needs exact-call review (registered/curated rows).
#   credentialed   the person gave this connector a credential. Only a tool the
#                  server itself annotates readOnlyHint=true runs unreviewed.
#   credentialless no person credential is held, so no person authority is
#                  exercised; calls run unreviewed.
# A hint is the server's own claim, so it relaxes review only where the person
# chose to trust that server with a credential. Unknown policy fails closed.
McpReviewPolicy = Literal["always", "credentialed", "credentialless"]
MCP_REVIEW_POLICIES: frozenset[str] = frozenset(get_args(McpReviewPolicy))
# Why a call ran, for the owner's Activity. "no_credential" is deliberately not
# "read_only": an unannotated tool on a public server may still change things.
McpReviewOutcome = Literal["required", "read_only", "no_credential"]


def _annotated_read_only(descriptor: object) -> bool:
    if not isinstance(descriptor, dict):
        return False
    hints = descriptor.get("annotations")
    return (
        isinstance(hints, dict)
        and hints.get("readOnlyHint") is True
        # Contradictory hints are malformed, not read-only.
        and hints.get("destructiveHint") is not True
    )


def mcp_call_requires_review(policy: object, descriptor: object) -> bool:
    """Fail closed: anything but an exact, known relaxation needs review."""
    if policy == "credentialless":
        return False
    return policy != "credentialed" or not _annotated_read_only(descriptor)


def mcp_review_outcome(
    policy: object, descriptor: object, *, forced: bool = False
) -> McpReviewOutcome:
    """`forced` is an owner rule (e.g. a block whose tool contract changed)."""
    if forced or mcp_call_requires_review(policy, descriptor):
        return "required"
    return "read_only" if _annotated_read_only(descriptor) else "no_credential"


@dataclass(frozen=True)
class ResolvedMcpConnection:
    binding: McpConnectionBinding
    headers: dict[str, str] = field(repr=False)
    catalog_policy: CatalogPolicy | None = field(default=None, repr=False, compare=False)
    result_policy: ResultPolicy | None = field(default=None, repr=False, compare=False)
    review_policy: McpReviewPolicy = field(default="always", compare=False)
    # Opaque ids of tools the owner once blocked. If the provider changes such a
    # tool's contract the block no longer matches it; it then always needs
    # review, so editing a description can never turn a block into execution.
    forced_review_tool_ids: frozenset[str] = field(default=frozenset(), repr=False, compare=False)


# Founder decision 2026-09-25: this project is not enrolled in Google's hosted
# Workspace MCP developer preview. Curated Google connectors run over the GA
# REST APIs in the Workspace adapter, so no curated row is dialed as hosted MCP.
HOSTED_WORKSPACE_MCP_ENROLLED = False


def native_registration_admitted(connector: Any, owner: str) -> bool:
    """Registration admission only; credentials and capabilities are checked later.

    Curated Google rows are admitted to the MCP transport only while hosted
    Workspace MCP is enrolled; a REST-transport row is never dialed as MCP.
    """
    if connector is None or not connector.is_active:
        return False
    if connector.owner_user_id == owner:
        return bool(connector.transport_kind == "mcp")
    return bool(
        connector.owner_user_id is None
        and HOSTED_WORKSPACE_MCP_ENROLLED
        and connector.transport_kind == "mcp"
        and connector.connector_id in {"google_drive", "google_gmail", "google_calendar"}
    )


async def resolve_registered_connection(
    context: Any, connector_id: str, *, curated_only: bool = False
) -> ResolvedMcpConnection:
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
        connector_id, user_id=None if curated_only else owner
    )
    if not native_registration_admitted(connector, owner) or (
        curated_only and connector.owner_user_id is not None
    ):
        raise ExternalMcpError("Connector unavailable.", code="MCP_CONNECTION_CHANGED")
    if connector.owner_user_id is None:
        # Narrow provider authentication/policy adapter, never another tool
        # dispatcher. All discovery, review and invocation remain native ADK.
        from hushh_mcp.one_adk.workspace_mcp_tools import (
            resolve_native_drive_connection,
            resolve_native_workspace_connection,
        )

        if connector_id == "google_drive":
            return cast(ResolvedMcpConnection, await resolve_native_drive_connection(context))
        if connector_id == "google_gmail":
            resolved = await resolve_native_workspace_connection(context, "gmail")
        elif connector_id == "google_calendar":
            resolved = await resolve_native_workspace_connection(context, "calendar")
        else:
            raise ExternalMcpError("Connector unavailable.", code="MCP_CONNECTION_CHANGED")
        if connector.auth_style != "oauth" or connector.mcp_endpoint != resolved.binding.endpoint:
            raise ExternalMcpError("Connector policy changed.", code="MCP_CONNECTION_CHANGED")
        return cast(ResolvedMcpConnection, resolved)
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
# Claims one unit of the owning turn's unreviewed-call budget; False means review.
AdmitUnreviewed = Callable[[], bool]
_unreviewed_audit = get_audit_logger("hushh_mcp.audit.mcp_unreviewed_call")


def _audit_unreviewed_call(
    context: Any, binding: McpConnectionBinding, tool_id: str, outcome: str
) -> None:
    """Metadata-only record of an outbound call no person reviewed.

    The action ledger cannot hold it: its adk_chat rows require confirmation.
    This is a structured log line, not a durable or tamper-evident store.
    Never arguments, results, provider tool names or credentials. `tool_id` is
    already an opaque digest of the connector and provider tool name.
    """
    state = getattr(context, "state", None) or {}
    _unreviewed_audit.info(
        "mcp.unreviewed_call",
        extra={
            "connector_id": binding.connector_id,
            "tool_id": tool_id,
            "review_outcome": outcome,
            "invocation_id": str(getattr(context, "invocation_id", "") or ""),
            "session_id": str(state.get("hussh:conversation_id") or ""),
            # Keyed, so a list of user ids cannot reverse or link it offline.
            "owner_ref": hmac.new(
                get_core_security_settings().app_signing_key.encode(),
                b"mcp-audit-owner:" + binding.owner_id.encode(),
                hashlib.sha256,
            ).hexdigest()[:16],
        },
    )


# None permits this exact call; a dict is a safe pending/blocked app response.
# The callback must consume existing app authority, never trust MCP annotations;
# only mcp_call_requires_review decides whether the callback runs at all.
AuthorizeCall = Callable[
    [Any, McpConnectionBinding, str, str, dict[str, Any]], Awaitable[dict[str, Any] | None]
]
CatalogPolicy = Callable[[list[dict[str, Any]]], list[dict[str, Any]]]
ResultPolicy = Callable[[str, dict[str, Any]], dict[str, Any]]


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def validated_mcp_arguments(schema: dict, args: Any) -> dict[str, Any]:
    """One argument contract for model calls and the authenticated review UI."""
    arguments = deepcopy(args)
    try:
        if len(json.dumps(arguments, allow_nan=False).encode()) > 32_000:
            raise ExternalMcpError(
                "Call is too large to review.", code="MCP_ARGUMENTS_LIMIT", status_code=413
            )
    except (TypeError, ValueError):
        raise ExternalMcpError(
            "Invalid call arguments.", code="MCP_ARGUMENTS_INVALID", status_code=422
        ) from None
    if not isinstance(arguments, dict) or not Draft202012Validator(schema).is_valid(arguments):
        raise ExternalMcpError(
            "Invalid call arguments.", code="MCP_ARGUMENTS_INVALID", status_code=422
        )
    return cast(dict[str, Any], arguments)


def mcp_tool_name(connector_id: str, wire_name: str) -> str:
    return "mcp_" + _digest([connector_id, wire_name])[:40]


def mcp_tool_fingerprint(descriptor: dict[str, Any]) -> str:
    """Bind owner preferences to one exact discovered tool contract.

    Review hints are excluded: a server flipping readOnlyHint must neither lift
    an owner's block nor silently re-key saved preferences. The catalog
    revision still includes hints, so a flip invalidates discovered tools.
    """
    return _digest({key: value for key, value in descriptor.items() if key != "annotations"})


def _credential_values(headers: dict[str, str]) -> list[str]:
    values = []
    for value in headers.values():
        values.append(value)
        scheme, _, credential = value.partition(" ")
        if credential and scheme.isalpha():
            values.append(credential.strip())
    # Very short values would redact ordinary words; credentials are longer.
    return sorted({value for value in values if len(value) >= 8}, key=len, reverse=True)


def _redact_credentials(value: Any, secrets: list[str]) -> Any:
    """Best effort against a server echoing the credential it received verbatim.

    It cannot stop a hostile server (encoded, split or re-cased echoes, or
    values under 8 characters); that server already holds the credential.
    """
    if not secrets:
        return value
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, list):
        return [_redact_credentials(item, secrets) for item in value]
    if isinstance(value, dict):
        return {
            _redact_credentials(key, secrets): _redact_credentials(item, secrets)
            for key, item in value.items()
        }
    return value


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
        catalog_policy: CatalogPolicy | None = None,
        result_policy: ResultPolicy | None = None,
        review_policy: McpReviewPolicy = "always",
        forced_review_tool_ids: frozenset[str] = frozenset(),
        admit_unreviewed: AdmitUnreviewed | None = None,
    ) -> None:
        validate_mcp_endpoint(binding.endpoint)
        if not binding.owner_id or not binding.connector_id or binding.generation < 1:
            raise ValueError("Invalid MCP connection binding")
        if binding.credential_version < 1 or not 0 < timeout_seconds <= 60:
            raise ValueError("Invalid MCP execution limits")
        if review_policy not in MCP_REVIEW_POLICIES:
            raise ValueError("Invalid MCP review policy")
        if not isinstance(forced_review_tool_ids, frozenset) or not all(
            isinstance(item, str) for item in forced_review_tool_ids
        ):
            raise ValueError("Invalid MCP review policy")
        self.binding = binding
        self.resolve_connection = resolve_connection
        self.authorize_call = authorize_call
        self.timeout_seconds = timeout_seconds
        # Application-owned provider restrictions, not model/server callbacks.
        # Custom connectors retain generic discovery; curated integrations can
        # narrow capabilities/results without a second MCP dispatcher.
        self.catalog_policy = catalog_policy
        self.result_policy = result_policy
        self.review_policy: McpReviewPolicy = review_policy
        self.forced_review_tool_ids = forced_review_tool_ids
        # No budget owner (no turn scope) means no unreviewed call at all.
        self.admit_unreviewed = admit_unreviewed
        self.catalog_epoch = 0
        self._catalog_digest: str | None = None
        self._discovery_sequence = 0
        super().__init__(
            connection_params=StreamableHTTPConnectionParams(
                url=binding.endpoint,
                timeout=timeout_seconds,
                httpx_client_factory=create_bounded_mcp_http_client,
            ),
            header_provider=self._current_headers,
            tool_list_cache_ttl_seconds=None,
        )

    def refresh(self) -> None:
        self.catalog_epoch += 1

    def review_outcome(self, tool_id: str, descriptor: object) -> McpReviewOutcome:
        return mcp_review_outcome(
            self.review_policy, descriptor, forced=tool_id in self.forced_review_tool_ids
        )

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
        if (
            current.binding != self.binding
            or current.review_policy != self.review_policy
            or current.forced_review_tool_ids != self.forced_review_tool_ids
        ):
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
                    catalog = await _list_session_tools(session, include_review_hints=True)
                    discovered = {item["name"]: deepcopy(item) for item in catalog}
                    if self.catalog_policy is not None:
                        catalog = self.catalog_policy(deepcopy(catalog))
                        for item in catalog:
                            original = discovered.get(item["name"])
                            if original is None:
                                raise ExternalMcpError(
                                    "Invalid connector policy.", code="MCP_CATALOG_CHANGED"
                                )
                            # Review hints are only ever the provider's own.
                            item.pop("annotations", None)
                            if "annotations" in original:
                                item["annotations"] = deepcopy(original["annotations"])
                finally:
                    manager._end_session_use(headers)
                await self._current_headers(readonly_context)
        except ExternalMcpError:
            raise
        except Exception as error:
            # Same classification as the shared client: a refused credential or
            # a server that needs sign-in is not an unreachable server. Only
            # the status code is read; no provider text or header is kept.
            if _http_status_from_error(error) in {401, 403}:
                raise ExternalMcpAuthError() from None
            raise ExternalMcpError(
                "Connector discovery failed.", code="MCP_DISCOVERY_FAILED"
            ) from None
        revision = _digest({"admitted": catalog, "provider": discovered})
        if epoch != self.catalog_epoch or (
            sequence != self._discovery_sequence and revision != self._catalog_digest
        ):
            # An older discovery may finish after a newer one. It is still
            # usable when both observed the exact same provider and admitted
            # catalog; only a changed revision or explicit refresh is stale.
            raise ExternalMcpError("Connector tools changed.", code="MCP_CATALOG_CHANGED")
        if self._catalog_digest is not None and self._catalog_digest != revision:
            self.refresh()
        self._catalog_digest = revision
        epoch = self.catalog_epoch
        return [
            _GovernedMcpTool(
                toolset=self,
                descriptor=item,
                revision=revision,
                epoch=epoch,
                provider_schema=discovered[item["name"]]["inputSchema"],
            )
            for item in catalog
            if item["name"] not in _RESERVED_TOOL_NAMES
        ]


class _GovernedMcpTool(McpTool):
    def __init__(self, *, toolset, descriptor, revision, epoch, provider_schema=None):
        super().__init__(
            mcp_tool=Tool.model_validate(descriptor),
            mcp_session_manager=toolset._mcp_session_manager,
            header_provider=toolset._current_headers,
        )
        self.toolset = toolset
        self.descriptor = deepcopy(descriptor)
        self.revision = revision
        self.epoch = epoch
        self.provider_schema = deepcopy(
            provider_schema if provider_schema is not None else descriptor["inputSchema"]
        )
        # Opaque, stable ADK-safe names avoid collisions and provider name
        # interpolation. Native MCPTool retains the original wire tool name.
        self.name = mcp_tool_name(toolset.binding.connector_id, descriptor["name"])

    async def _create_session(self, *, headers):
        # ADK's decorated implementation logs raw exception text before a
        # setup retry. Keep one attempt and let our sanitized boundary handle it.
        return await self._mcp_session_manager.create_session(headers=headers)

    async def run_async(self, *, args, tool_context):
        try:
            async with asyncio.timeout(self.toolset.timeout_seconds):
                result = await self._run_governed(args=args, tool_context=tool_context)
        except TimeoutError:
            result = {"error": "MCP_CALL_UNAVAILABLE", "outcome": "unknown", "retryable": False}
        # The opaque connector id lets the owner's app label this step with the
        # name the owner chose. It is not a credential and grants nothing.
        return {**result, "connectorId": self.toolset.binding.connector_id}

    async def _run_governed(self, *, args, tool_context):
        # A denial needs neither private argument recovery nor provider access.
        # Durable native events intentionally contain empty private arguments.
        confirmation = getattr(tool_context, "tool_confirmation", None)
        if confirmation is not None and confirmation.confirmed is False:
            return {"status": "blocked", "error": "MCP_REVIEW_DECLINED", "retryable": False}
        owner = self.toolset
        dispatched = False
        try:
            await owner.get_tools(tool_context)
            if self.epoch != owner.catalog_epoch:
                raise ExternalMcpError("Connector tools changed.", code="MCP_CATALOG_CHANGED")
            # No coercion or dropped constraints; invalid calls never reach
            # approval or the provider. No remote schema retrieval is admitted.
            arguments = validated_mcp_arguments(self.descriptor["inputSchema"], args)
            # Validate independently at each schema's own root so local $refs
            # retain their meaning. A narrowed advertised schema cannot erase
            # an original provider constraint or silently rewrite arguments.
            validated_mcp_arguments(self.provider_schema, arguments)
            # Decided on the admitted descriptor of the current catalog revision;
            # a hint change re-keys the catalog and fails the epoch check below.
            # An unreviewed call never touches the action directive ledger.
            outcome = owner.review_outcome(self.name, self.descriptor)
            if outcome != "required" and not (
                # Before any external content in this turn, and within budget.
                mcp_call_may_skip_review(tool_context)
                and owner.admit_unreviewed is not None
                and owner.admit_unreviewed()
            ):
                outcome = "required"
            reviewed = outcome == "required"
            if reviewed:
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
            if not reviewed:
                # Recorded before dispatch; if it cannot be written, nothing is sent.
                _audit_unreviewed_call(tool_context, owner.binding, self.name, outcome)
            async with asyncio.timeout(owner.timeout_seconds):
                dispatched = True
                result = await super()._run_async_impl(
                    args=arguments, tool_context=tool_context, credential=None
                )
            headers = await owner._current_headers(tool_context)
            if self.epoch != owner.catalog_epoch:
                return {"error": "MCP_CATALOG_CHANGED", "outcome": "unknown", "retryable": False}
            secrets = _credential_values(headers)

            def projection(payload: dict[str, Any]) -> dict[str, Any]:
                if owner.result_policy is not None:
                    payload = owner.result_policy(self.descriptor["name"], payload)
                # Before serialization and capping, so a cut cannot split a secret.
                return cast(dict[str, Any], _redact_credentials(payload, secrets))

            normalized = _normalize_and_cap(
                CallToolResult.model_validate(result), project=projection
            )
            if normalized.is_error:
                return {"error": "MCP_PROVIDER_ERROR", "outcome": "unknown", "retryable": False}
            return {
                "status": "ok",
                "isError": normalized.is_error,
                "result": normalized.payload,
                "truncated": normalized.truncated,
                "review": "approved" if reviewed else outcome,
            }
        except ActionDirectiveAuthorityError:
            return {"status": "blocked", "error": "MCP_APPROVAL_INVALID", "retryable": False}
        except ExternalMcpError as error:
            if dispatched:
                return {"error": error.code, "outcome": "unknown", "retryable": False}
            return {"error": error.code}
        except Exception:
            # A transport failure does not prove an external mutation failed.
            # No automatic retry, exception text, arguments or result logging.
            return {"error": "MCP_CALL_UNAVAILABLE", "outcome": "unknown", "retryable": False}
