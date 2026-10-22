"""Exact owner update terms without exporting VM environment or replaying actions."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from copy import deepcopy
from dataclasses import replace
from pathlib import Path

import pytest

from browser_runtime.azure_host import update
from hushh_mcp.services.azure_arm_client import API_VERSIONS
from hushh_mcp.services.azure_arm_mutations import body_commitment
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_vm_host_bundle import _SOURCE, installation_step, replacement_step
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


@pytest.mark.parametrize("qualified", [False, True])
def test_vm_refreshes_only_captured_image_evidence_and_keeps_owner_policy(monkeypatch, qualified):
    from pathlib import Path

    from hushh_mcp.services.pod_browser.deployment import BrowserOwnerPolicy
    from hushh_mcp.services.pod_browser.execution_authority import PublicResearchPolicy
    from tests.helpers.pod_browser import readiness

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_ONE_POD_RELEASE_B64", "unrelated-new-offer")
    row, spec, previous, cursor = _approved()
    policy = BrowserOwnerPolicy(
        version=1,
        pod_id=spec.hushh_id,
        pod_key_id=row["pod_key_id"],
        public_policy=PublicResearchPolicy(page_urls=("https://example.com/research",)),
    )
    previous["environment"].update(
        POD_COMPUTER_USE_ENABLED="true",
        HUSSH_BROWSER_POLICY_JSON=policy.model_dump_json(),
        HUSSH_BROWSER_QUALIFICATION_JSON="old-image-evidence",
    )
    row["backend_metadata"]["vmConfigurationSha256"] = update.digest(previous)
    release = json.loads((Path(__file__).parent / "fixtures/pod_release.v1.json").read_text())
    release["image"] = spec.upgrade_target_image
    qualification = {
        "version": 1,
        "host_kind": "azure_vm",
        "source_revision": release["sourceRevision"],
        "image_tag": "source",
        "evidence_sha256": "f" * 64,
        "public_policy_sha256": policy.public_policy.digest,
        "readiness": readiness(cloud="azure", component_digest="sha256:" + "d" * 64).model_dump(),
    }
    if qualified:
        release["browserQualifications"] = [qualification]
    row["backend_metadata"]["upgradeApproval"]["releaseMetadata"] = release
    # PodSpec cannot override the evidence captured by the approved release.
    spec = replace(spec, browser_qualification={"untrusted": "selection"})
    plan = build_vm_image_update(row, spec, idle_record=cursor)
    script = plan.steps()[1].body["script"][0]
    assert script.index("sha256sum browser_runtime/qualification.py") < script.index(
        "/usr/bin/python3"
    )
    raw = script.split("HUSSH_IMAGE_UPDATE'\n", 1)[1].split("\n", 1)[0]
    request = json.loads(base64.b64decode(raw))
    assert request["browser_qualification"] == (qualification if qualified else None)
    assert update.digest(request) == plan.host_request_sha256
    replacement = update.target(previous, request)
    expected = {
        key: value
        for key, value in previous["environment"].items()
        if key != "HUSSH_BROWSER_QUALIFICATION_JSON"
    }
    expected["HUSSH_POD_INSTALLED_IMAGE_DIGEST"] = "sha256:" + "d" * 64
    if qualified:
        expected["HUSSH_BROWSER_QUALIFICATION_JSON"] = json.dumps(
            qualification, sort_keys=True, separators=(",", ":")
        )
        request["browser_qualification"]["readiness"]["component_digest"] = "sha256:" + "0" * 64
        with pytest.raises(update.HostRefused, match="HOST_BROWSER_QUALIFICATION_INVALID"):
            update.target(previous, request)
    assert replacement["environment"] == expected


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


def test_installer_is_deterministic_bounded_and_keeps_normal_image_entrypoint(tmp_path):
    value = installation()
    step, digest = installation_step(value)
    assert installation_step(deepcopy(value)) == (step, digest)
    script = step.body["script"][0]
    packed = base64.b64decode(
        script.split("HUSSH_HOST_BUNDLE' | tar --no-same-owner -xzf -\n", 1)[1].split("\n", 1)[0]
    )
    assert len(packed) <= 49152
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(packed))) as archive:
        names = archive.getnames()
        assert all(not name.startswith("/") and ".." not in Path(name).parts for name in names)
        stored = archive.extractfile("installation.json").read()
        assert json.loads(stored) == value
        assert archive.getmember("installation.json").mode == 0o600
        assert set(name for name in names if name.endswith(".py")) == {
            "browser_runtime/qualification.py"
        } | {
            "azure_host/" + name
            for name in (
                "__init__.py",
                "config.py",
                "credentials.py",
                "engine.py",
                "runner.py",
                "tls.py",
                "update.py",
            )
        }
        archive.extractall(tmp_path, filter="data")
    imported = subprocess.run(  # noqa: S603 -- fixed stdlib-only import; no external executable/input
        [
            sys.executable,
            "-S",
            "-c",
            "import azure_host.update, sys; assert 'hushh_mcp' not in sys.modules",
        ],
        cwd=tmp_path,
        env={},
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert imported.returncode == 0, imported.stderr.decode()
    assert step.path.endswith("/virtualMachines/agent/runCommand")
