"""Exact retained attempt receipts and trusted writer contracts."""

import hashlib
import json
from io import BytesIO
from types import SimpleNamespace
from zipfile import ZipFile

import pytest
import yaml

from tests.helpers.predecessor_acceptance import ROOT, SHA, _acceptance_fixture


def test_durable_attempt_receipt_requires_exact_main_workflow_attestation(monkeypatch):
    module, *_ = _acceptance_fixture()
    receipt_bytes = b'{"run_id":123,"run_attempt":2}\n'
    invocation = "https://github.com/hushh-labs/hushh-research/actions/runs/123/attempts/2"
    statement = {
        "predicateType": "https://slsa.dev/provenance/v1",
        "subject": [
            {
                "name": "acceptance.json",
                "digest": {"sha256": hashlib.sha256(receipt_bytes).hexdigest()},
            }
        ],
        "predicate": {"runDetails": {"metadata": {"invocationId": invocation}}},
    }
    output = [json.dumps([{"verificationResult": {"statement": statement}}]).encode()]
    commands = []

    def verify(command, timeout):
        commands.append((command, timeout))
        return output[0]

    monkeypatch.setattr(module, "_bounded_process_read", verify)
    module.verify_durable_attempt_attestation(
        receipt_bytes, environment="dev", run_id=123, attempt=2
    )
    command, timeout = commands[0]
    assert timeout == 45
    assert "--cert-identity" in command
    assert (
        "https://github.com/hushh-labs/hushh-research/.github/workflows/deploy-dev.yml@refs/heads/main"
        in command
    )
    assert "--source-ref" in command and "refs/heads/main" in command
    assert "--signer-workflow" not in command

    statement["predicate"]["runDetails"]["metadata"]["invocationId"] = invocation + "-wrong"
    output[0] = json.dumps([{"verificationResult": {"statement": statement}}]).encode()
    with pytest.raises(module.InvalidAttemptReceipt, match="exact workflow run attempt"):
        module.verify_durable_attempt_attestation(
            receipt_bytes, environment="dev", run_id=123, attempt=2
        )

    statement["predicate"]["runDetails"]["metadata"]["invocationId"] = invocation
    statement["subject"][0]["digest"]["sha256"] = "0" * 64
    output[0] = json.dumps([{"verificationResult": {"statement": statement}}]).encode()
    with pytest.raises(module.InvalidAttemptReceipt, match="different receipt bytes"):
        module.verify_durable_attempt_attestation(
            receipt_bytes, environment="dev", run_id=123, attempt=2
        )


@pytest.mark.parametrize(
    "case",
    [
        "valid",
        "historical",
        "frontend_only",
        "repository",
        "digest",
        "unverified",
        "partial",
        "pin",
        "failed_attempt",
    ],
)
def test_backend_image_is_bound_to_the_selected_accepted_attempt(case, tmp_path, monkeypatch):
    module, client, receipts, responses, pins = _acceptance_fixture()
    observed = receipts["dev"]["provenance"]["backend"]["checked_revisions"][0]
    image = "gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "a" * 64
    proof = {"image_reference": image, "image_digest": "sha256:" + "a" * 64, "image_verified": True}
    if case == "frontend_only":
        receipts["dev"]["provenance"]["frontend"]["checked_revisions"][0].update(proof)
    elif case != "historical":
        observed.update(proof)
    if case == "repository":
        observed["image_reference"] = image.replace("hushh-pda-dev", "hushh-pda-uat")
    elif case == "digest":
        observed["image_digest"] = "sha256:" + "b" * 64
    elif case == "unverified":
        observed["image_verified"] = False
    elif case == "partial":
        observed.pop("image_reference")
    elif case == "pin":
        pins["dev"]["image_reference"] = image.replace("a" * 64, "b" * 64)
    elif case == "failed_attempt":
        responses["runs/10/attempts/2"]["conclusion"] = "failure"
    archive = BytesIO()
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("acceptance.json", json.dumps(receipts["dev"]))
    digest = "sha256:" + hashlib.sha256(archive.getvalue()).hexdigest()
    responses["artifacts/11/zip"] = archive.getvalue()
    responses["artifacts/11"].update(digest=digest, size_in_bytes=len(archive.getvalue()))
    pins["dev"]["artifact_digest"] = digest
    predecessor = tmp_path / "predecessor.json"
    predecessor.write_text(
        json.dumps(
            {
                "status": "accepted",
                "environment": "dev",
                "sha": SHA,
                "services": {"backend": pins["dev"]},
            }
        )
    )
    monkeypatch.setattr(module, "GitHub", lambda: client)
    args = SimpleNamespace(environment="dev", sha=SHA, predecessor=predecessor)
    if case not in {"valid", "historical", "frontend_only"}:
        with pytest.raises(module.Refused):
            module.pinned_backend_image(args)
    else:
        accepted = module.pinned_backend_image(args)
        assert accepted["run_attempt"] == 2 and accepted["artifact_id"] == 11
        assert accepted.get("image_reference") == (image if case == "valid" else None)


