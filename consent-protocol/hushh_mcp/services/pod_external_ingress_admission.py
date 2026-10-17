"""Admit a pod whose ingress is public by construction to owner-direct chat.

Every owner cloud whose pod is public by construction records ``ingress: "external"``:
Azure always, and a Google own-cloud pod built on the direct axis (Cloud Run ingress
``all`` with an ``allUsers`` invoker, ``owner_direct_ingress``). Its owner talks to the
pod directly, and the hub publishes that endpoint only after ``directReadiness`` is
recorded. A hub-only (``internal``) Google pod is first widened by the hub itself
(``owner_direct_widen``), which records it ``external``. An ``external`` pod has
nothing to open, so the hub runs the same checks itself on a live beat, whatever the
provider:

- the row is the owner's provisioned pod with its key recorded, which the hub
  pulled from this exact URL, so the address is proven to serve this pod;
- the machine-route wall refuses a caller with no identity with the pod's own
  answer: ``/pod/info`` 404 with exactly ``POD_WALL_NOT_FOUND_BODY``. A Cloud Run IAM
  403 or any other 404 is not the wall, it is something in front of the pod;
- an anonymous ``/health`` answers 200, so the pod itself is publicly reachable;
- a browser preflight from the app's own origin is allowed, with that exact origin
  echoed back;
- for a Google pod, the live service read with the owner's bootstrap identity is the
  same incarnation, has ingress ``all`` and grants ``allUsers`` the invoker role.

Only then does one compare-and-set promote ``external`` to ``direct`` together with
the readiness receipt, bound to the same key, service and URL. Any failure leaves
the row as it was and the next beat retries. Never raises.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from hushh_mcp.services.compute_backend import BACKEND_USER_GCP, is_owner_cloud_target
from hushh_mcp.services.pod_wall import POD_WALL_NOT_FOUND_BODY, POD_WALL_STATUS

logger = logging.getLogger(__name__)

EXTERNAL_INGRESS = "external"
_WALL_PATH = "/pod/info"
_HEALTH_PATH = "/health"
_PREFLIGHT_PATH = "/api/one/pod/session/challenge"
_TIMEOUT_SECONDS = 5.0


def _clean(value: Any) -> str:
    return str(value or "").strip()


def admission_due(row: Optional[dict]) -> Optional[dict[str, str]]:
    """The exact pod an admission would bind to, or None when none is due."""
    if not isinstance(row, dict):
        return None
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, dict) or metadata.get("ingress") != EXTERNAL_INGRESS:
        return None
    url = _clean(metadata.get("url"))
    due = {
        "user_id": _clean(row.get("user_id")),
        "hushh_id": _clean(row.get("hushh_id")),
        "pod_key_id": _clean(row.get("pod_key_id")),
        "service_uid": _clean(metadata.get("serviceUid")),
        "url": url,
    }
    if (
        not is_owner_cloud_target(row.get("deployment_target"))
        or _clean(row.get("status")) != "provisioned"
        or not _clean(row.get("pod_pubkey"))
        or "erasure" in metadata
        or not url.startswith("https://")
        or url != url.rstrip("/")
        or not all(due.values())
    ):
        return None
    return due


def _app_origin() -> str:
    from hushh_mcp.runtime_settings import get_app_runtime_settings  # noqa: PLC0415

    return _clean(get_app_runtime_settings().app_frontend_origin)


async def _ingress_holds(client: Any, url: str, origin: str) -> Optional[str]:
    """None when the wall and the app's preflight both hold, else the failed check."""
    wall = await client.get(f"{url}{_WALL_PATH}")
    if wall.status_code != POD_WALL_STATUS:
        return f"wall_{wall.status_code}"
    if wall.content != POD_WALL_NOT_FOUND_BODY:
        return "wall_body"
    health = await client.get(f"{url}{_HEALTH_PATH}")
    if health.status_code != 200:
        return f"health_{health.status_code}"
    preflight = await client.request(
        "OPTIONS",
        f"{url}{_PREFLIGHT_PATH}",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    if preflight.status_code not in (200, 204):
        return f"preflight_{preflight.status_code}"
    if preflight.headers.get("access-control-allow-origin") != origin:
        return "preflight_origin"
    return None


async def _cloud_holds(row: dict, due: dict[str, str], cloud_check: Any) -> Optional[str]:
    """For a Google pod, the live IAM and ingress read back; None when they hold."""
    if _clean(row.get("deployment_target")) != BACKEND_USER_GCP:
        return None
    if cloud_check is None:
        from hushh_mcp.services.owner_direct_widen import (  # noqa: PLC0415
            google_public_ingress_failure as cloud_check,
        )
    metadata = row.get("backend_metadata") or {}
    service = _clean(metadata.get("service"))
    if not service:
        return "iam_no_service"
    return await cloud_check(row, service=service, service_uid=due["service_uid"])


async def admit_external_ingress_if_due(
    row: Optional[dict],
    *,
    client: Any = None,
    db: Any = None,
    origin: Optional[str] = None,
    cloud_check: Any = None,
) -> bool:
    """Verify and record owner-direct readiness for an external-ingress pod."""
    due = admission_due(row)
    if due is None:
        return False
    app_origin = _clean(origin) if origin is not None else _app_origin()
    if not app_origin.startswith("https://"):
        logger.warning("pod_external_ingress.no_app_origin")
        return False
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS, follow_redirects=False) as owned:
                failed = await _ingress_holds(owned, due["url"], app_origin)
        else:
            failed = await _ingress_holds(client, due["url"], app_origin)
        if not failed and row is not None:
            failed = await _cloud_holds(row, due, cloud_check)
    except Exception as exc:  # noqa: BLE001 - an unreachable pod is retried next beat
        logger.info("pod_external_ingress.unreachable %s", type(exc).__name__)
        return False
    if failed:
        logger.warning("pod_external_ingress.check_failed check=%s", failed)
        return False

    from hushh_mcp.services.personal_agent_direct_admission import (  # noqa: PLC0415
        promote_external_ingress,
    )

    if db is None:
        from db.db_client import get_db  # noqa: PLC0415

        db = get_db()
    try:
        admitted = await promote_external_ingress(
            db, verified_at=datetime.now(timezone.utc).isoformat(), **due
        )
    except Exception as exc:  # noqa: BLE001 - the next beat retries
        logger.warning("pod_external_ingress.record_failed %s", type(exc).__name__)
        return False
    logger.info("pod_external_ingress.admitted=%s", admitted)
    return admitted
