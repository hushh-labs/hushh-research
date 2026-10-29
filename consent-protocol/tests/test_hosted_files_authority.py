"""Managed Files mutations remain bound to a fresh, qualified authority."""

import pytest

from tests.test_hosted_gcp_backend import _hosted_deployment
from tests.test_user_gcp_model_access_boundary import _spec


def _hosted_files_operation(monkeypatch, operation, check):
    from dataclasses import replace

    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services.gcp_backend import _service_name
    from hushh_mcp.services.hosted_gcp_authority import HostedGcpAuthority
    from hushh_mcp.services.pod_files.capability_update import plan_from_observation
    from tests.test_pod_files_provisioning import legacy_files_fixture

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    profile = load_profile("dev")
    deployment = replace(
        _hosted_deployment(),
        project_number="123456789012",
        service_uid="synthetic-incarnation",
        inference_project=profile["project"],
        inference_model=profile["text_model"],
        inference_profile_hash=profile_hash(profile),
    )
    source = "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "a" * 64
    authority = HostedGcpAuthority(
        deployment=deployment,
        source_image=source,
        bootstrap_sa=f"one-bootstrap@{deployment.project}.iam.gserviceaccount.com",
        check=check,
        files_work_check=check,
        operation=operation,
        operation_id="d" * 32,
        execute=True,
    )
    row, image, observed = legacy_files_fixture()
    plan = plan_from_observation(row, image, observed).model_copy(
        update={
            "hushhId": deployment.owner,
            "service": _service_name(deployment.owner),
            "project": deployment.project,
            "region": deployment.region,
            "bootstrapAccount": authority.bootstrap_sa,
            "runtimeAccount": deployment.runtime_principal,
            "targetImage": source,
        }
    )
    spec = replace(
        _spec(),
        hushh_id=deployment.owner,
        deployment_target="gcp",
        expected_service_uid=deployment.service_uid,
        private_gcp_deployment=deployment,
        hosted_admission_guard=authority,
        upgrade_target_image=source,
        upgrade_operation_id=authority.operation_id,
        upgrade_attempt_id="e" * 32,
        files_upgrade_plan=plan.model_dump(),
        on_files_upgrade_checkpoint=lambda *_: None,
    )
    return plan, spec


@pytest.mark.parametrize("operation", ["inspect", "cleanup", "provision"])
def test_hosted_files_rejects_non_upgrade_authority_before_token(monkeypatch, operation):
    from hushh_mcp.services import user_gcp_bootstrap
    from hushh_mcp.services.pod_files.capability_bootstrap import apply_upgrade_configuration

    plan, spec = _hosted_files_operation(monkeypatch, operation, lambda: None)
    monkeypatch.setattr(
        user_gcp_bootstrap,
        "mint_bootstrap_token",
        lambda **_: pytest.fail("An unapproved Files operation minted a credential"),
    )
    with pytest.raises((ValueError, RuntimeError), match="authority|approved"):
        apply_upgrade_configuration(
            plan, None, spec, {}, {}, bootstrap_sa=plan.bootstrapAccount, service_name=plan.service
        )


@pytest.mark.parametrize(
    "defect", ["owner", "operation", "plan", "source", "revoked", "no-work-guard"]
)
def test_hosted_files_refuses_changed_approval_before_token(monkeypatch, defect):
    from dataclasses import replace

    from hushh_mcp.services import user_gcp_bootstrap
    from hushh_mcp.services.pod_files.capability_bootstrap import apply_upgrade_configuration

    def check():
        if defect == "revoked":
            raise RuntimeError("authority revoked")

    plan, spec = _hosted_files_operation(monkeypatch, "upgrade", check)
    if defect == "owner":
        spec = replace(spec, hushh_id="foreign-owner")
    elif defect == "operation":
        spec = replace(spec, upgrade_operation_id="another-operation")
    elif defect == "plan":
        spec = replace(spec, files_upgrade_plan={**plan.model_dump(), "bucket": "other-bucket"})
    elif defect == "source":
        spec = replace(spec, upgrade_target_image="foreign-image")
    elif defect == "no-work-guard":
        spec = replace(
            spec, hosted_admission_guard=replace(spec.hosted_admission_guard, files_work_check=None)
        )
    monkeypatch.setattr(
        user_gcp_bootstrap,
        "mint_bootstrap_token",
        lambda **_: pytest.fail("A changed Files approval minted a credential"),
    )
    with pytest.raises((ValueError, RuntimeError), match="authority|approved"):
        apply_upgrade_configuration(
            plan, None, spec, {}, {}, bootstrap_sa=plan.bootstrapAccount, service_name=plan.service
        )


