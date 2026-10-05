"""Registry CAS writes for the explicitly BYOC-only direct-admission contract.

The fleet repository delegates here without cloud SDK calls. These predicates bind
receipts to the exact owner, provider and pod incarnation; never weaken them to make
a provider-neutral lifecycle test pass.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from hushh_mcp.services.compute_backend import is_owner_cloud_target, owner_cloud_bind


def _detached_endpoint_floor(metadata: Any) -> int:
    """The highest endpoint version an earlier, detached home of this identity published.

    Devices pin ``{url, version}`` and accept a new address only at a higher version.
    A detach keeps the old record under ``detachedPlacements`` but clears the live one,
    so without this floor the new home restarted at version 1 and every pinned device
    refused it as "changed without a valid version" (founder's Azure move, 2026-10-05).
    """
    floor = 0
    placements = metadata.get("detachedPlacements") if isinstance(metadata, dict) else None
    for placement in placements if isinstance(placements, list) else []:
        recorded = (
            (placement or {}).get("backend_metadata") if isinstance(placement, dict) else None
        )
        endpoint = recorded.get("endpoint") if isinstance(recorded, dict) else None
        version = endpoint.get("version") if isinstance(endpoint, dict) else None
        if type(version) is int and version > floor:
            floor = version
    return floor


def _next_endpoint(previous: Any, *, url: str, pod_key_id: str, floor: int = 0) -> dict | None:
    """Preserve a valid version on rediscovery; advance it for a new endpoint or home."""
    if not isinstance(previous, dict):
        return None
    version = previous.get("version", 0)
    if type(version) is not int or version < 0:
        return None
    if (
        not version
        or version <= floor
        or previous.get("url") != url
        or previous.get("podKeyId") != pod_key_id
    ):
        version = max(version, floor) + 1
    return {"version": version, "url": url, "podKeyId": pod_key_id}


def direct_owner_matches(
    owner: Any, *, hushh_id: str, pod_key_id: str, pod_public_key: str, service_uid: str, url: str
) -> bool:
    """Current direct deployment predicate; callers own the registry row lock."""
    if owner is None or not all((hushh_id, pod_key_id, pod_public_key, service_uid, url)):
        return False
    metadata = owner.get("backend_metadata") or {}
    readiness = metadata.get("directReadiness") or {}
    return bool(
        owner["hushh_id"] == hushh_id
        and owner["status"] == "provisioned"
        and is_owner_cloud_target(owner["deployment_target"])
        and owner["pod_key_id"] == pod_key_id
        and owner["pod_pubkey"] == pod_public_key
        and "erasure" not in metadata
        and metadata.get("serviceUid") == service_uid
        and str(metadata.get("url") or "").strip().rstrip("/") == url
        and metadata.get("ingress") == "direct"
        and isinstance(readiness, dict)
        and readiness.get("verified") is True
        and readiness.get("serviceUid") == service_uid
        and readiness.get("podKeyId") == pod_key_id
        and readiness.get("url") == url
    )


async def record_endpoint(
    db: Any,
    *,
    user_id: str,
    hushh_id: str,
    pod_key_id: str,
    pod_public_key: str,
    service_uid: str,
    url: str,
) -> dict | None:
    """Validate discovery authority and allocate its version under one row lock."""
    from sqlalchemy import text
    from sqlalchemy.exc import SQLAlchemyError

    from db.db_client import DatabaseExecutionError

    def commit() -> dict | None:
        with db.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout = '5s'"))
            conn.execute(text("SET LOCAL lock_timeout = '2s'"))
            owner = (
                conn.execute(
                    text(
                        "SELECT hushh_id, status, deployment_target, pod_key_id, pod_pubkey, "
                        "backend_metadata FROM personal_agent_registry "
                        "WHERE user_id = :user_id FOR UPDATE"
                    ),
                    {"user_id": user_id},
                )
                .mappings()
                .one_or_none()
            )
            if owner is None:
                return None
            metadata = owner["backend_metadata"] or {}
            if not direct_owner_matches(
                owner,
                hushh_id=hushh_id,
                pod_key_id=pod_key_id,
                pod_public_key=pod_public_key,
                service_uid=service_uid,
                url=url,
            ):
                return None
            previous = metadata.get("endpoint") or {}
            endpoint = _next_endpoint(
                previous, url=url, pod_key_id=pod_key_id, floor=_detached_endpoint_floor(metadata)
            )
            if endpoint is None or endpoint == previous:
                return endpoint
            conn.execute(
                text(
                    "UPDATE personal_agent_registry SET backend_metadata = jsonb_set("
                    "coalesce(backend_metadata, '{}'::jsonb), '{endpoint}', "
                    "CAST(:endpoint AS jsonb), true) WHERE user_id = :user_id"
                ),
                {"user_id": user_id, "endpoint": json.dumps(endpoint)},
            )
            return endpoint

    try:
        return await asyncio.to_thread(commit)
    except SQLAlchemyError:
        raise DatabaseExecutionError(
            table_name="personal_agent_registry",
            operation="pod_endpoint_publication",
            details="Pod endpoint storage is unavailable.",
            status_code=503,
            code="POD_ENDPOINT_STORAGE_UNAVAILABLE",
        ) from None


async def record_binding(
    db: Any,
    *,
    user_id: str,
    device_id: str,
    record: dict,
    puppy_approval: Optional[dict] = None,
) -> bool:
    """Serialize issuance with device revocation and other issuers.

    Lock registry before device, matching account erasure. A signed envelope is
    published only after its exact owner, pod, key and previous version still
    match under these locks. Revocation's device UPDATE uses the same row lock.
    """
    from sqlalchemy import text
    from sqlalchemy.exc import SQLAlchemyError

    from db.db_client import DatabaseExecutionError

    binding = record["envelope"]["binding"]

    def commit() -> bool:
        with db.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout = '5s'"))
            conn.execute(text("SET LOCAL lock_timeout = '2s'"))
            owner = (
                conn.execute(
                    text(
                        "SELECT hushh_id, status, deployment_target, pod_key_id, pod_pubkey, "
                        "backend_metadata FROM personal_agent_registry "
                        "WHERE user_id = :user_id FOR UPDATE"
                    ),
                    {"user_id": user_id},
                )
                .mappings()
                .one_or_none()
            )
            if owner is None:
                return False
            metadata = owner["backend_metadata"] or {}
            device = (
                conn.execute(
                    text(
                        "SELECT device_public_key, platform, status FROM trusted_devices "
                        "WHERE user_id = :user_id AND device_id = :device_id FOR UPDATE"
                    ),
                    {"user_id": user_id, "device_id": device_id},
                )
                .mappings()
                .one_or_none()
            )
            if (
                device is None
                or device["status"] != "active"
                or owner["status"] != "provisioned"
                or "erasure" in metadata
                or binding.get("user_id") != user_id
                or binding.get("subject_id") != device_id
                or binding.get("subject_public_key")
                != str(device["device_public_key"] or "").strip()
                or binding.get("platform") != str(device["platform"] or "").strip().lower()
                or binding.get("hushh_id") != str(owner["hushh_id"] or "").strip()
                or binding.get("deployment_target") != owner["deployment_target"]
                or binding.get("pod_key_id") != str(owner["pod_key_id"] or "").strip()
                or binding.get("pod_public_key") != str(owner["pod_pubkey"] or "").strip()
                or binding.get("url") != str(metadata.get("url") or "").strip().rstrip("/")
                or record.get("serviceUid") != metadata.get("serviceUid")
            ):
                return False
            previous = (metadata.get("bindings") or {}).get(device_id) or {}
            if record["version"] != int(previous.get("version") or 0) + 1:
                return False
            if puppy_approval is not None:
                approval = (metadata.get("puppyAccess") or {}).get(device_id) or {}
                if (
                    not is_owner_cloud_target(owner["deployment_target"])
                    or approval.get("enabled") is not True
                    or approval.get("podKeyId") != puppy_approval["podKeyId"]
                    or approval.get("serviceUid") != puppy_approval["serviceUid"]
                ):
                    return False
            conn.execute(
                text(
                    "UPDATE personal_agent_registry SET backend_metadata = jsonb_set("
                    "coalesce(backend_metadata, '{}'::jsonb), '{bindings}', "
                    "coalesce(backend_metadata->'bindings', '{}'::jsonb) || "
                    "CAST(:record AS jsonb), true) WHERE user_id = :user_id"
                ),
                {"user_id": user_id, "record": json.dumps({device_id: record})},
            )
            return True

    try:
        return await asyncio.to_thread(commit)
    except SQLAlchemyError:
        raise DatabaseExecutionError(
            table_name="personal_agent_registry",
            operation="pod_binding_publication",
            details="Pod binding storage is unavailable.",
            status_code=503,
            code="POD_BINDING_STORAGE_UNAVAILABLE",
        ) from None


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
          AND deployment_target = ANY(:owner_cloud_targets) AND status = 'provisioned'
          AND pod_key_id = :pod_key_id
          AND backend_metadata->>'serviceUid' = :service_uid
          AND backend_metadata->>'url' = :url
          AND backend_metadata->>'ingress' = 'direct'
        RETURNING user_id
        """,
        {
            **owner_cloud_bind(),
            "user_id": user_id,
            "hushh_id": hushh_id,
            "service_uid": service_uid,
            "pod_key_id": pod_key_id,
            "url": url,
            "readiness": json.dumps(readiness),
        },
    )
    return bool(getattr(response, "data", None))


