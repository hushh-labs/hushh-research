"""Hosted metadata stays signed, sealed and bound to its current owner placement."""

import pytest
from fastapi import HTTPException

from hushh_mcp.services.pod_owner_read_ports import OwnerFeedLocationPort, owner_read_ports
from tests.test_hosted_gcp_backend import _hosted_deployment
from tests.test_pod_owner_feed import (
    LOCATION,
    OWNER,
    POD,
    _open,
    _row,
    _serve,
)
from tests.test_pod_owner_feed import (
    agent as agent,
)
from tests.test_user_gcp_model_access_boundary import _spec


@pytest.mark.parametrize("drift", [False, True])
async def test_hosted_feed_keeps_exact_placement_across_a_blocking_read(agent, drift):
    from tests.hosted_pod_support import hosted_registry_row

    row = hosted_registry_row(owner=OWNER, hushh_id=POD)
    row.update(
        {
            key: value
            for key, value in _row(agent).items()
            if key in {"pod_signing_key_id", "pod_key_id", "pod_pubkey"}
        }
    )

    async def read(kind, owner_id, **kwargs):
        if drift:
            row["backend_metadata"]["provisionAttempt"]["hostedAdmission"]["assignment"][
                "extraAuthority"
            ] = "changed"
        return LOCATION

    if drift:
        with pytest.raises(HTTPException) as exc:
            await _serve(agent, row=row, reader=read)
        assert exc.value.status_code == 403
    else:
        served = await _serve(agent, row=row, reader=read)
        assert _open(agent, served)["projection"] == LOCATION


async def test_hosted_without_feed_keys_never_falls_back_to_a_hub_door(monkeypatch):
    from hushh_mcp.services import pod_owner_feed_client
    from tests.hosted_pod_support import install_hosted_runtime

    install_hosted_runtime(monkeypatch)
    monkeypatch.setattr(pod_owner_feed_client, "owner_feed_enabled", lambda: False)
    ports = owner_read_ports(OWNER, {"location": "synthetic-hub-token"})
    assert ports.feed is None
    assert isinstance(ports.location, OwnerFeedLocationPort)
    from hushh_mcp.services.pod_specialist_runtime import PodSpecialistInformationUnavailable

    with pytest.raises(PodSpecialistInformationUnavailable):
        ports.location.list_state(user_id=OWNER)


@pytest.mark.parametrize("drift", [None, "attempt", "owner", "image", "uid"])
async def test_lost_creation_ack_reconciles_exact_service_without_create_or_replace(
    monkeypatch, drift
):
    from copy import deepcopy
    from dataclasses import replace
    from types import SimpleNamespace
    from unittest.mock import Mock

    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from hushh_mcp.services.hosted_provision_recovery import prepare_live_host
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    deployment = _hosted_deployment()
    receipts = []
    spec = replace(
        _spec(),
        hushh_id=deployment.owner,
        deployment_target="gcp",
        provision_attempt_id="d" * 32,
        on_provision_ack=receipts.append,
    )
    renderer = HostedGcpBackend(deployment=deployment)
    service = renderer.render_deploy_config(spec)
    service["metadata"].update(uid="original-uid", generation=1)
    if drift == "attempt":
        service["metadata"]["labels"]["hussh-provision-attempt"] = "e" * 32
    elif drift == "owner":
        service["metadata"]["name"] = "foreign-service"
    elif drift == "image":
        service["spec"]["template"]["spec"]["containers"][0]["image"] = "foreign-image"
    elif drift == "uid":
        spec = replace(
            spec,
            expected_service_uid="recorded-foreign-uid",
            private_gcp_deployment=replace(deployment, service_uid="recorded-foreign-uid"),
        )
    else:
        spec = replace(spec, private_gcp_deployment=deployment)
    if spec.private_gcp_deployment is None:
        spec = replace(spec, private_gcp_deployment=deployment)
    client = SimpleNamespace(
        get_service=Mock(return_value=deepcopy(service)),
        create_service=Mock(),
        replace_service=Mock(),
    )
    backend = SimpleNamespace(
        _private_service_name=lambda _: service["metadata"]["name"],
        _client=lambda: client,
        _ensure_pod_image=lambda *_: "sha256:" + "a" * 64,
        render_deploy_config=renderer.render_deploy_config,
        backend_id="gcp",
    )
    if drift:
        with pytest.raises(ProvisionReconciliationRequired):
            await prepare_live_host(backend, spec)
        assert receipts == []
    else:
        await prepare_live_host(backend, spec)
        assert receipts[0]["serviceUid"] == "original-uid"
        assert receipts[0]["initialImage"] == deployment.image
    client.create_service.assert_not_called()
    client.replace_service.assert_not_called()


