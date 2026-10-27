"""Managed private-pod adapter using the BYOC image and GCP lifecycle primitives.

Only pure deployment planning is admitted so far. New resources, upgrades and
deletion stay refused until durable hosted admission and erasure qualify; neither
a deployment object nor a live flag supplies that missing authority.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.compute_backend import BACKEND_GCP, BackendHandle, BackendStatus, PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.hosted_tier_guard import HostedTierNotPermittedError
from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment


class HostedGcpBackend:
    """Reuse common rendering while keeping managed ownership explicit."""

    backend_id = BACKEND_GCP

    def __init__(self, *, deployment: PrivateGcpDeployment) -> None:
        deployment.validate()
        if deployment.hosting_mode != "hussh_hosted" or deployment.environment != "dev":
            raise ValueError("Hosted pod qualification is restricted to explicit dev authority")
        self._deployment = deployment
        self._inner = GcpBackend(
            project=deployment.project,
            region=deployment.region,
            image=deployment.image,
            min_instances=0,
            max_instances=1,
            live=False,
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
        from hushh_mcp.services.private_gcp_deployment import render_private_gcp_service

        expected = self._deployment
        digest = expected.image.rsplit("@", 1)[1]
        if (
            spec.hushh_id != expected.owner
            or spec.deployment_target != BACKEND_GCP
            or spec.region not in {None, expected.region}
            or spec.expected_service_uid != expected.service_uid
            or image_digest not in {None, digest}
            or any(
                (
                    spec.user_cloud_project,
                    spec.user_cloud_region,
                    spec.user_cloud_bootstrap_sa,
                    spec.user_cloud_tenant_id,
                    spec.user_cloud_subscription_id,
                    spec.user_cloud_resource_group,
                    spec.azure_vm_host,
                )
            )
        ):
            raise ValueError("Hosted pod specification differs from assigned authority")
        config = self._inner.render_deploy_config(spec)
        result = render_private_gcp_service(config, spec=spec, deployment=expected, immutable=True)
        # The shared base renderer reads the current deployment lane. It may never
        # override the environment captured in the managed assignment.
        expected.verify_observation(result)
        return result

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
