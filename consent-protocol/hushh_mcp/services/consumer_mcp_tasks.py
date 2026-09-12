"""Owner-bound delegation to the existing Agent One pod turn.

This is a typed consumer-MCP seam, not a second router or model provider.  The
external assistant must hold a separate, owner-approved ``cap.one.invoke``
grant; the turn itself reuses the existing owner relay, pod orchestration and
specialist authority path.  Interrupted work is returned as an error and is
never replayed by this module.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consumer_mcp_connections import (
    ConsumerConnectionDenied,
    ConsumerMcpConnections,
)
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal

MAX_TASK_MESSAGE_CHARS = 8_000
MAX_CONVERSATION_ID_CHARS = 128
MAX_TIMEZONE_CHARS = 64
MAX_TASK_RESPONSE_CHARS = 16_000
TASK_TIMEOUT_SECONDS = 120


class ConsumerTaskApprovalRequired(ConsumerConnectionDenied):
    """The external client has not separately approved delegation to One."""


class ConsumerTaskUnavailable(RuntimeError):
    """The owner pod or existing relay could not complete the turn."""


class ConsumerTaskTransport(Protocol):
    async def execute(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        message: str,
        conversation_id: str,
        timezone: str | None,
        runtime_provider: str | None,
        puppy_device_id: str | None,
    ) -> dict[str, Any]: ...


class OwnerPodConsumerTaskTransport:
    """Call the existing owner relay; never execute One in the MCP gateway."""

    async def execute(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        message: str,
        conversation_id: str,
        timezone: str | None,
        runtime_provider: str | None,
        puppy_device_id: str | None,
    ) -> dict[str, Any]:
        from api.routes.one.pod_relay import (  # noqa: PLC0415
            PodTurnRelayRequest,
            relay_pod_turn,
        )

        payload = PodTurnRelayRequest(
            message=message,
            conversationId=conversation_id,
            timezone=timezone,
            runtimeProvider=runtime_provider,
            puppyDeviceId=puppy_device_id,
        )
        try:
            result = await relay_pod_turn(
                hushh_id=deployment_id,
                user_id=owner_id,
                payload=payload,
            )
        except HTTPException as exc:
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc
        except Exception as exc:  # noqa: BLE001 - do not expose provider/DB details
            raise ConsumerTaskUnavailable("owner pod turn is unavailable") from exc
        if not isinstance(result, dict) or str(result.get("hushhId") or "") != deployment_id:
            raise ConsumerTaskUnavailable("owner pod returned an invalid execution target")
        return result


@dataclass(frozen=True)
class ConsumerTaskRequest:
    message: str
    conversation_id: str
    timezone: str | None
    runtime_provider: str | None
    puppy_device_id: str | None


def validate_task_request(arguments: dict[str, Any]) -> ConsumerTaskRequest:
    if not isinstance(arguments, dict):
        raise ValueError("task arguments must be an object")
    message = arguments.get("message")
    if not isinstance(message, str) or not message.strip():
        raise ValueError("message is required")
    message = message.strip()
    if len(message) > MAX_TASK_MESSAGE_CHARS:
        raise ValueError("message is too long")
    conversation_id = arguments.get("conversation_id", "consumer-mcp")
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        raise ValueError("conversation_id is invalid")
    conversation_id = conversation_id.strip()
    if len(conversation_id) > MAX_CONVERSATION_ID_CHARS:
        raise ValueError("conversation_id is too long")
    timezone = arguments.get("timezone")
    if timezone is not None:
        if not isinstance(timezone, str) or len(timezone.strip()) > MAX_TIMEZONE_CHARS:
            raise ValueError("timezone is invalid")
        timezone = timezone.strip() or None
    runtime_provider = arguments.get("runtime_provider")
    if runtime_provider is not None:
        if not isinstance(runtime_provider, str):
            raise ValueError("runtime_provider is invalid")
        runtime_provider = runtime_provider.strip().lower() or None
        # The consumer surface may opt into the registered Puppy lane only.
        # It must never become a caller-selected provider router.
        if runtime_provider != "puppy":
            raise ValueError("runtime_provider must be puppy when provided")
    puppy_device_id = arguments.get("puppy_device_id")
    if puppy_device_id is not None:
        if not isinstance(puppy_device_id, str) or not puppy_device_id.strip():
            raise ValueError("puppy_device_id is invalid")
        puppy_device_id = puppy_device_id.strip()
        if len(puppy_device_id) > 128:
            raise ValueError("puppy_device_id is too long")
    if runtime_provider == "puppy" and puppy_device_id is None:
        raise ValueError("puppy_device_id is required for Puppy inference")
    if runtime_provider is None and puppy_device_id is not None:
        raise ValueError("runtime_provider=puppy is required for a Puppy device")
    return ConsumerTaskRequest(
        message,
        conversation_id,
        timezone,
        runtime_provider,
        puppy_device_id,
    )


class ConsumerMcpTask:
    """Grant-fenced delegation to One through the existing pod relay."""

    def __init__(
        self,
        *,
        connections: ConsumerMcpConnections | None = None,
        transport: ConsumerTaskTransport | None = None,
        active_tokens: Any = None,
        validator: Any = None,
    ) -> None:
        self._connections = connections or ConsumerMcpConnections()
        self._transport = transport or OwnerPodConsumerTaskTransport()
        self._active_tokens = active_tokens
        self._validator = validator

    async def _invoke_token(self, principal: DeveloperPrincipal) -> str:
        owner = str(principal.subject_firebase_uid or "")
        agent = str(principal.agent_id or "")
        if not owner or not agent:
            raise ConsumerTaskApprovalRequired("Owner identity is unavailable")
        if self._active_tokens is None:
            from hushh_mcp.services.consent_db import ConsentDBService  # noqa: PLC0415

            self._active_tokens = ConsentDBService().get_covering_active_tokens
        if self._validator is None:
            self._validator = validate_token_with_db
        try:
            rows = await self._active_tokens(
                owner,
                agent_id=agent,
                requested_scope=ConsentScope.CAP_ONE_INVOKE.value,
            )
        except Exception as exc:  # noqa: BLE001 - authority outage is not approval
            raise ConsumerTaskApprovalRequired(
                "Agent One approval is temporarily unavailable"
            ) from exc
        for row in rows or []:
            candidate = str(row.get("token_id") or "")
            if not candidate:
                continue
            valid, _reason, claims = await self._validator(
                candidate, expected_scope=ConsentScope.CAP_ONE_INVOKE
            )
            if (
                valid
                and claims is not None
                and str(claims.user_id) == owner
                and str(claims.agent_id) == agent
                and str(getattr(claims, "scope_str", "")) == ConsentScope.CAP_ONE_INVOKE.value
            ):
                return candidate
        raise ConsumerTaskApprovalRequired(
            "Approve Agent One delegation for this assistant before starting a task"
        )

    async def execute(
        self, principal: DeveloperPrincipal, *, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        request = validate_task_request(arguments)
        # The token is an independent admission check. It is deliberately not
        # passed to the pod: the existing relay mints the pod's own attenuated
        # grants and the external bearer never becomes pod authority.
        await self._invoke_token(principal)
        owner = str(principal.subject_firebase_uid or "")
        current = await asyncio.to_thread(self._connections.current, principal)
        # Caller labels are namespaced to this external connection generation
        # before entering the pod's directive/history store.
        relay_conversation_id = (
            "mcp-"
            + hashlib.sha256(
                f"{current.connection_id}:{current.generation}:{request.conversation_id}".encode()
            ).hexdigest()[:32]
        )
        try:
            result = await asyncio.wait_for(
                self._transport.execute(
                    owner_id=owner,
                    deployment_id=current.deployment_id,
                    message=request.message,
                    conversation_id=relay_conversation_id,
                    timezone=request.timezone,
                    runtime_provider=request.runtime_provider,
                    puppy_device_id=request.puppy_device_id,
                ),
                timeout=TASK_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError as exc:
            raise ConsumerTaskUnavailable("owner pod task timed out") from exc
        # Revocation/reconnect wins a race with a late result. The transport
        # cannot silently replay after this check fails.
        await self._invoke_token(principal)
        after = await asyncio.to_thread(self._connections.current, principal)
        if (
            after.connection_id != current.connection_id
            or after.generation != current.generation
            or after.deployment_id != current.deployment_id
        ):
            raise ConsumerTaskUnavailable("assistant access changed while the task was running")
        response = str(result.get("text") or "")
        if not response:
            raise ConsumerTaskUnavailable("owner pod returned no task response")
        delegation = result.get("delegation")
        safe_delegation = (
            {"delegated": True}
            if isinstance(delegation, dict) and delegation.get("delegated")
            else None
        )
        return {
            "state": "completed",
            "execution_target": "owner_pod",
            "deployment_id": current.deployment_id,
            "conversation_id": request.conversation_id,
            "response": response[:MAX_TASK_RESPONSE_CHARS],
            "runtime_mode": str(result.get("runtimeMode") or "")[:64],
            "provider": str(result.get("provider") or "")[:64] or None,
            "model": str(result.get("model") or "")[:128] or None,
            "delegation": safe_delegation,
        }


__all__ = [
    "ConsumerMcpTask",
    "ConsumerTaskApprovalRequired",
    "ConsumerTaskRequest",
    "ConsumerTaskTransport",
    "ConsumerTaskUnavailable",
    "OwnerPodConsumerTaskTransport",
    "validate_task_request",
]
