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
import re
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
_TASK_ID_RE = re.compile(r"^task_[a-f0-9]{32}$")


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

    async def start(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        agent_id: str,
        invoke_token: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def status(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        agent_id: str,
        task_id: str,
        invoke_token: str,
    ) -> dict[str, Any]: ...

    async def cancel(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        agent_id: str,
        task_id: str,
        invoke_token: str,
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
            # Pod/provider details are internal and may contain credentials,
            # identifiers, or infrastructure information. The MCP boundary
            # exposes one stable refusal; the typed relay already records the
            # safe reason in its own contract.
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc
        except Exception as exc:  # noqa: BLE001 - do not expose provider/DB details
            raise ConsumerTaskUnavailable("owner pod turn is unavailable") from exc
        if not isinstance(result, dict) or str(result.get("hushhId") or "") != deployment_id:
            raise ConsumerTaskUnavailable("owner pod returned an invalid execution target")
        return result

    async def start(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        agent_id: str,
        invoke_token: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        from api.routes.one.pod_relay import relay_pod_task_start  # noqa: PLC0415

        try:
            return await relay_pod_task_start(
                hushh_id=deployment_id,
                user_id=owner_id,
                agent_id=agent_id,
                invoke_token=invoke_token,
                arguments=arguments,
            )
        except HTTPException as exc:
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc
        except Exception as exc:  # noqa: BLE001 - keep pod details out of MCP
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc

    async def status(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        agent_id: str,
        task_id: str,
        invoke_token: str,
    ) -> dict[str, Any]:
        from api.routes.one.pod_relay import relay_pod_task_status  # noqa: PLC0415

        try:
            return await relay_pod_task_status(
                hushh_id=deployment_id,
                user_id=owner_id,
                agent_id=agent_id,
                task_id=task_id,
                invoke_token=invoke_token,
            )
        except HTTPException as exc:
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc
        except Exception as exc:  # noqa: BLE001 - keep pod details out of MCP
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc

    async def cancel(
        self,
        *,
        owner_id: str,
        deployment_id: str,
        agent_id: str,
        task_id: str,
        invoke_token: str,
    ) -> dict[str, Any]:
        from api.routes.one.pod_relay import relay_pod_task_cancel  # noqa: PLC0415

        try:
            return await relay_pod_task_cancel(
                hushh_id=deployment_id,
                user_id=owner_id,
                agent_id=agent_id,
                task_id=task_id,
                invoke_token=invoke_token,
            )
        except HTTPException as exc:
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc
        except Exception as exc:  # noqa: BLE001 - keep pod details out of MCP
            raise ConsumerTaskUnavailable("owner pod task is unavailable") from exc


@dataclass(frozen=True)
class ConsumerTaskRequest:
    message: str
    conversation_id: str
    timezone: str | None
    runtime_provider: str | None
    puppy_device_id: str | None
    idempotency_key: str


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
    idempotency_key = arguments.get("idempotency_key", "")
    if not isinstance(idempotency_key, str) or len(idempotency_key.strip()) > 128:
        raise ValueError("idempotency_key is invalid")
    idempotency_key = idempotency_key.strip()
    return ConsumerTaskRequest(
        message,
        conversation_id,
        timezone,
        runtime_provider,
        puppy_device_id,
        idempotency_key,
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
        # ``relay_pod_turn`` is the canonical wire contract and emits ``text``.
        # Keep the legacy ``response`` fallback only for older compatible relay
        # doubles; a missing text/response is never a successful task.
        response = str(result.get("text") or result.get("response") or "")
        if not response:
            raise ConsumerTaskUnavailable("owner pod returned no task response")
        # A Puppy request is an explicit inference lane, not merely a hint about
        # where One should execute.  The pod's resolved provider is the authority
        # for the result; refusing a missing, shared, or cloud provider prevents a
        # relay fallback from being reported as private-device inference.
        reported_provider = str(result.get("provider") or "").strip().lower()
        if request.runtime_provider == "puppy" and reported_provider != "puppy":
            raise ConsumerTaskUnavailable("owner pod did not use the requested Puppy provider")
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

    async def start(
        self, principal: DeveloperPrincipal, *, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        request = validate_task_request(arguments)
        invoke_token = await self._invoke_token(principal)
        owner = str(principal.subject_firebase_uid or "")
        current = await asyncio.to_thread(self._connections.current, principal)
        transport = getattr(self._transport, "start", None)
        if not callable(transport):
            raise ConsumerTaskUnavailable("durable owner-pod task transport unavailable")
        result = await transport(
            owner_id=owner,
            deployment_id=current.deployment_id,
            agent_id=str(principal.agent_id),
            invoke_token=invoke_token,
            arguments={
                "message": request.message,
                "conversation_id": request.conversation_id,
                "timezone": request.timezone,
                "runtime_provider": request.runtime_provider,
                "puppy_device_id": request.puppy_device_id,
                "idempotency_key": request.idempotency_key,
            },
        )
        return self._normalize_lifecycle_result(result, current.deployment_id)

    async def status(
        self, principal: DeveloperPrincipal, *, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        task_id = str(arguments.get("task_id") or "").strip() if isinstance(arguments, dict) else ""
        if not _TASK_ID_RE.fullmatch(task_id):
            raise ValueError("task_id is invalid")
        invoke_token = await self._invoke_token(principal)
        owner = str(principal.subject_firebase_uid or "")
        current = await asyncio.to_thread(self._connections.current, principal)
        transport = getattr(self._transport, "status", None)
        if not callable(transport):
            raise ConsumerTaskUnavailable("durable owner-pod task transport unavailable")
        result = await transport(
            owner_id=owner,
            deployment_id=current.deployment_id,
            agent_id=str(principal.agent_id),
            task_id=task_id,
            invoke_token=invoke_token,
        )
        return self._normalize_lifecycle_result(result, current.deployment_id)

    async def cancel(
        self, principal: DeveloperPrincipal, *, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        task_id = str(arguments.get("task_id") or "").strip() if isinstance(arguments, dict) else ""
        if not _TASK_ID_RE.fullmatch(task_id):
            raise ValueError("task_id is invalid")
        invoke_token = await self._invoke_token(principal)
        owner = str(principal.subject_firebase_uid or "")
        current = await asyncio.to_thread(self._connections.current, principal)
        transport = getattr(self._transport, "cancel", None)
        if not callable(transport):
            raise ConsumerTaskUnavailable("durable owner-pod task transport unavailable")
        result = await transport(
            owner_id=owner,
            deployment_id=current.deployment_id,
            agent_id=str(principal.agent_id),
            task_id=task_id,
            invoke_token=invoke_token,
        )
        return self._normalize_lifecycle_result(result, current.deployment_id)

    @staticmethod
    def _normalize_lifecycle_result(result: Any, deployment_id: str) -> dict[str, Any]:
        if not isinstance(result, dict) or str(result.get("execution_target") or "") != "owner_pod":
            raise ConsumerTaskUnavailable("owner pod returned an invalid task")
        state = str(result.get("state") or "")
        if state not in {
            "queued",
            "running",
            "completed",
            "failed",
            "cancel_requested",
            "cancelled",
            "interrupted",
        }:
            raise ConsumerTaskUnavailable("owner pod returned an invalid task state")
        return {
            "state": state,
            "execution_target": "owner_pod",
            "deployment_id": deployment_id,
            "task_id": str(result.get("task_id") or "")[:64],
            "conversation_id": str(result.get("conversation_id") or "")[:128],
            "runtime_provider": str(result.get("runtime_provider") or "")[:32] or None,
            "puppy_device_id": str(result.get("puppy_device_id") or "")[:128] or None,
            "result": str(result.get("result") or "")[:MAX_TASK_RESPONSE_CHARS] or None,
            "error_code": str(result.get("error_code") or "")[:64] or None,
            "created_at_ms": int(result.get("created_at_ms") or 0),
            "updated_at_ms": int(result.get("updated_at_ms") or 0),
            "generation": int(result.get("generation") or 0),
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
