"""Retained cleanup survives retirement of its model profile."""

import pytest

from tests.test_hosted_gcp_backend import _hosted_deployment
from tests.test_user_gcp_model_access_boundary import _spec


@pytest.mark.parametrize("operation", ["inspect", "cleanup", "provision", "upgrade"])
def test_retired_profile_preserves_only_retained_inspection_and_cleanup(monkeypatch, operation):
    from dataclasses import replace

    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    profile = load_profile("dev")
    deployment = replace(
        _hosted_deployment(),
        project_number="123456789012",
        inference_project=profile["project"],
        inference_model=profile["text_model"],
        inference_profile_hash=profile_hash(profile),
    )
    authority = HostedGcpAuthority(
        deployment=deployment,
        source_image="gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "a" * 64,
        bootstrap_sa=f"one-bootstrap@{deployment.project}.iam.gserviceaccount.com",
        check=lambda: None,
        operation=operation,
        operation_id="d" * 32,
        execute=True,
    )

    def retired(_):
        raise ValueError("profile retired")

    monkeypatch.setattr("hushh_mcp.managed_ai_config.load_profile", retired)
    if operation in {"provision", "upgrade"}:
        with pytest.raises(ValueError, match="profile retired"):
            HostedGcpBackend(deployment=deployment, authority=authority)
        return
    backend = HostedGcpBackend(deployment=deployment, authority=authority)
    spec = replace(_spec(), hushh_id=deployment.owner, deployment_target="gcp")
    backend._validate_private_spec(spec)
    with pytest.raises(ValueError, match="assigned authority"):
        backend._validate_private_spec(replace(spec, hushh_id="different-owner"))
    if operation == "cleanup":

        class CallerGuard:
            operation = "cleanup"

            def __call__(self):
                pass

        from hushh_mcp.services.user_gcp_backend import UserGcpBackend

        unbound = replace(authority, deployment=replace(deployment, owner="other-owner"))
        for guard in (CallerGuard(), unbound):
            with pytest.raises(ValueError, match="profile retired"):
                UserGcpBackend(
                    user_project=deployment.project,
                    user_region=deployment.region,
                    hushh_invoker_sa=deployment.hub_principal,
                    hushh_id=deployment.owner,
                    private_deployment=deployment,
                    require_private_admission=guard,
                )