def test_hosted_files_rechecks_authority_after_iam_read_before_write(monkeypatch):
    from unittest.mock import Mock

    import requests

    from hushh_mcp.services import user_gcp_bootstrap
    from hushh_mcp.services.pod_files.capability_bootstrap import (
        FilesCapabilityBootstrap,
        apply_upgrade_configuration,
    )

    revoked = False

    def guard():
        if revoked:
            raise RuntimeError("authority revoked")

    plan, spec = _hosted_files_operation(monkeypatch, "upgrade", guard)
    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", lambda **_: "synthetic")
    request = Mock(return_value=Mock(status_code=200))
    monkeypatch.setattr(requests, "request", request)
    monkeypatch.setattr(requests, "post", lambda url, **kwargs: request("POST", url, **kwargs))

    def simulate_iam(self, **_):
        nonlocal revoked
        self._session.post("https://example.test/resource:getIamPolicy")
        revoked = True
        self._session.post("https://example.test/resource:setIamPolicy")

    monkeypatch.setattr(FilesCapabilityBootstrap, "apply_delta", simulate_iam)
    with pytest.raises(RuntimeError, match="authority revoked"):
        apply_upgrade_configuration(
            plan, None, spec, {}, {}, bootstrap_sa=plan.bootstrapAccount, service_name=plan.service
        )
    assert request.call_count == 1
    assert request.call_args.args[1].endswith(":getIamPolicy")


def test_hosted_files_rechecks_gate_after_service_read_before_replacement(monkeypatch):
    from unittest.mock import Mock

    import requests

    from hushh_mcp.services.hosted_run_client import private_run_client

    schema_ready = True

    def guard():
        if not schema_ready:
            raise RuntimeError("Files recovery schema changed")

    _, spec = _hosted_files_operation(monkeypatch, "upgrade", guard)
    client = private_run_client(
        spec.private_gcp_deployment.project,
        spec.private_gcp_deployment.region,
        Mock(valid=True, token="synthetic"),  # noqa: S106 -- inert credential double
        spec.hosted_admission_guard,
    )
    # Read-only observation remains available; losing the reviewed schema
    # after the service read must prevent the following PUT.
    assert client._headers()["Content-Type"] == "application/json"

    def read_service(_):
        nonlocal schema_ready
        client._headers()
        schema_ready = False
        return {"metadata": {"uid": "synthetic-incarnation", "resourceVersion": "1"}}

    monkeypatch.setattr(client, "get_service", read_service)
    monkeypatch.setattr(client, "merge_for_replace", lambda *_args, **_kwargs: {})
    put = Mock()
    monkeypatch.setattr(requests, "put", put)
    with pytest.raises(RuntimeError, match="recovery schema changed"):
        client.replace_service("synthetic-service", {}, expected_uid="synthetic-incarnation")
    put.assert_not_called()


@pytest.mark.asyncio
async def test_hosted_files_rechecks_gate_before_image_copy_credentials(monkeypatch):
    import asyncio

    from hushh_mcp.services import pod_image_copy
    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    checks = 0

    def guard():
        nonlocal checks
        checks += 1
        if checks > 1:
            raise RuntimeError("Files recovery schema changed")

    _, spec = _hosted_files_operation(monkeypatch, "upgrade", guard)
    backend = HostedGcpBackend(
        deployment=spec.private_gcp_deployment, authority=spec.hosted_admission_guard
    )
    monkeypatch.setattr(
        pod_image_copy,
        "attached_identity",
        lambda: pytest.fail("Unqualified image copy acquired credentials"),
    )

    async def proceed_to_copy(self, requested):
        return await asyncio.to_thread(self._ensure_pod_image, requested, "sha256:" + "a" * 64)

    monkeypatch.setattr(UserGcpBackend, "upgrade", proceed_to_copy)
    with pytest.raises(RuntimeError, match="recovery schema changed"):
        await backend.upgrade(spec)
    assert checks == 2


def test_hosted_files_rechecks_gate_after_image_read_before_copy(monkeypatch):
    from unittest.mock import Mock

    from hushh_mcp.services import pod_image_copy
    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend

    ready = True

    def guard():
        if not ready:
            raise RuntimeError("Files recovery schema changed")

    _, spec = _hosted_files_operation(monkeypatch, "upgrade", guard)
    backend = HostedGcpBackend(
        deployment=spec.private_gcp_deployment, authority=spec.hosted_admission_guard
    )
    monkeypatch.setattr(
        pod_image_copy,
        "attached_identity",
        lambda: ("synthetic", spec.private_gcp_deployment.hub_principal),
    )

    def absent(*_args, **_kwargs):
        nonlocal ready
        ready = False
        return False

    monkeypatch.setattr(pod_image_copy, "image_exists", absent)
    copy = Mock()
    monkeypatch.setattr(pod_image_copy, "copy_image", copy)
    with pytest.raises(RuntimeError, match="recovery schema changed"):
        backend._ensure_pod_image(spec, "sha256:" + "a" * 64)
    copy.assert_not_called()
