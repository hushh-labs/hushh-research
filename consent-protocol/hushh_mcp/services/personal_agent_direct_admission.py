"""Registry CAS writes for the explicitly BYOC-only direct-admission contract.

The fleet repository delegates here without cloud SDK calls. These predicates bind
receipts to the exact owner, provider and pod incarnation; never weaken them to make
a provider-neutral lifecycle test pass.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional


async def record_binding(
    db: Any,
    *,
    user_id: str,
    device_id: str,
    record: dict,
    puppy_approval: Optional[dict] = None,
) -> bool:
    """`backend_metadata.bindings[device_id] = record` (merge; other subjects kept)."""
    response = await asyncio.to_thread(
        db.execute_raw,
        """
        UPDATE personal_agent_registry
        SET backend_metadata = jsonb_set(
                coalesce(backend_metadata, '{}'::jsonb),
                '{bindings}',
                coalesce(backend_metadata->'bindings', '{}'::jsonb)
                    || CAST(:record AS jsonb),
                true
            )
        WHERE user_id = :user_id
          AND (
                :requires_approval = false
                OR (
                    deployment_target = 'user_gcp'
                    AND backend_metadata->'puppyAccess'->:device_id->>'enabled' = 'true'
                    AND backend_metadata->'puppyAccess'->:device_id->>'podKeyId' = :pod_key_id
                    AND backend_metadata->'puppyAccess'->:device_id->>'serviceUid' = :service_uid
                )
              )
        RETURNING user_id
        """,
        {
            "user_id": user_id,
            "device_id": device_id,
            "record": json.dumps({device_id: record}),
            "requires_approval": puppy_approval is not None,
            "pod_key_id": (puppy_approval or {}).get("podKeyId", ""),
            "service_uid": (puppy_approval or {}).get("serviceUid", ""),
        },
    )
    return bool(getattr(response, "data", None))


async def record_direct_readiness(
    db: Any,
    *,
    user_id: str,
    hushh_id: str,
    service_uid: str,
    pod_key_id: str,
    url: str,
    verified_at: str,
) -> bool:
    """Publish operator-verified direct ingress only for the same live pod.

    The caller must first verify live ingress, IAM, CORS, route wall and
    admission. This compare-and-set prevents that receipt moving to a new
    service incarnation, address, key, owner or deployment target.
    """
    readiness = {
        "verified": True,
        "serviceUid": service_uid,
        "podKeyId": pod_key_id,
        "url": url,
        "verifiedAt": verified_at,
    }
    response = await asyncio.to_thread(
        db.execute_raw,
        """
        UPDATE personal_agent_registry
        SET backend_metadata = jsonb_set(
            coalesce(backend_metadata, '{}'::jsonb),
            '{directReadiness}', CAST(:readiness AS jsonb), true
        )
        WHERE user_id = :user_id AND hushh_id = :hushh_id
          AND deployment_target = 'user_gcp' AND status = 'provisioned'
          AND pod_key_id = :pod_key_id
          AND backend_metadata->>'serviceUid' = :service_uid
          AND backend_metadata->>'url' = :url
          AND backend_metadata->>'ingress' = 'direct'
        RETURNING user_id
        """,
        {
            "user_id": user_id,
            "hushh_id": hushh_id,
            "service_uid": service_uid,
            "pod_key_id": pod_key_id,
            "url": url,
            "readiness": json.dumps(readiness),
        },
    )
    return bool(getattr(response, "data", None))


async def record_direct_ingress_observed(
    db: Any,
    *,
    user_id: str,
    hushh_id: str,
    service_uid: str,
    pod_key_id: str,
    url: str,
) -> bool:
    """Record an operator-observed ingress transition on one existing pod.

    This does not publish its endpoint. `record_direct_readiness` remains a
    separate step after live CORS, wall and admission checks.
    """
    response = await asyncio.to_thread(
        db.execute_raw,
        """
        UPDATE personal_agent_registry
        SET backend_metadata = jsonb_set(
            coalesce(backend_metadata, '{}'::jsonb),
            '{ingress}', '"direct"'::jsonb, true
        )
        WHERE user_id = :user_id AND hushh_id = :hushh_id
          AND deployment_target = 'user_gcp' AND status = 'provisioned'
          AND pod_key_id = :pod_key_id
          AND backend_metadata->>'serviceUid' = :service_uid
          AND backend_metadata->>'url' = :url
          AND backend_metadata->>'ingress' = 'internal'
        RETURNING user_id
        """,
        {
            "user_id": user_id,
            "hushh_id": hushh_id,
            "service_uid": service_uid,
            "pod_key_id": pod_key_id,
            "url": url,
        },
    )
    return bool(getattr(response, "data", None))