async def promote_external_ingress(
    db: Any,
    *,
    user_id: str,
    hushh_id: str,
    service_uid: str,
    pod_key_id: str,
    url: str,
    verified_at: str,
) -> bool:
    """Promote hub-verified public-by-construction ingress to direct, with its receipt.

    One write, so an external pod is never ``direct`` without readiness. Bound to the
    same owner, key, service and address the checks ran against
    (``pod_external_ingress_admission``); an erasure or a replaced pod refuses it.
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
            jsonb_set(coalesce(backend_metadata, '{}'::jsonb), '{ingress}', '"direct"'::jsonb, true),
            '{directReadiness}', CAST(:readiness AS jsonb), true
        )
        WHERE user_id = :user_id AND hushh_id = :hushh_id
          AND deployment_target = ANY(:owner_cloud_targets) AND status = 'provisioned'
          AND pod_key_id = :pod_key_id AND pod_pubkey IS NOT NULL
          AND backend_metadata->>'serviceUid' = :service_uid
          AND backend_metadata->>'url' = :url
          AND backend_metadata->>'ingress' = 'external'
          AND NOT (backend_metadata ? 'erasure')
        RETURNING user_id
        """,
        {
            **owner_cloud_bind(),
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
          AND deployment_target = ANY(:owner_cloud_targets) AND status = 'provisioned'
          AND pod_key_id = :pod_key_id
          AND backend_metadata->>'serviceUid' = :service_uid
          AND backend_metadata->>'url' = :url
          AND backend_metadata->>'ingress' = 'internal'
        RETURNING user_id
        """,
        {
            **owner_cloud_bind(),
            "user_id": user_id,
            "hushh_id": hushh_id,
            "service_uid": service_uid,
            "pod_key_id": pod_key_id,
            "url": url,
        },
    )
    return bool(getattr(response, "data", None))
