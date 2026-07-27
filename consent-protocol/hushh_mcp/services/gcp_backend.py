"""GCP compute backend — primary host for the FedRAMP-High / regulated tier (Apple-PCC-on-GCP).

Implements the ``ComputeBackend`` contract for Google Cloud, following the Apple
Private Cloud Compute blueprint (ARCHITECTURE.md §7): a per-user agent runs as an
isolated Cloud Run service (logical/mass tier) or a Confidential-Space-attested
instance (dedicated/regulated tier), reachable only through the Hushh A2A address,
holding its own key, with Hushh never able to read the workload. The primary target
is chosen per workload class: GCP is **primary for the FedRAMP-High / government /
regulated tier** — it carries **FedRAMP High** (the higher compliance ceiling vs
MuleSoft Government Cloud's Moderate) and is the validated, live-wired backend.
General / mass-market deployments are primary on Anypoint (pre-purchased Titanium
capacity); see ARCHITECTURE.md §2, ROADMAP.md.

**Inert by default.** This backend runs in **plan/dry-run mode** unless explicitly
enabled: `provision`/`deprovision` compute the deployment (a real, deployable Cloud
Run service resource + the routing handle) but make **no live GCP call**. Live
execution (``_execute``, wired to ``GcpRunClient``) is gated behind
`HUSSH_GCP_BACKEND_LIVE` + credentials; without them the backend stays in plan
mode. Turning it on makes real Cloud Run Admin API calls that create billable
resources, so it needs the founder's go. The live deploy -> orchestrate ->
teardown loop was validated in ``hushh-pda-dev`` on 2026-07-21 (slim-pod surface
split on 2026-07-22); scope was host lifecycle + access boundary + slim surface,
NOT per-user routing, the attested tier, or a PKM read through the pod (see
``docs/future/personal-agent/M4-LIVE-VALIDATION.md``).

Nothing here touches user data or consent: a spec carries only the opaque
HusshID/spaceID, the HMAC phone hash, the pod's PUBLIC key, and version pins. No
secret is ever baked into the rendered artifact -- BYOK model keys and per-turn
consent tokens arrive at runtime, never at deploy time.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Optional

from hushh_mcp.services.compute_backend import (
    BACKEND_GCP,
    TIER_DEDICATED,
    TIER_LOGICAL,
    BackendHandle,
    BackendStatus,
    PodSpec,
)

logger = logging.getLogger(__name__)

# Stable Hushh A2A address base (Layer A indirection). The agent is portable
# across backends without its address changing; the gateway resolves this to the
# current backend route.
A2A_ADDRESS_BASE = "https://a2a.hushh.ai/u"

_DNS_SAFE = re.compile(r"[^a-z0-9-]+")


def _service_name(hushh_id: str) -> str:
    """A DNS-safe, deterministic Cloud Run service name for a HusshID.

    Cloud Run names are lowercase RFC1035 (start with a letter, <=63 chars). The
    HusshID is opaque base32; we lowercase, strip to ``[a-z0-9-]``, and prefix.
    """
    slug = _DNS_SAFE.sub("-", str(hushh_id or "").lower()).strip("-")
    return f"one-pod-{slug}"[:63].rstrip("-")


class GcpBackend:
    """Provision a user's agent on GCP (Cloud Run; Confidential Space for the
    dedicated tier). Plan-mode by default; live execution is credential-gated."""

    backend_id = BACKEND_GCP

    def __init__(
        self,
        *,
        project: Optional[str] = None,
        region: Optional[str] = None,
        image: Optional[str] = None,
        service_account: Optional[str] = None,
        live: Optional[bool] = None,
        min_instances: Optional[int] = None,
        max_instances: Optional[int] = None,
        client: Any = None,
        credentials: Any = None,
    ) -> None:
        # All optional; plan mode tolerates missing config (renders placeholders).
        self._project = project if project is not None else _env("GOOGLE_CLOUD_PROJECT")
        self._region = (
            region if region is not None else (_env("AGENT_ONE_ADK_LOCATION") or "us-central1")
        )
        self._image = image if image is not None else _env("HUSSH_ONE_POD_IMAGE")
        self._service_account = (
            service_account
            if service_account is not None
            else _env("HUSSH_ONE_POD_SERVICE_ACCOUNT")
        )
        # Warm floor. A per-user agent must answer in real time, so the DEFAULT
        # minimum instance count is 1 -- no cold start on the agent endpoint (a
        # cold start on this ADK image is ~10s; see ROADMAP §min-instances). It is
        # configurable per tier: the 1B mass tier may set min=0 + fast wake to bound
        # cost, the dedicated/real-time tier keeps min>=1. max is clamped to >= min.
        self._min_instances = (
            min_instances if min_instances is not None else _int_env("HUSSH_POD_MIN_INSTANCES", 1)
        )
        self._max_instances = (
            max_instances if max_instances is not None else _int_env("HUSSH_POD_MAX_INSTANCES", 1)
        )
        if self._max_instances < self._min_instances:
            self._max_instances = self._min_instances
        # Live execution is OFF unless explicitly enabled AND credentials exist.
        self._live = bool(live) if live is not None else _flag("HUSSH_GCP_BACKEND_LIVE")
        # Live Cloud Run client: injected for tests; else built lazily from the SA.
        self._client = client
        self._credentials = credentials

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        """The deployable Cloud Run service resource for this user's pod.

        A real ``serving.knative.dev/v1`` Service body: internal-only ingress (the
        pod is reachable only via the Hushh A2A gateway), least-privilege service
        account, per-pod identity env (never secrets), and -- for the dedicated
        tier -- Confidential-Space annotations so the workload runs attested and
        Hushh cannot read it. Exact Confidential-Space annotation values are
        validated at live-enablement; the shape here is the deploy contract.
        """
        name = _service_name(spec.hushh_id)
        dedicated = spec.tier == TIER_DEDICATED
        template_annotations: dict[str, str] = {
            # Default minScale=1 -> the pod keeps a warm instance so the agent
            # endpoint answers in real time (no ~10s cold start). Per-tier tunable.
            "autoscaling.knative.dev/minScale": str(self._min_instances),
            "autoscaling.knative.dev/maxScale": str(self._max_instances),
        }
        if dedicated:
            # Confidential/attested tier markers (Apple-PCC parity: attested,
            # non-targetable). Validated against GCP at live-enablement.
            template_annotations["run.googleapis.com/confidential"] = "true"
            template_annotations["hussh/attested-tier"] = "true"
        container: dict[str, Any] = {
            "image": self._image or "",
            # Identity + pins only. No secrets: BYOK keys and consent tokens
            # arrive per-turn at runtime.
            "env": [
                {"name": "HUSSH_ID", "value": spec.hushh_id},
                {"name": "HUSSH_SPACE_ID", "value": spec.space_id or ""},
                {"name": "HUSSH_REGION", "value": spec.region or self._region},
                {"name": "HUSSH_RUNTIME_VERSION", "value": spec.runtime_version or ""},
                {"name": "HUSSH_PROMPT_VERSION", "value": spec.prompt_version or ""},
            ],
        }
        inner_spec: dict[str, Any] = {"containers": [container]}
        # Only pin a runtime service account when one is configured; an empty value
        # is rejected by the live API (and the project default is used otherwise).
        if self._service_account:
            inner_spec["serviceAccountName"] = self._service_account
        return {
            "apiVersion": "serving.knative.dev/v1",
            "kind": "Service",
            "metadata": {
                "name": name,
                "namespace": self._project or "",
                "labels": {
                    "app": "hussh-one-pod",
                    "hussh-space-id": spec.space_id or "",
                    "hussh-tier": spec.tier,
                },
                # internal ingress: the pod is never publicly reachable; only the
                # Hushh A2A gateway (Layer A) routes to it.
                "annotations": {"run.googleapis.com/ingress": "internal"},
            },
            "spec": {
                "template": {
                    "metadata": {"annotations": template_annotations},
                    "spec": inner_spec,
                }
            },
        }

    async def provision(self, spec: PodSpec) -> BackendHandle:
        """Provision the user's pod. Plan mode computes the handle from the rendered
        config with no side effect; live mode is credential-gated (not yet wired)."""
        config = self.render_deploy_config(spec)
        name = str(config["metadata"]["name"])
        route = f"{A2A_ADDRESS_BASE}/{spec.hushh_id}"
        metadata = {
            "project": self._project,
            "region": spec.region or self._region,
            "service": name,
            "image": self._image,
            "tier": spec.tier,
            "ingress": "internal",
        }
        if self._live:
            return await self._execute(spec, config)
        logger.info("gcp_backend.plan service=%s tier=%s", name, spec.tier)
        return BackendHandle(
            external_agent_id=name,
            a2a_route=route,
            status="planned",
            backend=self.backend_id,
            backend_metadata=metadata,
            attestation_ref=("pending-attestation" if spec.tier == TIER_DEDICATED else None),
        )

    async def deprovision(self, external_agent_id: str) -> None:
        if self._live:
            client = self._client or self._build_client()
            await asyncio.to_thread(client.delete_service, external_agent_id)
            logger.info("gcp_backend.live_deprovisioned service=%s", external_agent_id)
            return None
        logger.info("gcp_backend.plan_deprovision service=%s", external_agent_id)
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        if self._live:
            client = self._client or self._build_client()
            svc = await asyncio.to_thread(client.get_service, external_agent_id)
            conditions = ((svc or {}).get("status") or {}).get("conditions") or []
            ready = next((c for c in conditions if c.get("type") == "Ready"), None)
            healthy = bool(ready and ready.get("status") == "True")
            status = "gone" if svc is None else ("live" if healthy else "not_ready")
            return BackendStatus(
                external_agent_id=(external_agent_id or None), status=status, healthy=healthy
            )
        return BackendStatus(
            external_agent_id=(external_agent_id or None), status="planned", healthy=True
        )

    async def health(self) -> bool:
        # Plan mode is always healthy; live health hits the Cloud Run API.
        return True

    def _build_client(self) -> Any:
        from hushh_mcp.services.gcp_run_client import GcpRunClient

        if not self._project:
            raise RuntimeError("GcpBackend live mode requires a project (GOOGLE_CLOUD_PROJECT)")
        return GcpRunClient(
            project=self._project, region=self._region, credentials=self._credentials
        )

    async def _execute(self, spec: PodSpec, config: dict[str, Any]) -> BackendHandle:
        """Live Cloud Run provisioning: create the service, wait for Ready, return
        the handle. Creates a billable Cloud Run service; reached only in live mode
        with credentials (HUSSH_GCP_BACKEND_LIVE + a resolvable SA)."""
        from hushh_mcp.services.gcp_run_client import GcpRunClient

        client = self._client or self._build_client()
        name = str(config["metadata"]["name"])

        def _run() -> tuple[bool, Optional[str]]:
            client.create_service(config)
            ready, svc = client.wait_ready(name)
            return ready, GcpRunClient.service_url(svc)

        ready, url = await asyncio.to_thread(_run)
        logger.info("gcp_backend.live_provisioned service=%s ready=%s", name, ready)
        return BackendHandle(
            external_agent_id=name,
            a2a_route=f"{A2A_ADDRESS_BASE}/{spec.hushh_id}",
            status="live" if ready else "deploying",
            backend=self.backend_id,
            backend_metadata={
                "project": self._project,
                "region": spec.region or self._region,
                "service": name,
                "url": url,
                "ready": ready,
                "tier": spec.tier,
                "ingress": "internal",
            },
            attestation_ref=("pending-attestation" if spec.tier == TIER_DEDICATED else None),
        )


def _env(name: str) -> Optional[str]:
    value = (os.getenv(name) or "").strip()
    return value or None


def _int_env(name: str, default: int) -> int:
    """Parse a non-negative int env var; fall back to ``default`` on unset/garbage."""
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


def _flag(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}


# Keep the logical/dedicated tier names importable from this module too.
__all__ = ["GcpBackend", "TIER_LOGICAL", "TIER_DEDICATED", "A2A_ADDRESS_BASE"]
