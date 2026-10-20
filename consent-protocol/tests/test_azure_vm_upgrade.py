"""Exact owner update terms without exporting VM environment or replaying actions."""

from __future__ import annotations

import base64
import hashlib
import json
from copy import deepcopy
from dataclasses import replace

import pytest

from browser_runtime.azure_host import update
from hushh_mcp.services.azure_arm_client import API_VERSIONS
from hushh_mcp.services.azure_arm_mutations import body_commitment
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_vm_host_bundle import _SOURCE, replacement_step
from hushh_mcp.services.azure_vm_upgrade_plan import build_vm_image_update
from tests.test_azure_vm_host import installation
from tests.test_compute_backend import _vm_spec_and_metadata


def _approved():
    spec, metadata = _vm_spec_and_metadata()
    previous = installation()
    metadata.update(
        setupNonce="0" * 16,
        upgradeLease="synthetic-lease",
        vmConfigurationSha256=update.digest(previous),
        vmUpdateModuleSha256=hashlib.sha256((_SOURCE / "update.py").read_bytes()).hexdigest(),
    )
    source = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod/pod@sha256:" + "d" * 64
    cursor = {"seq": 2, "sha": "e" * 64}
    metadata["upgradeApproval"] = {
        "version": 1,
        "ownerId": "synthetic-owner",
        "hushhId": spec.hushh_id,
        "podIncarnation": spec.expected_service_uid,
        "targetImage": source,
        "operationId": "update_123",
        "releaseId": "dev-test",
        "idempotencyKey": "approval-1",
        "status": "updating",
        "handoffIdleRecord": cursor,
        "handoffIncarnation": spec.expected_service_uid,
        "handoffRuntimeEpoch": "synthetic-runtime",
        "handoffCommittedCursor": {"seq": 1, "sha": "a" * 64},
        "handoffCommittedState": hashlib.sha256(
            f"update_123|{spec.expected_service_uid}|1|{'a' * 64}|active=0".encode()
        ).hexdigest(),
    }
    spec = replace(
        spec,
        upgrade_operation_id="update_123",
        upgrade_target_image=source,
        upgrade_attempt_id=hashlib.sha256(b"synthetic-lease").hexdigest(),
    )
    row = {
        "user_id": "synthetic-owner",
        "placement_epoch": 0,
        "hushh_id": spec.hushh_id,
        "status": "provisioned",
        "backend": "user_azure",
        "deployment_target": "user_azure",
        "external_agent_id": spec.azure_vm_host.installation.resource_id,
        "pod_pubkey": spec.pod_pubkey,
        "pod_key_id": "synthetic-key",
        "pod_signing_key_id": "pods_" + "f" * 32,
        "pod_signing_pubkey": "synthetic-public",
        "backend_metadata": metadata,
        **{
            "user_cloud_" + key: getattr(spec, "user_cloud_" + key)
            for key in ("tenant_id", "subscription_id", "resource_group", "region")
        },
    }
    return row, spec, previous, cursor