def test_managed_cloud_client_rechecks_authority_before_every_request():
    from types import SimpleNamespace
    from unittest.mock import Mock

    from hushh_mcp.services.hosted_run_client import private_run_client

    guard = Mock(side_effect=[None, RuntimeError("revoked")])
    client = private_run_client(
        "owner-project",
        "us-central1",
        SimpleNamespace(valid=True, token="synthetic"),  # noqa: S106 -- inert credential double
        guard,
    )
    assert client._headers()["Content-Type"] == "application/json"
    with pytest.raises(RuntimeError, match="revoked"):
        client._headers()
    assert guard.call_count == 2


@pytest.mark.parametrize("operation", ["provision", "cleanup", "foreign-owner"])
async def test_managed_erasure_checks_operation_and_fresh_authority_before_credentials(
    monkeypatch, operation
):
    from dataclasses import replace

    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services import user_gcp_bootstrap
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

    def revoked():
        raise RuntimeError("retained authority changed")

    def forbidden(**kwargs):
        pytest.fail("Unadmitted cleanup must not mint cloud credentials")

    monkeypatch.setattr(user_gcp_bootstrap, "mint_bootstrap_token", forbidden)
    authority = HostedGcpAuthority(
        deployment=deployment,
        source_image="gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "a" * 64,
        bootstrap_sa=f"one-bootstrap@{deployment.project}.iam.gserviceaccount.com",
        check=(lambda: None) if operation == "foreign-owner" else revoked,
        operation="cleanup" if operation == "foreign-owner" else operation,
        operation_id="d" * 32,
        execute=True,
    )
    backend = HostedGcpBackend(deployment=deployment, authority=authority)
    if operation == "foreign-owner":
        with pytest.raises(ValueError, match="assigned authority"):
            await backend.erase_compute(
                replace(
                    _spec(),
                    deployment_target="gcp",
                    hushh_id="foreign-owner",
                    expected_service_uid="foreign-service",
                )
            )
        return
    with pytest.raises(RuntimeError, match="fenced erasure|authority changed"):
        await backend.erase_bucket(action={}, state={}, retain_receipt=lambda *args: True)


def test_upgrade_recovery_uses_frozen_policy_and_exact_writer_operation(monkeypatch):
    from copy import deepcopy
    from dataclasses import replace
    from types import SimpleNamespace

    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services.gcp_upgrade_observation import verified_capabilities
    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from tests.test_hosted_gcp_backend import _spec as hosted_spec

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    profile = load_profile("dev")
    deployment = replace(
        _hosted_deployment(),
        inference_project=profile["project"],
        inference_model=profile["text_model"],
        inference_profile_hash=profile_hash(profile),
    )
    spec = replace(
        hosted_spec(),
        hushh_id=deployment.owner,
        deployment_target="gcp",
        upgrade_operation_id="approved-operation",
        private_gcp_deployment=deployment,
    )
    service = HostedGcpBackend(deployment=deployment).render_deploy_config(spec)
    assert verified_capabilities(spec, service) == {}
    wrong = deepcopy(service)
    entries = wrong["spec"]["template"]["spec"]["containers"][0]["env"]
    next(item for item in entries if item["name"] == "HUSSH_POD_WRITER_OPERATION")["value"] = (
        "older-operation"
    )
    with pytest.raises(ValueError, match="approved handoff"):
        verified_capabilities(spec, wrong)
    assert verified_capabilities(spec, wrong, replacement=False) == {}

    def retired(_):
        raise ValueError("profile retired")

    monkeypatch.setattr("hushh_mcp.managed_ai_config.load_profile", retired)
    with pytest.raises(ValueError, match="profile retired"):
        verified_capabilities(spec, service)
    inspection = replace(spec, hosted_admission_guard=SimpleNamespace(operation="inspect"))
    assert verified_capabilities(inspection, service) == {}
    entries = service["spec"]["template"]["spec"]["containers"][0]["env"]
    next(item for item in entries if item["name"] == "GOOGLE_CLOUD_PROJECT")["value"] = (
        "foreign-project"
    )
    with pytest.raises(ValueError, match="admitted authority"):
        verified_capabilities(inspection, service)


