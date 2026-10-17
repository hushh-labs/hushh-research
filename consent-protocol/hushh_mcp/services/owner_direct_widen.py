"""Widen an existing hub-only Google own-cloud agent to owner-direct, with no operator.

A ``user_gcp`` agent built before own-cloud agents were public by construction still
records ``ingress: internal``: Cloud Run ingress ``internal`` and no ``allUsers``
invoker, reachable by the hub alone. On the dev lane the hub now widens it itself,
using the bootstrap identity the owner already granted (the same short-lived
impersonated token ``UserGcpBackend`` provisions with), in this order:

1. read the service and refuse unless it is the recorded incarnation (``serviceUid``);
2. grant ``allUsers`` the invoker role FIRST. An organisation policy refusing it is
   recorded as ``directIngressBlocker`` and nothing else changes; the agent stays
   hub-only until the owner fixes the policy and presses Retry;
3. only then set the service's ingress annotation to ``all``, with a revision nonce,
   on the same service (a replace, never a delete, so the URL survives);
4. wait for the new revision to be Ready, re-pull the pod's key from the recorded URL;
5. one compare-and-set moves ``internal`` to ``external`` for that exact owner,
   HushhID, service and URL (``promote_internal_to_external``).

It never writes ``direct``: the next heartbeat's admission
(``pod_external_ingress_admission``) verifies the wall, health, preflight and live IAM
before the endpoint is published. ``schedule_widen_if_due`` is the heartbeat's
entry point: deduplicated per process, claimed per row with a durable attempt marker
and exponential backoff, run in the background, and never raises.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from hushh_mcp.services.owner_direct_ingress import (
    BLOCKER_KEY,
    BLOCKER_ORG_POLICY,
    RECORDED_EXTERNAL,
    observed_ingress,
    org_policy_refusal,
    public_invoker_bound,
    widenable_internal,
    widening_lane,
)

logger = logging.getLogger(__name__)

WIDEN_MARKER_KEY = "directIngressWiden"
_INGRESS_ANNOTATION = "run.googleapis.com/ingress"
_BASE_BACKOFF_SECONDS = 300
_MAX_BACKOFF_SECONDS = 6 * 60 * 60
_IN_FLIGHT: set[str] = set()
_TASKS: set[asyncio.Task[Any]] = set()


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _service_name(row: dict, metadata: dict) -> str:
    from hushh_mcp.services.gcp_backend import _service_name as derive  # noqa: PLC0415

    return _clean(metadata.get("service")) or derive(_clean(row.get("hushh_id")))


def _image_has_wall(metadata: dict) -> bool:
    """The running image self-reports its BYO AI advert, which postdates the wall.

    ``PodIngressPolicy`` shipped 2026-09-10 and the ``aiSelection`` heartbeat advert
    2026-10-04, so an image that reports it carries the wall. An older image would
    serve ``/pod/info`` and its key to anyone once public; it stays hub-only until an
    approved update installs a current image.
    """
    observed = metadata.get("observed")
    return isinstance(observed, dict) and isinstance(observed.get("aiSelection"), dict)


def widen_due(row: Optional[dict]) -> Optional[dict[str, str]]:
    """The exact pod a widening would act on, or None when none is due."""
    if not isinstance(row, dict) or not widening_lane():
        return None
    metadata = row.get("backend_metadata")
    if not widenable_internal(metadata) or not isinstance(metadata, dict):
        return None
    url = _clean(metadata.get("url"))
    due = {
        "user_id": _clean(row.get("user_id")),
        "hushh_id": _clean(row.get("hushh_id")),
        "service_uid": _clean(metadata.get("serviceUid")),
        "url": url,
        "service": _service_name(row, metadata),
        "project": _clean(row.get("user_cloud_project")),
        "bootstrap_sa": _clean(row.get("user_cloud_bootstrap_sa")),
    }
    if (
        _clean(row.get("deployment_target")) != "user_gcp"
        or _clean(row.get("status")) != "provisioned"
        or not _clean(row.get("pod_pubkey"))
        or metadata.get("upgradeLease") is not None
        or not _image_has_wall(metadata)
        or not url.startswith("https://")
        or url != url.rstrip("/")
        or not all(due.values())
    ):
        return None
    return due


def bootstrap_run_client(row: dict) -> Any:
    """A Cloud Run client in the owner's project on the bootstrap token, or None in plan mode."""
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend  # noqa: PLC0415

    backend = UserGcpBackend(
        user_project=_clean(row.get("user_cloud_project")) or None,
        user_region=_clean(row.get("user_cloud_region")) or None,
        bootstrap_sa=_clean(row.get("user_cloud_bootstrap_sa")) or None,
    )
    return backend._client() if backend.live else None


def _db(db: Any) -> Any:
    if db is not None:
        return db
    from db.db_client import get_db  # noqa: PLC0415

    return get_db()