def test_vm_plan_commits_actual_import_wrapper_and_tag_without_host_configuration(monkeypatch):
    monkeypatch.delenv("HUSSH_AZURE_POD_IMAGE_REPOSITORY", raising=False)
    row, spec, previous, cursor = _approved()
    credentials = {"username": "oauth2accesstoken", "password": "synthetic-ephemeral-reader"}
    plan = build_vm_image_update(row, spec, idle_record=cursor, source_credentials=credentials)
    credentials["password"] = "changed-after-plan"
    steps, intent = plan.steps(), plan.intent(job="hosted-1")
    assert len(steps) == 3 and [s.stage for s in steps] == [
        "vm_image_import",
        "vm_image_replace",
        "vm_image_tag",
    ]
    assert steps[0].body["untaggedTargetRepositories"] == ["pod"]
    assert steps[0].body["source"]["credentials"]["password"] == "synthetic-ephemeral-reader"
    assert steps[2].body == {
        "operation": "Merge",
        "properties": {"tags": {"husshPodImage": "sha256:" + "d" * 64}},
    }
    for step, allowed in zip(steps, intent["allowedRequests"], strict=True):
        assert allowed == {
            "method": step.method,
            "path": step.path,
            "apiVersion": API_VERSIONS[step.api],
            "purpose": step.stage,
            "bodySha256": body_commitment(step.body),
        }
    expected, _ = replacement_step(
        previous, image=plan.target_image, operation_id="update_123", idle_record=cursor
    )
    assert steps[1].body == expected.body  # same host protocol, no configuration export
    raw = steps[1].body["script"][0].split("HUSSH_IMAGE_UPDATE'\n", 1)[1].split("\n", 1)[0]
    payload = json.loads(base64.b64decode(raw))
    assert update.target(previous, payload)["image"] == plan.target_image
    changed = deepcopy(previous)
    changed["environment"]["PUBLIC_CONFIGURATION"] = "different"
    with pytest.raises(update.HostRefused, match="HOST_UPDATE_BINDING_CHANGED"):
        update.target(changed, payload)
    serialized = json.dumps(intent) + repr(plan)
    for forbidden in (
        "synthetic-ephemeral-reader",
        "environment",
        "signing_secret",
        "RunShellScript",
    ):
        assert forbidden not in serialized
    steps[1].body["script"][0] = "modified wrapper"
    intent["binding"]["url"] = "https://changed.invalid"
    assert plan.steps()[1].body == expected.body
    assert plan.intent(job="hosted-1")["binding"]["url"] == row["backend_metadata"]["url"]


@pytest.mark.parametrize(
    "fault", ["owner", "image", "lease", "cursor", "updater", "power", "keys", "erasure"]
)
def test_vm_image_plan_refuses_changed_authority_before_preparing_actions(fault):
    row, spec, _, cursor = _approved()
    metadata = row["backend_metadata"]
    if fault == "owner":
        row["user_id"] = "another-owner"
    elif fault == "image":
        metadata["image_digest"] = "sha256:" + "c" * 64
    elif fault == "lease":
        metadata["upgradeLease"] = "different-lease"
    elif fault == "cursor":
        cursor = {"seq": 3, "sha": "c" * 64}
    elif fault == "updater":
        metadata["vmUpdateModuleSha256"] = "f" * 64
    elif fault == "power":
        metadata["vmPower"] = {"phase": "starting"}
    elif fault == "keys":
        row["pod_signing_key_id"] = None
    else:
        metadata["erasure"] = None
    with pytest.raises((ValueError, AzureSetupRefused)):
        build_vm_image_update(row, spec, idle_record=cursor)


def test_vm_tag_patch_cannot_be_reinterpreted_as_an_ordinary_setup_post():
    from hushh_mcp.services.azure_setup_applier import SetupApplier
    from hushh_mcp.services.azure_setup_plan import ArmStep

    step = ArmStep("vm_image_tag", "action", "PATCH", "/synthetic", "tags", {})
    with pytest.raises(AzureSetupRefused) as refused:
        SetupApplier(object(), advance=lambda _: None)._act(step, {})
    assert refused.value.code == "PLAN_ACTION_UNSUPPORTED"


@pytest.mark.parametrize("changed", [False, True])
def test_payload_bound_dispatch_commits_the_complete_script_and_freezes_caller_input(changed):
    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from tests.test_azure_arm_client import _BEARER, _PATH, _MutationJournal, _Response, _Session

    body = {"commandId": "RunShellScript", "script": ["fixed reviewed wrapper; synthetic payload"]}
    approved = body_commitment(body)
    if changed:
        body["script"][0] = "changed wrapper; synthetic payload"
    journal, session = _MutationJournal(), _Session(_Response(200, {}))
    client = ArmClient(
        _BEARER,
        session=session,
        mutations=journal,
        before_write=lambda: body["script"].append("late caller mutation"),
    )
    if changed:
        with pytest.raises(ArmError) as refused:
            client.request("POST", _PATH, api_version="v", body=body, body_sha256=approved)
        assert refused.value.code == "MutationBodyChanged"
        assert not session.sent and not journal.events
        return
    client.request("POST", _PATH, api_version="v", body=body, body_sha256=approved)
    assert body_commitment(session.sent[0]["json"]) == approved
    request = journal.events[0][2]
    assert request.body_sha256 == approved
    assert "synthetic payload" not in repr(request)
    assert "synthetic-private-value" not in repr(journal.events) and _BEARER not in repr(
        journal.events
    )
