"""Owner-authorized default-model selection for one trusted Puppy device.

The hub carries a short-lived command, not a model catalog or a device session.
Only the enrolled device key can acknowledge application. The inference-only
pod binding never gains device-configuration authority.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.personal_agent_grant_service import PersonalAgentDisabledError
from hushh_mcp.services.pod_access_audit import (
    PERSONAL_AGENT_ID,
    PodAccessAuditService,
    PodAccessDenied,
)
from hushh_mcp.services.pod_binding_service import PodBindingError, PodBindingService
from hushh_mcp.services.pod_session_authority import (
    ROLE_DEVICE,
    canonical_json,
    role_for_platform,
    verify_subject_proof,
)

COMMAND_TTL_MS = 2 * 60 * 1000
_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$")
_CATALOG_VERSION = re.compile(r"^[0-9a-f]{64}$")
_REFUSAL_REASONS = frozenset(
    {"MODEL_UNAVAILABLE", "STALE_MODEL_CATALOG", "DEVICE_BUSY", "DEVICE_ERROR"}
)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _selection(row: dict, device_id: str) -> dict[str, Any] | None:
    metadata = row.get("backend_metadata")
    selections = metadata.get("puppyModelSelection") if isinstance(metadata, dict) else None
    result = selections.get(device_id) if isinstance(selections, dict) else None
    return result if isinstance(result, dict) else None


def _current(row: dict, device_id: str, *, now_ms: int) -> dict[str, Any] | None:
    """Read a command only while its original grant and pod still exist."""
    command = _selection(row, device_id)
    metadata = row.get("backend_metadata")
    if not command or not isinstance(metadata, dict):
        return None
    if (
        row.get("status") != "provisioned"
        or not PodBindingService.puppy_access_approved(row, device_id)
        or command.get("ownerId") != row.get("user_id")
        or command.get("deviceId") != device_id
        or command.get("hushhId") != row.get("hushh_id")
        or command.get("podKeyId") != row.get("pod_key_id")
        or command.get("serviceUid") != metadata.get("serviceUid")
        or type(command.get("version")) is not int
        or command["version"] < 1
    ):
        return None
    if command.get("status") == "pending" and (
        type(command.get("expiresAt")) is not int or command["expiresAt"] <= now_ms
    ):
        return {**command, "status": "expired"}
    return command


def pending_for_device(row: dict, device_id: str, *, now_ms: int | None = None) -> dict | None:
    """The existing device status poll carries only a valid pending command."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    command = _current(row, device_id, now_ms=now_ms)
    if not command or command.get("status") != "pending":
        return None
    return {
        key: command[key]
        for key in (
            "id",
            "version",
            "ownerId",
            "deviceId",
            "hushhId",
            "podKeyId",
            "model",
            "catalogVersion",
            "expiresAt",
        )
    }


def acknowledgement_payload(command: dict, result: str, reason: str) -> str:
    """The exact canonical bytes signed by the existing P-256 device key."""
    return canonical_json(
        {
            "purpose": "puppy-model-selection-ack-v1",
            "id": command["id"],
            "version": command["version"],
            "ownerId": command["ownerId"],
            "deviceId": command["deviceId"],
            "hushhId": command["hushhId"],
            "podKeyId": command["podKeyId"],
            "model": command["model"],
            "catalogVersion": command["catalogVersion"],
            "result": result,
            "reason": reason,
        }
    )


