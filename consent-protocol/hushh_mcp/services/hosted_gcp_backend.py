"""Managed placement of the common private GCP runtime and lifecycle primitives.

Unbound planning cannot create resources. Executable pilot bindings come only from
retained admission and carry exact project, image source and bootstrap authority.
The general hosted tier remains closed independently of this two-owner dev pilot.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.compute_backend import BACKEND_GCP, BackendHandle, BackendStatus, PodSpec
from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
from hushh_mcp.services.hosted_tier_guard import HostedTierNotPermittedError
from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment
from hushh_mcp.services.user_gcp_backend import UserGcpBackend


class HostedGcpBackend(UserGcpBackend):
    """Keep established provider ports while making managed authority explicit."""

    backend_id = BACKEND_GCP

    def __init__(
        self,
        *,
        deployment: PrivateGcpDeployment,
        authority: HostedGcpAuthority | None = None,
        publication_source: str | None = None,
    ) -> None:
        deployment.validate(
            frozen=bool(authority and authority.operation in {"cleanup", "inspect"})
        )
        if deployment.hosting_mode != "hussh_hosted" or deployment.environment != "dev":
            raise ValueError("Hosted pod qualification is restricted to explicit dev authority")
        if authority is not None and authority.deployment != deployment:
            raise ValueError("Managed controller differs from its deployment assignment")
        if publication_source is not None and (
            publication_source.rsplit("@", 1)[-1] != deployment.image.rsplit("@", 1)[-1]
            or (authority is not None and publication_source != authority.source_image)
        ):
            raise ValueError("Managed publication source differs from the assigned digest")
        live = bool(authority and authority.execute)
        if authority is not None and authority.execute:
            authority.validate_execution()
        self._deployment, self._authority = deployment, authority
        super().__init__(
            user_project=deployment.project,
            user_region=deployment.region,
            image=authority.source_image if authority else (publication_source or deployment.image),
            bootstrap_sa=authority.bootstrap_sa if authority else "",
            hushh_invoker_sa=deployment.hub_principal,
            hushh_id=deployment.owner,
            min_instances=0,
            live=live,
            private_deployment=deployment,
            require_private_admission=authority,
        )

    @property
    def live(self) -> bool:
        return bool(self._live)

    async def health(self) -> bool:
        return self.live

    async def get(self, external_agent_id: str) -> BackendStatus:
        if self.live:
            return await super().get(external_agent_id)
        return BackendStatus(
            external_agent_id=external_agent_id, status="unqualified", healthy=False
        )

    def render_deploy_config(
        self, spec: PodSpec, *, image_digest: str | None = None
    ) -> dict[str, Any]:
        expected = self._deployment
        digest = expected.image.rsplit("@", 1)[1]
        expected.require_hosted_spec(spec)
        if image_digest not in {None, digest}:
            raise ValueError("Hosted pod specification differs from assigned authority")
        result: dict[str, Any] = super().render_deploy_config(spec, image_digest=digest)
        if spec.provision_attempt_id:
            result["metadata"]["labels"]["hussh-provision-attempt"] = spec.provision_attempt_id
        expected.verify_observation(result, require_uid=False)
        return result

    def _require_execution(self, *, creation: bool = False) -> None:
        if not self.live or self._authority is None:
            raise HostedTierNotPermittedError(
                "Hosted lifecycle requires transactional admission and qualified execution"
            )
        if creation and self._authority.operation != "provision":
            raise HostedTierNotPermittedError("Cleanup authority cannot create or update a pod")

    async def provision(self, spec: PodSpec) -> BackendHandle:
        self._require_execution(creation=True)
        if self._authority is None or spec.provision_attempt_id != self._authority.operation_id:
            raise HostedTierNotPermittedError("Managed provision operation changed")
        from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

        try:
            return await super().provision(spec)
        except ProvisionReconciliationRequired:
            raise
        except Exception:
            raise ProvisionReconciliationRequired(
                "Managed provision requires provider reconciliation"
            ) from None

    def require_host_ready(self, spec: PodSpec, *, substrate_applied: bool) -> None:
        from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

        self._deployment.require_hosted_spec(spec)
        if not substrate_applied:
            raise ProvisionReconciliationRequired(
                "Managed bootstrap requires provider reconciliation"
            )
        if self._authority is None or self._authority.operation != "provision":
            raise ProvisionReconciliationRequired(
                "Managed bootstrap is retained; exact workload model grants are pending"
            )

    async def upgrade(self, spec: PodSpec) -> BackendHandle:
        self._require_execution()
        if (
            self._authority is None
            or self._authority.operation != "upgrade"
            or spec.upgrade_operation_id != self._authority.operation_id
        ):
            raise HostedTierNotPermittedError(
                "Managed update requires its owner-approved update lease"
            )
        return await super().upgrade(spec)

    async def deprovision(self, external_agent_id: str) -> None:
        raise HostedTierNotPermittedError(
            "Managed deletion requires the fenced owner erasure journal, not a service name"
        )


def hosted_backend_for_spec(spec: PodSpec) -> HostedGcpBackend:
    """Resolve only a server-bound private placement; an ordinary flag is insufficient."""
    if spec.deployment_target != BACKEND_GCP or spec.private_gcp_deployment is None:
        raise ValueError("Managed GCP deployment cannot override another hosting target")
    guard = spec.hosted_admission_guard
    if guard is not None and not isinstance(guard, HostedGcpAuthority):
        raise ValueError("Managed execution needs a typed retained controller binding")
    backend = HostedGcpBackend(deployment=spec.private_gcp_deployment, authority=guard)
    if guard is None or guard.operation not in {"cleanup", "inspect"}:
        backend.render_deploy_config(spec)
    return backend
