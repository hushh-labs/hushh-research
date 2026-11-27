"""Hosted Files use the existing private capability with managed custody."""

from copy import deepcopy

import pytest

from hushh_mcp.services.compute_backend import PodSpec


def hosted_files_fixture(monkeypatch):
    from dataclasses import replace

    from hushh_mcp.managed_ai_config import load_profile, profile_hash
    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from tests.hosted_pod_support import hosted_registry_row
    from tests.test_hosted_gcp_backend import _hosted_deployment

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    profile = load_profile("dev")
    row = hosted_registry_row(hushh_id="HA1HOSTED01", project="hussh-pilot-owner01")
    metadata = row["backend_metadata"]
    admission = metadata["provisionAttempt"]["hostedAdmission"]
    admission["modelBinding"] = {
        "provider": "gemini",
        "project": profile["project"],
        "model": profile["text_model"],
        "profileHash": profile_hash(profile),
    }
    federation = admission["assignment"]["bootstrapContract"]["plan"]["federation"]["impersonation"]
    federation["granted_to"] = "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    image = metadata["provisionAttempt"]["evidence"]["host_requested"]["creationAcknowledgement"][
        "initialImage"
    ]
    deployment = replace(
        _hosted_deployment(),
        image=image,
        service_uid=metadata["serviceUid"],
        project_number="100000000001",
        inference_project=profile["project"],
        inference_model=profile["text_model"],
        inference_profile_hash=profile_hash(profile),
    )
    spec = PodSpec(
        hushh_id=deployment.owner,
        phone_e164_hash="opaque",
        pod_pubkey="public",
        region=deployment.region,
        deployment_target="gcp",
        expected_service_uid=deployment.service_uid,
        provision_attempt_id="d" * 32,
    )
    service = HostedGcpBackend(deployment=deployment).render_deploy_config(spec)
    service["metadata"].update(uid=deployment.service_uid, generation=7)
    row.update(external_agent_id=metadata["service"], phone_e164_hash="opaque", pod_pubkey="public")
    metadata["image"] = image
    metadata["substrateReceipt"] = {
        "applied": True,
        "tenantRef": f"{deployment.project}/{deployment.region}",
        "plannedResources": [
            {"type": "gcs_bucket", "id": deployment.bucket},
            {"type": "kms_key", "id": deployment.kms_key.rsplit("/", 1)[-1]},
        ],
        "resourceObservations": [
            {
                "type": "kms_key",
                "id": deployment.kms_key.rsplit("/", 1)[-1],
                "disposition": "created",
                "identity": {
                    "name": deployment.kms_key,
                    "purpose": "ENCRYPT_DECRYPT",
                    "createTime": "2026-09-01T00:00:00Z",
                },
            },
            {
                "type": "gcs_bucket",
                "id": deployment.bucket,
                "disposition": "created",
                "identity": {
                    "name": deployment.bucket,
                    "generation": "1",
                    "projectNumber": deployment.project_number,
                    "timeCreated": "2026-09-01T00:00:00Z",
                },
            },
        ],
    }
    target = "gcr.io/hushh-pda-dev/consent-protocol-pod@sha256:" + "b" * 64
    return row, target, service, deployment


def test_hosted_files_plan_keeps_managed_custody_and_refuses_substitution(monkeypatch):
    from dataclasses import replace

    from hushh_mcp.services.pod_files.capability_update import plan_from_observation
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    row, target, service, deployment = hosted_files_fixture(monkeypatch)
    plan = plan_from_observation(row, target, service)
    assert (plan.project, plan.runtimeAccount, plan.modelProject) == (
        deployment.project,
        deployment.runtime_principal,
        deployment.model_project,
    )
    assert plan.devModelProject is None
    assert not any(row.get(key) for key in row if key.startswith("user_cloud_"))
    desired = deepcopy(service)
    plan.apply_configuration(existing=service, desired=desired)
    plan.require_installed(desired, hosted=True)
    unmarked = deepcopy(desired)
    env = unmarked["spec"]["template"]["spec"]["containers"][0]["env"]
    env[:] = [entry for entry in env if entry["name"] != HOSTING_ENV]
    with pytest.raises(ValueError, match="hosted placement is missing"):
        plan.require_installed(unmarked, hosted=True)
    wrong_owner = deepcopy(row)
    wrong_owner["user_id"] = "different-owner"
    with pytest.raises(ValueError):
        plan.require_owner(wrong_owner, target)
    changed = deepcopy(service)
    entries = changed["spec"]["template"]["spec"]["containers"][0]["env"]
    next(item for item in entries if item["name"] == HOSTING_ENV)["value"] = "{}"
    with pytest.raises(ValueError):
        plan_from_observation(row, target, changed)
    initial = deepcopy(service)
    entries = initial["spec"]["template"]["spec"]["containers"][0]["env"]
    next(item for item in entries if item["name"] == HOSTING_ENV)["value"] = replace(
        deployment, service_uid=None
    ).encoded()
    assert plan_from_observation(row, target, initial).serviceUid == deployment.service_uid


@pytest.mark.parametrize("defect", ["project", "uid", "runtime", "bucket", "kms", "duplicate"])
def test_hosted_files_offer_refuses_foreign_cloud_observations(monkeypatch, defect):
    from hushh_mcp.services.pod_files.capability_update import plan_from_observation

    row, target, service, _ = hosted_files_fixture(monkeypatch)
    template = service["spec"]["template"]["spec"]
    entries = template["containers"][0]["env"]
    if defect == "project":
        row["backend_metadata"]["project"] = "foreign-project"
    elif defect == "uid":
        service["metadata"]["uid"] = "different-incarnation"
    elif defect == "runtime":
        template["serviceAccountName"] = "other@foreign-project.iam.gserviceaccount.com"
    elif defect == "duplicate":
        entries.append(dict(entries[0]))
    else:
        key = "POD_STORAGE_GCS_BUCKET" if defect == "bucket" else "HUSSH_POD_KMS_KEY"
        next(item for item in entries if item["name"] == key)["value"] = "foreign-resource"
    with pytest.raises(ValueError):
        plan_from_observation(row, target, service)
