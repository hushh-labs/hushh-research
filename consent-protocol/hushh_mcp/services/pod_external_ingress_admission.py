"""Admit a pod whose ingress is public by construction to owner-direct chat.

An owner cloud that can only serve through provider-managed public ingress records
``ingress: "external"``. Its owner talks to the pod directly, and the hub publishes
that endpoint only after ``directReadiness`` is recorded. For a private-by-default
host, opening ingress and verifying it is an operator step (``internal`` to
``direct``, dev-pod-first-light runbook). An ``external`` host has nothing to open,
so the hub runs the same checks itself on a live beat:

- the row is the owner's provisioned pod with its key recorded, which the hub
  pulled from this exact URL, so the address is proven to serve this pod;
- the machine-route wall refuses a caller with no identity (``/pod/info`` 401, 403
  or 404, never served);
- a browser preflight from the app's own origin is allowed, with that exact origin
  echoed back.

Only then does one compare-and-set promote ``external`` to ``direct`` together with
the readiness receipt, bound to the same key, service and URL. Any failure leaves
the row as it was and the next beat retries. Never raises.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from hushh_mcp.services.compute_backend import is_owner_cloud_target

logger = logging.getLogger(__name__)

EXTERNAL_INGRESS = "external"
_WALL_PATH = "/pod/info"
_PREFLIGHT_PATH = "/api/one/pod/session/challenge"
_WALL_REFUSALS = frozenset({401, 403, 404})
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
    if wall.status_code not in _WALL_REFUSALS:
        return f"wall_{wall.status_code}"
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


async def admit_external_ingress_if_due(
    row: Optional[dict],
    *,
    client: Any = None,
    db: Any = None,
    origin: Optional[str] = None,
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
