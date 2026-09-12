"""Owner-bound consumer memory operations.

The MCP gateway is an authority and transport boundary, not a vault.  This
module deliberately keeps the execution port separate from the connection
ledger: the ledger proves the owner/client grant, while an owner-pod transport
performs the canonical PKM operation.  A missing transport fails closed rather
than reading hub storage, holding a vault key, or falling back to shared
intelligence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from hushh_mcp.services.consumer_mcp_connections import (
    ConsumerConnectionDenied,
    ConsumerMcpConnections,
)
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal


class ConsumerMemoryConflict(RuntimeError):
    """The canonical PKM revision changed before a mutation committed."""


MAX_MEMORY_QUERY_CHARS = 512
MAX_MEMORY_CONTENT_CHARS = 4_000
MAX_MEMORY_RESULTS = 20
MEMORY_OPERATIONS = frozenset({"read", "query", "save", "correct", "export", "delete"})


class ConsumerMemoryUnavailable(RuntimeError):
    """The owner-pod memory transport is unavailable; no fallback is permitted."""


class ConsumerMemoryInvalid(ValueError):
    """The external client supplied an invalid or unsupported memory request."""


class ConsumerMemoryTransport(Protocol):
    """The narrow owner-pod execution port.

    ``grant_receipt`` is a ledger reference; ``grant_token`` is a short-lived
    bearer credential issued by that standing grant. Implementations must pass
    only verified owner/client binding and use the existing pod relay or direct
    pod route; they must not persist request bodies in the gateway.
    """

    async def execute(
        self,
        *,
        operation: str,
        owner_id: str,
        deployment_id: str,
        connection_id: str,
        generation: int,
        grant_receipt: str,
        grant_token: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]: ...


class UnavailableConsumerMemoryTransport:
    """Safe default until a verified owner-pod adapter is installed."""

    async def execute(self, **_: Any) -> dict[str, Any]:
        raise ConsumerMemoryUnavailable("owner pod memory transport unavailable")


class OwnerPodConsumerMemoryTransport:
    """Forward typed memory operations through the existing owner-pod relay.

    The gateway never opens a second storage path or keeps a vault key. It resolves
    the owner-bound registry row, verifies that its recorded HusshID is the same
    deployment admitted by the connection ledger, and reuses the existing relay
    identity token plus the short-lived consumer grant token.
    """

    def __init__(self, *, registry: Any = None, proxy_post: Any = None) -> None:
        if registry is None:
            from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
                PersonalAgentRegistryRepo,
            )

            registry = PersonalAgentRegistryRepo()
        if proxy_post is None:
            from api.routes.one.pod_relay import (  # noqa: PLC0415
                _pod_url,
                _proxy_post,
            )

            proxy_post = _proxy_post
            self._pod_url = _pod_url
        else:
            self._pod_url = lambda row: (
                str((row.get("backend_metadata") or {}).get("url") or "").strip().rstrip("/")
            )
        self._registry = registry
        self._proxy_post = proxy_post

    async def execute(
        self,
        *,
        operation: str,
        owner_id: str,
        deployment_id: str,
        connection_id: str,
        generation: int,
        grant_receipt: str,
        grant_token: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        row = await self._registry.get(owner_id)
        if not isinstance(row, dict) or str(row.get("user_id") or "") != owner_id:
            raise ConsumerMemoryUnavailable("owner pod is not registered")
        if str(row.get("hushh_id") or "") != deployment_id:
            raise ConsumerMemoryUnavailable("owner pod binding changed")
        url = self._pod_url(row)
        if not url or not url.startswith("https://"):
            raise ConsumerMemoryUnavailable("owner pod endpoint is unavailable")
        if not grant_token:
            raise ConsumerMemoryUnavailable("owner pod memory grant is unavailable")
        status, body = await self._proxy_post(
            url,
            "/api/one/pod/consumer/memory",
            body={
                "ownerId": owner_id,
                "connectionId": connection_id,
                "generation": generation,
                "operation": operation,
                "arguments": arguments,
            },
            consent_token=grant_token,
        )
        if status == 409:
            raise ConsumerMemoryConflict("personal memory changed; retry with the current revision")
        if status >= 400 or not isinstance(body, dict):
            raise ConsumerMemoryUnavailable("owner pod memory is unavailable")
        if body.get("execution_target") != "owner_pod":
            raise ConsumerMemoryUnavailable("owner pod returned an invalid execution target")
        return body


@dataclass(frozen=True)
class ConsumerMemoryRequest:
    operation: str
    arguments: dict[str, Any]


def _text(value: Any, *, field: str, maximum: int, required: bool = False) -> str:
    if not isinstance(value, str):
        if required:
            raise ConsumerMemoryInvalid(f"{field} is required")
        return ""
    cleaned = value.strip()
    if required and not cleaned:
        raise ConsumerMemoryInvalid(f"{field} is required")
    if len(cleaned) > maximum:
        raise ConsumerMemoryInvalid(f"{field} is too long")
    return cleaned


def validate_memory_request(operation: str, arguments: dict[str, Any]) -> ConsumerMemoryRequest:
    """Normalize the typed operation without accepting model-selected authority."""
    if operation not in MEMORY_OPERATIONS:
        raise ConsumerMemoryInvalid("unsupported memory operation")
    if not isinstance(arguments, dict):
        raise ConsumerMemoryInvalid("memory arguments must be an object")

    domain = _text(arguments.get("domain"), field="domain", maximum=64, required=True).lower()
    if any(char not in "abcdefghijklmnopqrstuvwxyz0123456789_-" for char in domain):
        raise ConsumerMemoryInvalid("domain is invalid")
    normalized: dict[str, Any] = {"domain": domain}
    if operation in {"read", "query"}:
        normalized["query"] = _text(
            arguments.get("query"), field="query", maximum=MAX_MEMORY_QUERY_CHARS, required=True
        )
        raw_limit = arguments.get("limit", 10)
        if type(raw_limit) is not int or not 1 <= raw_limit <= MAX_MEMORY_RESULTS:
            raise ConsumerMemoryInvalid("limit is invalid")
        normalized["limit"] = raw_limit
    elif operation in {"save", "correct", "delete"}:
        if operation == "delete" and arguments.get("confirm") is not True:
            raise ConsumerMemoryInvalid("delete requires fresh confirmation")
        if operation == "delete":
            normalized["confirm"] = True
        if operation in {"correct", "delete"}:
            normalized["memory_id"] = _text(
                arguments.get("memory_id"), field="memory_id", maximum=128, required=True
            )
        if operation != "delete":
            normalized["content"] = _text(
                arguments.get("content"),
                field="content",
                maximum=MAX_MEMORY_CONTENT_CHARS,
                required=True,
            )
        idempotency_key = _text(
            arguments.get("idempotency_key"),
            field="idempotency_key",
            maximum=128,
            required=True,
        )
        normalized["idempotency_key"] = idempotency_key
        expected_revision = arguments.get("expected_revision")
        if expected_revision is not None and (
            type(expected_revision) is not int or expected_revision < 0
        ):
            raise ConsumerMemoryInvalid("expected_revision is invalid")
        if expected_revision is not None:
            normalized["expected_revision"] = expected_revision
    else:
        normalized["format"] = (
            _text(arguments.get("format", "summary"), field="format", maximum=32) or "summary"
        )
    return ConsumerMemoryRequest(operation=operation, arguments=normalized)


class ConsumerMcpMemory:
    """Grant-fenced entrypoint for typed consumer memory operations."""

    def __init__(
        self,
        *,
        connections: ConsumerMcpConnections | None = None,
        transport: ConsumerMemoryTransport | None = None,
    ) -> None:
        self._connections = connections or ConsumerMcpConnections()
        self._transport = transport or OwnerPodConsumerMemoryTransport()

    async def execute(
        self, principal: DeveloperPrincipal, *, operation: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        request = validate_memory_request(operation, arguments)
        owner_id = str(principal.subject_firebase_uid or "")
        if not owner_id:
            raise ConsumerConnectionDenied("Owner identity is unavailable")
        # Snapshot the same account/deletion/grant fence used by connection review,
        # then release the SQL lock before remote work. The transport must bind
        # this generation to its pod request; the final check below prevents a
        # revoked or replaced result from reaching the assistant.
        connection = self._connections.admit_memory(principal, operation=operation)
        result = await self._transport.execute(
            operation=request.operation,
            owner_id=owner_id,
            deployment_id=connection.deployment_id,
            connection_id=connection.connection_id,
            generation=connection.generation,
            grant_receipt=str(connection.grant_receipt or ""),
            grant_token=str(connection.grant_token or ""),
            arguments=request.arguments,
        )
        if not isinstance(result, dict):
            raise ConsumerMemoryUnavailable("owner pod returned an invalid memory result")
        self._connections.verify_memory_admission(
            principal, operation=operation, admitted=connection
        )
        # Transport implementations return canonical PKM results.  The gateway
        # adds only non-sensitive execution metadata and never copies payloads
        # into logs, caches or a second persistence layer.
        return {
            "operation": request.operation,
            "execution_target": "owner_pod",
            "deployment_id": connection.deployment_id,
            **result,
        }


__all__ = [
    "ConsumerMemoryInvalid",
    "ConsumerMemoryConflict",
    "ConsumerMemoryRequest",
    "ConsumerMemoryTransport",
    "ConsumerMemoryUnavailable",
    "ConsumerMcpMemory",
    "OwnerPodConsumerMemoryTransport",
    "MEMORY_OPERATIONS",
    "validate_memory_request",
]