class PuppyModelSelectionService:
    def __init__(
        self,
        *,
        registry: Any = None,
        devices: Any = None,
        audit: Any = None,
        clock: Any = time.time,
    ) -> None:
        if registry is None:
            from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

            registry = PersonalAgentRegistryRepo()
        if devices is None:
            from hushh_mcp.services.trusted_device_service import TrustedDeviceService

            devices = TrustedDeviceService()
        self._registry = registry
        self._devices = devices
        self._audit = audit or PodAccessAuditService(registry=registry)
        self._clock = clock

    async def _owner_row(self, user_id: str, device_id: str) -> dict:
        try:
            await self._audit.authorize_owner_read(
                user_id=user_id,
                agent_id=PERSONAL_AGENT_ID,
                scope=ConsentScope.PKM_READ.value,
                request_id=f"puppy-model-selection:{device_id}",
            )
        except PodAccessDenied as exc:
            raise PodBindingError(
                "POD_NOT_AUTHORIZED", "Not authorized for this pod.", status=403
            ) from exc
        except PersonalAgentDisabledError as exc:
            raise PodBindingError(
                "PERSONAL_AGENT_DISABLED", "The private agent is not available.", status=404
            ) from exc
        row = await self._registry.get(user_id)
        if not isinstance(row, dict):
            raise PodBindingError("POD_NOT_AUTHORIZED", "Not authorized for this pod.", status=403)
        return row

    async def read(self, *, user_id: str, device_id: str) -> dict[str, Any]:
        row = await self._owner_row(user_id, device_id)
        device = await asyncio.to_thread(
            self._devices.active_device, user_id=user_id, device_id=device_id
        )
        if not device or role_for_platform(_text(device.get("platform")).lower()) != ROLE_DEVICE:
            raise PodBindingError(
                "TRUSTED_DEVICE_NOT_ACTIVE", "An active Puppy device is required.", status=403
            )
        current = _current(row, device_id, now_ms=int(self._clock() * 1000))
        return current or {"version": 0, "status": "unavailable"}

    async def request(
        self,
        *,
        user_id: str,
        device_id: str,
        request_id: str,
        model: str,
        catalog_version: str,
        expected_version: int,
    ) -> dict[str, Any]:
        if not _REQUEST_ID.fullmatch(request_id):
            raise PodBindingError("PUPPY_MODEL_REQUEST_INVALID", "Invalid model-change request.")
        if not _MODEL_ID.fullmatch(model) or "://" in model:
            raise PodBindingError("PUPPY_MODEL_INVALID", "Select an installed local model.")
        if not _CATALOG_VERSION.fullmatch(catalog_version):
            raise PodBindingError("PUPPY_MODEL_CATALOG_INVALID", "Refresh the local model list.")
        if type(expected_version) is not int or not 0 <= expected_version < 2**31:
            raise PodBindingError("PUPPY_MODEL_VERSION_INVALID", "Refresh the model setting.")
        row = await self._owner_row(user_id, device_id)
        device = await asyncio.to_thread(
            self._devices.active_device, user_id=user_id, device_id=device_id
        )
        if not device or role_for_platform(_text(device.get("platform")).lower()) != ROLE_DEVICE:
            raise PodBindingError(
                "TRUSTED_DEVICE_NOT_ACTIVE", "An active Puppy device is required.", status=403
            )
        if (
            not PodBindingService.puppy_access_approved(row, device_id)
            or row.get("status") != "provisioned"
        ):
            raise PodBindingError(
                "PUPPY_OWNER_APPROVAL_REQUIRED", "Enable Puppy on your BYOC pod first.", status=403
            )
        metadata = row["backend_metadata"]
        previous = _selection(row, device_id)
        if previous and previous.get("id") == request_id:
            if previous.get("model") != model or previous.get("catalogVersion") != catalog_version:
                raise PodBindingError(
                    "PUPPY_MODEL_REQUEST_CONFLICT", "This request ID was already used.", status=409
                )
        elif int((previous or {}).get("version") or 0) != expected_version:
            raise PodBindingError(
                "PUPPY_MODEL_VERSION_CHANGED", "The model setting changed. Refresh it.", status=409
            )
        now_ms = int(self._clock() * 1000)
        command = {
            "id": request_id,
            "version": expected_version + 1,
            "ownerId": user_id,
            "deviceId": device_id,
            "hushhId": row["hushh_id"],
            "podKeyId": row["pod_key_id"],
            "serviceUid": metadata["serviceUid"],
            "model": model,
            "catalogVersion": catalog_version,
            "createdAt": now_ms,
            "expiresAt": now_ms + COMMAND_TTL_MS,
            "status": "pending",
        }
        stored = await self._registry.record_puppy_model_selection(
            user_id=user_id,
            device_id=device_id,
            command=command,
            expected_version=expected_version,
            approval=metadata["puppyAccess"][device_id],
            readiness=metadata["directReadiness"],
        )
        if stored is None:
            raise PodBindingError(
                "PUPPY_MODEL_VERSION_CHANGED", "The device or pod changed. Refresh it.", status=409
            )
        if stored.get("status") == "pending" and int(stored.get("expiresAt") or 0) <= now_ms:
            return {**stored, "status": "expired"}
        return stored

    async def pending(self, *, user_id: str, device_id: str) -> dict | None:
        row = await self._registry.get(user_id)
        if not isinstance(row, dict):
            return None
        device = await asyncio.to_thread(
            self._devices.active_device, user_id=user_id, device_id=device_id
        )
        if not device or role_for_platform(_text(device.get("platform")).lower()) != ROLE_DEVICE:
            return None
        return pending_for_device(row, device_id, now_ms=int(self._clock() * 1000))

    async def acknowledge(
        self,
        *,
        user_id: str,
        device_id: str,
        request_id: str,
        version: int,
        result: str,
        reason: str,
        proof: str,
    ) -> dict:
        if result not in {"applied", "refused"} or (
            (result == "applied" and reason != "")
            or (result == "refused" and reason not in _REFUSAL_REASONS)
        ):
            raise PodBindingError("PUPPY_MODEL_ACK_INVALID", "Invalid device acknowledgement.")
        row = await self._registry.get(user_id)
        device = await asyncio.to_thread(
            self._devices.active_device, user_id=user_id, device_id=device_id
        )
        if (
            not isinstance(row, dict)
            or not device
            or role_for_platform(_text(device.get("platform")).lower()) != ROLE_DEVICE
        ):
            raise PodBindingError(
                "TRUSTED_DEVICE_NOT_ACTIVE", "An active Puppy device is required.", status=403
            )
        now_ms = int(self._clock() * 1000)
        current = _current(row, device_id, now_ms=now_ms)
        if not current or current.get("id") != request_id or current.get("version") != version:
            raise PodBindingError(
                "PUPPY_MODEL_COMMAND_CHANGED", "The model command expired or changed.", status=409
            )
        if not verify_subject_proof(
            _text(device.get("device_public_key")),
            acknowledgement_payload(current, result, reason),
            proof,
        ):
            raise PodBindingError(
                "PUPPY_MODEL_ACK_UNAUTHORIZED", "The device proof is invalid.", status=403
            )
        if current.get("status") != "pending":
            if current.get("status") == result and _text(current.get("reason")) == reason:
                return current
            raise PodBindingError(
                "PUPPY_MODEL_COMMAND_CHANGED", "The model command already settled.", status=409
            )
        metadata = row["backend_metadata"]
        settled = {**current, "status": result, "reason": reason, "acknowledgedAt": now_ms}
        stored = await self._registry.ack_puppy_model_selection(
            user_id=user_id,
            device_id=device_id,
            previous=current,
            settled=settled,
            approval=metadata["puppyAccess"][device_id],
            readiness=metadata["directReadiness"],
        )
        if stored is None:
            # Two identical receipts can race after the device lost its first
            # HTTP response. The settled row is the receipt; never apply twice.
            latest = await self._registry.get(user_id)
            current = (
                _current(latest, device_id, now_ms=now_ms) if isinstance(latest, dict) else None
            )
            if (
                current
                and current.get("id") == request_id
                and current.get("version") == version
                and current.get("status") == result
                and _text(current.get("reason")) == reason
            ):
                return current
            raise PodBindingError(
                "PUPPY_MODEL_COMMAND_CHANGED", "The model command changed.", status=409
            )
        return stored