_ROW_GUARD = """
  WHERE user_id = :user_id AND hushh_id = :hushh_id
    AND deployment_target = 'user_gcp' AND status = 'provisioned'
    AND backend_metadata->>'serviceUid' = :service_uid
    AND backend_metadata->>'ingress' = 'internal'
    AND NOT (backend_metadata ? 'erasure')
    AND NOT (backend_metadata ? 'directIngressBlocker')
"""


async def _write(db: Any, sql: str, params: dict[str, Any]) -> bool:
    response = await asyncio.to_thread(_db(db).execute_raw, sql, params)
    return bool(getattr(response, "data", None))


def _backoff(attempts: int) -> timedelta:
    seconds = _BASE_BACKOFF_SECONDS * (2 ** max(0, attempts - 1))
    return timedelta(seconds=min(seconds, _MAX_BACKOFF_SECONDS))


def _attempt_allowed(metadata: dict, now: datetime) -> bool:
    marker = metadata.get(WIDEN_MARKER_KEY)
    if not isinstance(marker, dict):
        return True
    try:
        return datetime.fromisoformat(str(marker.get("nextAttemptAt"))) <= now
    except ValueError:
        return True


async def claim_widen_attempt(
    row: dict, due: dict[str, str], *, db: Any = None, now: Optional[datetime] = None
) -> bool:
    """Claim the next attempt for this row: one worker wins, the marker carries the backoff."""
    moment = now or datetime.now(timezone.utc)
    metadata = row.get("backend_metadata") or {}
    previous = metadata.get(WIDEN_MARKER_KEY)
    if not _attempt_allowed(metadata, moment):
        return False
    attempts = int((previous or {}).get("attempts") or 0) + 1 if isinstance(previous, dict) else 1
    marker = {
        "attempts": attempts,
        "lastAttemptAt": moment.isoformat(),
        "nextAttemptAt": (moment + _backoff(attempts)).isoformat(),
    }
    # The SQL fragments, including _ROW_GUARD, are constants; all values are bound.
    return await _write(
        db,
        "UPDATE personal_agent_registry SET backend_metadata = jsonb_set("  # nosec B608
        "coalesce(backend_metadata, '{}'::jsonb), '{directIngressWiden}', "
        "CAST(:marker AS jsonb), true)"
        + _ROW_GUARD
        + "  AND backend_metadata->>'upgradeLease' IS NULL"
        " AND backend_metadata->'directIngressWiden' IS NOT DISTINCT FROM CAST(:previous AS jsonb)"
        " RETURNING user_id",
        {
            "user_id": due["user_id"],
            "hushh_id": due["hushh_id"],
            "service_uid": due["service_uid"],
            "marker": json.dumps(marker),
            "previous": json.dumps(previous) if previous is not None else None,
        },
    )


async def record_widen_blocker(due: dict[str, str], status: int, *, db: Any = None) -> bool:
    """Record the organisation-policy refusal on the same hub-only row, durably."""
    blocker = {
        "code": BLOCKER_ORG_POLICY,
        "status": status,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    }
    # The SQL fragments, including _ROW_GUARD, are constants; all values are bound.
    return await _write(
        db,
        "UPDATE personal_agent_registry SET backend_metadata = jsonb_set("  # nosec B608
        "coalesce(backend_metadata, '{}'::jsonb), '{directIngressBlocker}', "
        "CAST(:blocker AS jsonb), true)" + _ROW_GUARD + " RETURNING user_id",
        {
            "user_id": due["user_id"],
            "hushh_id": due["hushh_id"],
            "service_uid": due["service_uid"],
            "blocker": json.dumps(blocker),
        },
    )


async def clear_direct_ingress_blocker(user_id: str, *, db: Any = None) -> bool:
    """The owner's Retry: drop the blocker and the backoff so the next attempt runs now.

    Off the widening lane nothing would re-attempt, so the blocker is kept.
    """
    if not widening_lane():
        return False
    return await _write(
        db,
        "UPDATE personal_agent_registry SET backend_metadata = "
        "(coalesce(backend_metadata, '{}'::jsonb) - 'directIngressBlocker') - "
        "'directIngressWiden' WHERE user_id = :user_id AND deployment_target = 'user_gcp' "
        "AND status = 'provisioned' AND backend_metadata->>'ingress' = 'internal' "
        "AND backend_metadata ? 'directIngressBlocker' "
        "AND NOT (backend_metadata ? 'erasure') RETURNING user_id",
        {"user_id": _clean(user_id)},
    )