@pytest.mark.parametrize("disposition", ["added", "already_present"])
def test_operator_model_cleanup_preserves_other_members_and_preexisting_grants(disposition):
    from copy import deepcopy
    from unittest.mock import Mock

    from hushh_mcp.services.hosted_model_grant_cleanup import _remove_binding

    member = "serviceAccount:pod@pilot-project.iam.gserviceaccount.com"
    policy = {
        "etag": "first",
        "version": 3,
        "bindings": [
            {
                "role": "roles/aiplatform.user",
                "members": [member, "serviceAccount:peer@other-project.iam.gserviceaccount.com"],
            }
        ],
    }

    class Session:
        def __init__(self):
            self.writes = []

        def post(self, url, **kwargs):
            nonlocal policy
            if url.endswith(":setIamPolicy"):
                self.writes.append(deepcopy(kwargs["json"]))
                assert kwargs["json"]["policy"]["etag"] == "first"
                policy = deepcopy(kwargs["json"]["policy"])
                policy["etag"] = "second"
            return Mock(status_code=200, json=lambda: deepcopy(policy))

    session = Session()
    base = {
        "runtimeIdentity": {"email": member.removeprefix("serviceAccount:"), "uniqueId": "123"},
        "bindingObservation": {
            "policyResource": "https://cloudresourcemanager.googleapis.com/v1/projects/model-project:getIamPolicy",
            "member": member,
            "role": "roles/aiplatform.user",
            "disposition": disposition,
        },
    }
    assert _remove_binding(session, "synthetic", base) is (disposition == "added")
    assert (
        "serviceAccount:peer@other-project.iam.gserviceaccount.com"
        in policy["bindings"][0]["members"]
    )
    assert (member in policy["bindings"][0]["members"]) is (disposition == "already_present")
    assert len(session.writes) == (1 if disposition == "added" else 0)
    assert not _remove_binding(session, "synthetic", base)


def test_project_retirement_refuses_changed_identity_before_mutation():
    from unittest.mock import Mock

    from hushh_mcp.services.hosted_project_retirement import _retire
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

    creation = {
        "projectId": "pilot-project",
        "projectNumber": "123",
        "lifecycleState": "ACTIVE",
        "labels": {"hussh-provision-attempt": "admitted"},
    }
    response = {**creation, "projectNumber": "456"}
    session = Mock()
    session.get.return_value = Mock(status_code=200, json=lambda: response)
    with pytest.raises(ProvisionReconciliationRequired, match="incarnation"):
        _retire(session, "synthetic", creation, "billingAccounts/admitted")
    session.put.assert_not_called()
    session.request.assert_not_called()


def test_operator_identity_checks_authenticated_subject_not_a_supplied_email():
    from unittest.mock import Mock

    from hushh_mcp.services.hosted_operator_identity import verify_operator
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

    credentials = Mock()
    credentials.token = "synthetic"
    session = Mock()
    session.get.return_value = Mock(
        status_code=200,
        json=lambda: {"email": "foreign@example.test", "email_verified": True, "sub": "foreign"},
    )
    with pytest.raises(ProvisionReconciliationRequired, match="retained identity"):
        verify_operator(credentials, session, expected="user:operator@example.test")
    session.get.return_value = Mock(
        status_code=200,
        json=lambda: {"email": "operator@example.test", "email_verified": True, "sub": "operator"},
    )
    verified = verify_operator(credentials, session, expected="user:operator@example.test")
    assert verified.principal == "user:operator@example.test"
    assert "synthetic" not in repr(verified)
