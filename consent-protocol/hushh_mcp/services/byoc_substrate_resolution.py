"""Resolve placement-specific substrate authority behind the stable lifecycle port."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from hushh_mcp.services.byoc_substrate import SubstrateEnsurer


def resolve_substrate(spec: Any) -> SubstrateEnsurer:
    """The substrate ensurer for THIS person's deployment target.

    Mirrors ``resolve_compute_backend_for_spec``: the same per-person question asked of
    the other half of the lifecycle. Anything without per-tenant infrastructure resolves
    to :class:`NoSubstrateRequired`, so the orchestrator calls ``ensure`` unconditionally
    and never branches on a provider name.
    """
    from hushh_mcp.runtime_settings import user_gcp_substrate_apply_enabled  # noqa: PLC0415
    from hushh_mcp.services.byoc_substrate import HushhFederatedSubstrate, NoSubstrateRequired
    from hushh_mcp.services.compute_backend import BACKEND_USER_GCP  # noqa: PLC0415

    if getattr(spec, "private_gcp_deployment", None) is not None:
        from hushh_mcp.services.hosted_gcp_substrate import resolve_hosted_substrate

        return resolve_hosted_substrate(spec)

    if (getattr(spec, "deployment_target", None) or "").strip() != BACKEND_USER_GCP:
        return NoSubstrateRequired()

    # From the SPEC, not the environment. These three used to be process-wide reads,
    # which made per-tenant infrastructure single-tenant: the bucket, the KMS key, the
    # signing secret and the pod service account were all created in whichever project
    # HUSSH_USER_GCP_PROJECT named, for every person. Env survives only as the
    # single-tenant dev fallback, and only when the spec is silent.
    project = (
        getattr(spec, "user_cloud_project", None) or os.getenv("HUSSH_USER_GCP_PROJECT") or ""
    ).strip()
    if not project:
        # Refused rather than defaulted. An empty project previously built a substrate
        # pointed at "", and provisioning then raised SubstrateNotReadyError naming a
        # STEP -- so the error described the symptom and never the cause.
        raise ValueError(
            "a user_gcp substrate needs the person's own project, and it is never "
            "inferred. There is no safe default here: the fallback would apply this "
            "person's infrastructure inside another person's cloud."
        )

    return HushhFederatedSubstrate(
        project=project,
        region=(
            getattr(spec, "user_cloud_region", None)
            or os.getenv("HUSSH_USER_GCP_REGION")
            or "us-central1"
        ).strip(),
        bootstrap_sa=(
            getattr(spec, "user_cloud_bootstrap_sa", None)
            or os.getenv("HUSSH_USER_GCP_BOOTSTRAP_SA")
            or ""
        ).strip(),
        dry_run=not user_gcp_substrate_apply_enabled(),
    )
