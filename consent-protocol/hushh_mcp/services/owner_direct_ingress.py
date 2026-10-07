"""Owner-direct ingress for an agent in its owner's own Google project, on Azure's model.

An agent built in the owner's own project is public by construction: Cloud Run
ingress ``all``, an ``allUsers`` invoker binding, and the in-pod wall
(``api/middlewares/pod_ingress.py``) as the lock on every machine route. The registry
records ``ingress: "external"`` until the hub's heartbeat admission
(``pod_external_ingress_admission``) has checked the wall and the app's preflight and
promoted the row to ``direct`` with its readiness receipt, exactly as for Azure.

An existing hub-only agent (``internal``) is widened by the product, not an operator:
on the dev lane ``owner_direct_widen`` grants the public invoker first, then sets
Cloud Run ingress ``all``, then promotes ``internal`` to ``external`` with one
compare-and-set, and an approved update renders it public too. A heal still keeps
the recorded axis.

What this never does is work around an organisation policy that refuses
``allUsers``. That refusal is recorded as a typed blocker, durable across heals and
updates, the agent stays reachable by the hub alone, and only the owner's Retry
clears it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from hushh_mcp.services.compute_backend import BACKEND_USER_GCP, PodSpec
from hushh_mcp.services.gcp_backend import INGRESS_DIRECT, pod_ingress_mode

logger = logging.getLogger(__name__)

RECORDED_EXTERNAL = "external"
RECORDED_INTERNAL = "internal"
BLOCKER_ORG_POLICY = "ORG_POLICY_REFUSES_PUBLIC_INVOKER"
BLOCKER_KEY = "directIngressBlocker"
_WIDENED = frozenset({RECORDED_EXTERNAL, INGRESS_DIRECT})
_CLOUD_RUN_INGRESS = "run.googleapis.com/ingress"
_INVOKER_ROLE = "roles/run.invoker"
_USER_OWNED = "user-owned"
# What Google answers when Domain Restricted Sharing (or another member constraint)
# refuses `allUsers`. Matched narrowly: any other failure is not ours to absorb.
_ORG_POLICY_MARKERS = (
    "permitted customer",
    "allowedpolicymemberdomains",
    "organization policy",
    "org policy",
    "constraints/iam.",
)


def _recorded(metadata: Any) -> Optional[str]:
    return metadata.get("ingress") if isinstance(metadata, dict) else None


def ingress_for_provision(deployment_target: Any, observed: Optional[dict]) -> Optional[str]:
    """`PodSpec.ingress` for a provision: direct for Google own-cloud, unless hub-only."""
    if str(deployment_target or "").strip() != BACKEND_USER_GCP:
        return None
    metadata = observed.get("backend_metadata") if isinstance(observed, dict) else None
    recorded = _recorded(metadata)
    return INGRESS_DIRECT if recorded is None or recorded in _WIDENED else None


def widening_lane() -> bool:
    """Existing hub-only agents are widened on the dev lane only, until dev proves it."""
    from hushh_mcp.services.gcp_backend import _deploy_env_label  # noqa: PLC0415

    return _deploy_env_label() == "dev"


def widenable_internal(metadata: Any) -> bool:
    """A Google own-cloud row still hub-only, with no blocker and no erasure.

    ``tenancy: user-owned`` with ``internal`` names ``user_gcp``: Azure always records
    ``external``, and the managed tier records no tenancy.
    """
    return bool(
        isinstance(metadata, dict)
        and metadata.get("ingress") == RECORDED_INTERNAL
        and metadata.get("tenancy") == _USER_OWNED
        and BLOCKER_KEY not in metadata
        and "erasure" not in metadata
    )


def ingress_for_update(metadata: Any) -> Optional[str]:
    """An approved update keeps a public axis and renders a widenable hub-only one public.

    The update never records the widening (``update_ingress_record``): the row stays
    ``internal`` until ``owner_direct_widen`` has granted the invoker and promoted it.
    """
    if _recorded(metadata) in _WIDENED:
        return INGRESS_DIRECT
    return INGRESS_DIRECT if widenable_internal(metadata) and widening_lane() else None


def rendered_cloud_run_ingress(spec: PodSpec) -> str:
    """The Cloud Run ingress value the renderer produces for this spec."""
    return "all" if pod_ingress_mode(spec) == INGRESS_DIRECT else RECORDED_INTERNAL


def recorded_ingress(spec: PodSpec) -> str:
    """The registry value for a freshly rendered owner pod: never ``direct`` unadmitted."""
    return RECORDED_EXTERNAL if pod_ingress_mode(spec) == INGRESS_DIRECT else RECORDED_INTERNAL


def update_ingress_record(spec: PodSpec) -> dict[str, str]:
    """Metadata an update writes: nothing for a public pod, so admission is not undone."""
    return {} if pod_ingress_mode(spec) == INGRESS_DIRECT else {"ingress": RECORDED_INTERNAL}


def observed_ingress(service: Any) -> str:
    """The registry value for a live service, read from its own ingress annotation."""
    metadata = service.get("metadata") if isinstance(service, dict) else None
    annotations = (metadata or {}).get("annotations") if isinstance(metadata, dict) else None
    value = (annotations or {}).get(_CLOUD_RUN_INGRESS) if isinstance(annotations, dict) else None
    return RECORDED_EXTERNAL if value == "all" else RECORDED_INTERNAL


def public_invoker_bound(policy: Any) -> bool:
    """Whether a Cloud Run IAM policy grants ``allUsers`` the invoker role."""
    bindings = policy.get("bindings") if isinstance(policy, dict) else None
    return any(
        isinstance(binding, dict)
        and binding.get("role") == _INVOKER_ROLE
        and "allUsers" in (binding.get("members") or [])
        for binding in bindings or []
    )


def org_policy_refusal(exc: BaseException) -> Optional[int]:
    """The HTTP status when ``exc`` is an organisation policy refusing ``allUsers``."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status not in (400, 403, 412):
        return None
    body = str(getattr(response, "text", "") or "").lower()
    return int(status) if any(marker in body for marker in _ORG_POLICY_MARKERS) else None


async def bind_owner_direct_ingress(client: Any, name: str, spec: PodSpec) -> dict[str, Any]:
    """Grant the public invoker for a direct spec; the ingress metadata to record."""
    if pod_ingress_mode(spec) != INGRESS_DIRECT:
        return {"ingress": RECORDED_INTERNAL}
    try:
        await asyncio.to_thread(
            client.grant_public_invoker, name, direct_ingress_axis=INGRESS_DIRECT
        )
    except Exception as exc:
        status = org_policy_refusal(exc)
        if status is None:
            raise
        logger.warning("owner_direct_ingress.org_policy_refused service=%s status=%s", name, status)
        spec.emit_stage("public_invoker_refused")
        return {
            "ingress": RECORDED_INTERNAL,
            "directIngressBlocker": {"code": BLOCKER_ORG_POLICY, "status": status},
        }
    spec.emit_stage("public_invoker_bound")
    return {"ingress": RECORDED_EXTERNAL}


__all__ = [
    "BLOCKER_KEY",
    "BLOCKER_ORG_POLICY",
    "RECORDED_EXTERNAL",
    "RECORDED_INTERNAL",
    "bind_owner_direct_ingress",
    "ingress_for_provision",
    "ingress_for_update",
    "observed_ingress",
    "org_policy_refusal",
    "public_invoker_bound",
    "recorded_ingress",
    "rendered_cloud_run_ingress",
    "update_ingress_record",
    "widenable_internal",
    "widening_lane",
]