def test_shared_dev_attempt_tag_has_an_exact_main_owned_writer():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    deploy = workflow["jobs"]["deploy"]
    writer = workflow["jobs"]["persist-shared-dev-attempt"]
    assert deploy["outputs"]["target_sha"] == "${{ steps.resolve-sha.outputs.sha }}"
    assert writer["needs"] == "deploy"
    assert "inputs.target == 'shared-dev'" in writer["if"]
    assert writer["permissions"] == {
        "contents": "write",
        "actions": "read",
        "attestations": "write",
        "id-token": "write",
    }
    checkout = next(
        step for step in writer["steps"] if step.get("uses", "").startswith("actions/checkout@")
    )
    assert checkout["with"]["ref"] == "refs/heads/main"
    download = next(
        step
        for step in writer["steps"]
        if step.get("name") == "Download the exact attempt acceptance receipt"
    )
    assert "${GITHUB_RUN_ATTEMPT}" in download["run"]
    persist = next(
        step
        for step in writer["steps"]
        if step.get("name") == "Persist immutable exact-attempt receipt"
    )
    assert "--kind full --environment dev" in persist["run"]
    assert "continue-on-error" not in persist
    attestation = next(
        step
        for step in writer["steps"]
        if step.get("name") == "Attest the exact Dev acceptance receipt"
    )
    assert attestation["uses"] == "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6"
    assert (
        attestation["with"]["subject-path"] == "${{ runner.temp }}/dev-acceptance/acceptance.json"
    )


def test_dev_preserves_every_local_acceptance_verifier_companion():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    deploy = workflow["jobs"]["deploy"]
    preserve = next(
        step for step in deploy["steps"] if step.get("name") == "Checkout deployment SHA"
    )
    for companion in (
        "release_acceptance_contract.py",
        "uat_attempt_receipt.py",
        "process_group.py",
        "release_acceptance_provenance.py",
    ):
        assert f'cp scripts/ci/{companion} "${{RUNNER_TEMP}}/release-tools/"' in preserve["run"]


def test_uat_attempt_tags_are_required_outputs_of_healthy_deployments():
    for workflow_path, writer_name, kind, environment in (
        ("deploy-uat.yml", "persist-uat-attempt", "full", "uat"),
        ("deploy-uat-one-chat.yml", "persist-uat-one-chat-attempt", "one-chat", "uat"),
    ):
        workflow = yaml.safe_load((ROOT / ".github/workflows" / workflow_path).read_text())
        writer = workflow["jobs"][writer_name]
        assert "deploy" in writer["needs"]
        assert writer["permissions"] == {
            "contents": "write",
            "actions": "read",
            "attestations": "write",
            "id-token": "write",
        }
        checkout = next(
            item
            for item in writer["steps"]
            if item.get("name") == "Checkout protected Main receipt tooling"
        )
        assert checkout["with"]["ref"] == "refs/heads/main"
        assert checkout["with"]["persist-credentials"] is True
        persist = next(
            item
            for item in writer["steps"]
            if item.get("name") == "Persist immutable exact-attempt receipt"
        )
        assert f"--kind {kind} --environment {environment}" in persist["run"]
        attestation = next(
            item for item in writer["steps"] if item.get("uses", "").startswith("actions/attest@")
        )
        assert attestation["uses"] == "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6"
