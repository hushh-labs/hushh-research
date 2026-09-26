"""Short owner-requested wake hints. These never grant device or inference access."""

from __future__ import annotations

import asyncio
import json
import time
from uuid import uuid4

from hushh_mcp.services.pod_binding_service import PodBindingError, PodBindingService

ACTIVATION_SECONDS = 120


def current_activation(row: dict, device_id: str, *, now_ms: int | None = None) -> dict | None:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if (
        not PodBindingService.puppy_access_approved(row, device_id)
        or row.get("status") != "provisioned"
    ):
        return None
    metadata = row.get("backend_metadata") or {}
    hint = (metadata.get("puppyActivation") or {}).get(device_id)
    if not isinstance(hint, dict) or (
        hint.get("ownerId") != row.get("user_id")
        or hint.get("hushhId") != row.get("hushh_id")
        or hint.get("deviceId") != device_id
        or hint.get("podKeyId") != row.get("pod_key_id")
        or hint.get("serviceUid") != metadata.get("serviceUid")
        or type(hint.get("expiresAt")) is not int
        or not now_ms < hint["expiresAt"] <= now_ms + ACTIVATION_SECONDS * 1000
    ):
        return None
    return hint


async def request_activation(user_id: str, device_id: str) -> dict:
    from db.db_client import get_db
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.trusted_device_service import TrustedDeviceService

    row = await PersonalAgentRegistryRepo().get(user_id)
    active = await asyncio.to_thread(
        TrustedDeviceService().is_active_device, user_id=user_id, device_id=device_id
    )
    if (
        not row
        or not active
        or row.get("status") != "provisioned"
        or not PodBindingService.puppy_access_approved(row, device_id)
    ):
        raise PodBindingError(
            "PUPPY_OWNER_APPROVAL_REQUIRED", "Enable Puppy on your BYOC pod first.", status=403
        )
    metadata = row["backend_metadata"]
    hint = {
        "id": uuid4().hex,
        "ownerId": user_id,
        "deviceId": device_id,
        "hushhId": row["hushh_id"],
        "podKeyId": row["pod_key_id"],
        "serviceUid": metadata["serviceUid"],
        "expiresAt": int(time.time() * 1000) + ACTIVATION_SECONDS * 1000,
    }
    response = await asyncio.to_thread(
        get_db().execute_raw,
        """UPDATE personal_agent_registry SET backend_metadata=jsonb_set(
            backend_metadata, '{puppyActivation}',
            coalesce(backend_metadata->'puppyActivation','{}'::jsonb) || CAST(:hint AS jsonb), true)
        WHERE user_id=:owner AND hushh_id=:hushh_id AND status='provisioned'
          AND deployment_target='user_gcp' AND pod_key_id=:pod_key
          AND backend_metadata->>'ingress'='direct'
          AND backend_metadata->>'serviceUid'=:service
          AND backend_metadata->'puppyAccess'->:device=CAST(:choice AS jsonb)
          AND backend_metadata->'directReadiness'=CAST(:ready AS jsonb)
        RETURNING user_id""",
        {
            "owner": user_id,
            "hushh_id": row["hushh_id"],
            "pod_key": row["pod_key_id"],
            "service": metadata["serviceUid"],
            "device": device_id,
            "choice": json.dumps(metadata["puppyAccess"][device_id]),
            "ready": json.dumps(metadata["directReadiness"]),
            "hint": json.dumps({device_id: hint}),
        },
    )
    if not response.data:
        raise PodBindingError(
            "POD_ASSIGNMENT_CHANGED", "Your pod changed. Reconnect and try again.", status=409
        )
    return hint