async def _open_service(client: Any, due: dict[str, str]) -> Optional[dict]:
    """Bind the public invoker, then ingress ``all``; the Ready service, or None."""
    from hushh_mcp.services.gcp_run_client import GcpRunClient  # noqa: PLC0415

    name, uid = due["service"], due["service_uid"]
    service = await asyncio.to_thread(client.get_service, name)
    GcpRunClient.require_service_uid(service, uid)
    if not isinstance(service, dict):
        raise RuntimeError("Cloud Run service incarnation unverified")
    await asyncio.to_thread(client.grant_public_invoker, name, direct_ingress_axis="direct")
    if observed_ingress(service) == RECORDED_EXTERNAL:
        return service
    nonce = f"widen-{uuid.uuid4().hex[:16]}"
    version = (service.get("metadata") or {}).get("resourceVersion")
    body = {
        "metadata": {"annotations": {_INGRESS_ANNOTATION: "all"}, "resourceVersion": version},
        "spec": service.get("spec") or {},
    }
    await asyncio.to_thread(
        client.replace_service, name, body, revision_nonce=nonce, expected_uid=uid
    )
    ready, live = await asyncio.to_thread(
        client.wait_ready, name, expected_uid=uid, expected_revision_nonce=nonce
    )
    return live if ready else None


async def widen_existing_if_due(
    row: Optional[dict], *, client: Any = None, db: Any = None, key_refresher: Any = None
) -> str:
    """Widen one due hub-only Google agent and record it ``external``; the outcome word.

    Provider failures other than an organisation-policy refusal raise, so the
    scheduler's backoff retries them; every step is idempotent on a retry.
    """
    due = widen_due(row)
    if due is None or row is None:
        return "not_due"
    run = client if client is not None else await asyncio.to_thread(bootstrap_run_client, row)
    if run is None:
        return "plan_mode"
    try:
        live = await _open_service(run, due)
    except Exception as exc:
        status = org_policy_refusal(exc)
        if status is None:
            raise
        recorded = await record_widen_blocker(due, status, db=db)
        logger.warning(
            "owner_direct_widen.org_policy_refused status=%s recorded=%s", status, recorded
        )
        return "blocked"
    if live is None:
        return "not_ready"
    if _clean((live.get("status") or {}).get("url")).rstrip("/") != due["url"]:
        logger.warning("owner_direct_widen.url_changed")
        return "url_changed"
    if key_refresher is None:
        from hushh_mcp.services.pod_key_collector import refresh_pod_key  # noqa: PLC0415

        key_refresher = refresh_pod_key
    await key_refresher(row)
    from hushh_mcp.services.personal_agent_direct_admission import (  # noqa: PLC0415
        promote_internal_to_external,
    )

    promoted = await promote_internal_to_external(
        _db(db),
        user_id=due["user_id"],
        hushh_id=due["hushh_id"],
        service_uid=due["service_uid"],
        url=due["url"],
    )
    logger.info("owner_direct_widen.recorded_external=%s", promoted)
    return "recorded" if promoted else "not_recorded"


async def _run_widen(user_id: str, row: Optional[dict], db: Any) -> str:
    try:
        if row is None:
            from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
                PersonalAgentRegistryRepo,
            )

            row = await PersonalAgentRegistryRepo().get(user_id)
        due = widen_due(row)
        if due is None or row is None or due["user_id"] != user_id:
            return "not_due"
        if not await claim_widen_attempt(row, due, db=db):
            return "not_claimed"
        return await widen_existing_if_due(row, db=db)
    except Exception as exc:  # noqa: BLE001 - the marker's backoff retries
        logger.warning("owner_direct_widen.failed %s", type(exc).__name__)
        return "failed"
    finally:
        _IN_FLIGHT.discard(user_id)


def schedule_widen_if_due(user_id: str, *, row: Optional[dict] = None, db: Any = None) -> bool:
    """Start one background widening for this owner when due; never raises, never waits.

    Pass the heartbeat's row to skip the registry read for the many rows never due.
    """
    uid = _clean(user_id)
    if not uid or uid in _IN_FLIGHT:
        return False
    if row is not None:
        due = widen_due(row)
        metadata = row.get("backend_metadata") or {}
        if due is None or due["user_id"] != uid:
            return False
        if not _attempt_allowed(metadata, datetime.now(timezone.utc)):
            return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    _IN_FLIGHT.add(uid)
    task = loop.create_task(_run_widen(uid, row, db))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return True


async def google_public_ingress_failure(
    row: dict, *, service: str, service_uid: str, client: Any = None
) -> Optional[str]:
    """None when the live service is ingress ``all`` with ``allUsers`` as invoker."""
    run = client if client is not None else await asyncio.to_thread(bootstrap_run_client, row)
    if run is None:
        return "iam_unverifiable"
    live = await asyncio.to_thread(run.get_service, service)
    if not isinstance(live, dict) or _clean((live.get("metadata") or {}).get("uid")) != service_uid:
        return "iam_service_changed"
    if observed_ingress(live) != RECORDED_EXTERNAL:
        return "ingress_not_all"
    if not public_invoker_bound(await asyncio.to_thread(run.get_iam_policy, service)):
        return "iam_no_public_invoker"
    return None


__all__ = [
    "BLOCKER_KEY",
    "WIDEN_MARKER_KEY",
    "bootstrap_run_client",
    "claim_widen_attempt",
    "clear_direct_ingress_blocker",
    "google_public_ingress_failure",
    "record_widen_blocker",
    "schedule_widen_if_due",
    "widen_due",
    "widen_existing_if_due",
]
