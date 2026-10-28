"""Managed placement binds the existing substrate executor to its durable attempt."""

from __future__ import annotations

from hushh_mcp.services.byoc_substrate import HushhFederatedSubstrate
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
from hushh_mcp.services.hosted_gcp_backend import hosted_backend_for_spec
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


def resolve_hosted_substrate(spec: PodSpec) -> HushhFederatedSubstrate:
    backend = hosted_backend_for_spec(spec)
    authority = spec.hosted_admission_guard
    if (
        not isinstance(authority, HostedGcpAuthority)
        or not authority.execute
        or authority.operation not in {"bootstrap", "provision"}
        or authority.continuation is None
        or spec.provision_attempt_id != authority.operation_id
    ):
        raise ProvisionReconciliationRequired(
            "Managed substrate requires retained execution and bootstrap checkpoints"
        )
    authority.validate_execution()
    return HushhFederatedSubstrate(
        project=authority.deployment.project,
        region=authority.deployment.region,
        bootstrap_sa=authority.bootstrap_sa,
        plan_renderer=backend.render_bootstrap_plan,
        dry_run=False,
        continuation=authority.continuation,
        token_minter=lambda **kwargs: _admitted_token(authority, **kwargs),
    )


def _admitted_token(authority: HostedGcpAuthority, *, bootstrap_sa: str) -> str:
    if (
        authority.operation not in {"bootstrap", "provision"}
        or bootstrap_sa != authority.bootstrap_sa
    ):
        raise ProvisionReconciliationRequired("Managed bootstrap identity changed")
    authority()
    from hushh_mcp.services.user_gcp_bootstrap import mint_bootstrap_token

    return mint_bootstrap_token(bootstrap_sa=bootstrap_sa)
