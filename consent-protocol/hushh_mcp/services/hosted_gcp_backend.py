"""Managed private-pod adapter using the BYOC image and GCP lifecycle primitives.

Only pure deployment planning is admitted so far. New resources, upgrades and
deletion stay refused until durable hosted admission and erasure qualify; neither
a deployment object nor a live flag supplies that missing authority.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.compute_backend import BACKEND_GCP, BackendHandle, BackendStatus, PodSpec
from hushh_mcp.services.hosted_tier_guard import HostedTierNotPermittedError
from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment
from hushh_mcp.services.user_gcp_backend import UserGcpBackend


class HostedGcpBackend:
    """Reuse common rendering while keeping managed ownership explicit."""

    backend_id = BACKEND_GCP

    def __init__(self, *, deployment: PrivateGcpDeployment) -> None:
        deployment.validate()
        if deployment.hosting_mode != "hussh_hosted" or deployment.environment != "dev":
            raise ValueError("Hosted pod qualification is restricted to explicit dev authority")
        self._deployment = deployment
        self._inner = UserGcpBackend(
            user_project=deployment.project,
            user_region=deployment.region,
            image=deployment.image,
            hushh_invoker_sa=deployment.hub_principal,
            hushh_id=deployment.owner,
            min_instances=0,
            live=False,
            private_deployment=deployment,
        )

    @property
    def live(self) -> bool:
        return False

    async def health(self) -> bool:
        return False

    async def get(self, external_agent_id: str) -> BackendStatus:
        return BackendStatus(
            external_agent_id=external_agent_id, status="unqualified", healthy=False
        )

    def render_deploy_config(
        self,
        spec: PodSpec,
        *,
        image_digest: str | None = None,
    ) -> dict[str, Any]:
        expected = self._deployment
        digest = expected.image.rsplit("@", 1)[1]
        expected.require_hosted_spec(spec)
        if image_digest not in {None, digest}:
            raise ValueError("Hosted pod specification differs from assigned authority")
        result: dict[str, Any] = self._inner.render_deploy_config(spec, image_digest=digest)
        # The shared base renderer reads the current deployment lane. It may never
        # override the environment captured in the managed assignment.
        expected.verify_observation(result)
        return result

    def render_bootstrap_plan(self, spec: PodSpec) -> dict[str, Any]:
        self.render_deploy_config(spec)
        plan: dict[str, Any] = self._inner.render_bootstrap_plan(spec)
        return plan

    async def provision(self, spec: PodSpec) -> BackendHandle:
        raise HostedTierNotPermittedError(
            "Hosted pod creation requires transactional project/cost admission and live qualification"
        )

    async def upgrade(self, spec: PodSpec) -> BackendHandle:
        raise HostedTierNotPermittedError("Hosted pod update authority is not yet qualified")

    async def restart(self, spec: PodSpec) -> dict[str, Any]:
        raise HostedTierNotPermittedError("Hosted pod maintenance authority is not yet qualified")

    async def deprovision(self, external_agent_id: str) -> None:
        raise HostedTierNotPermittedError("Hosted pod erasure receipts are not yet qualified")


def hosted_backend_for_spec(spec: PodSpec) -> HostedGcpBackend:
    """Resolve only an explicitly bound managed placement, then validate its spec."""
    if spec.deployment_target != BACKEND_GCP or spec.private_gcp_deployment is None:
        raise ValueError("Managed GCP deployment cannot override another hosting target")
    backend = HostedGcpBackend(deployment=spec.private_gcp_deployment)
    backend.render_deploy_config(spec)
    return backend
