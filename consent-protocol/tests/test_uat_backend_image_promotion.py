"""UAT may copy only the immutable backend image from its accepted Dev attempt."""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from tests.helpers.deployment_cli import executable_manifest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy-uat.yml"
SHA = "f" * 40
DEV = "gcr.io/hushh-pda-dev/consent-protocol"
UAT = "gcr.io/hushh-pda-uat/consent-protocol"
BUILD = "Build and pin backend image before lifecycle migration"


def _steps():
    return yaml.safe_load(WORKFLOW.read_text())["jobs"]["deploy"]["steps"]


def _run_image_step(
    tmp_path, pin, mode="auto", *, copy_fails=False, changed=False, manifest_override=None
):
    manifest = manifest_override or executable_manifest()[0]
    if changed:
        payload = json.loads(manifest)
        payload["config"]["digest"] = "sha256:" + "3" * 64
        manifest = json.dumps(payload)
    digest = "sha256:" + hashlib.sha256(manifest.encode()).hexdigest()
    (tmp_path / "dev-backend-image.json").write_text(json.dumps(pin))
    (tmp_path / "manifest.json").write_text(manifest)
    script = next(step["run"] for step in _steps() if step.get("name") == BUILD)
    script = script.replace("${{ steps.resolve-sha.outputs.sha }}", SHA)
    script = script.replace("${{ env.GCP_PROJECT_ID }}", "hushh-pda-uat")
    script = script.replace("/tmp/uat-", str(tmp_path) + "/")  # noqa: S108
    assert "${{" not in script
    commands, output = tmp_path / "commands", tmp_path / "output"
    guards = r"""
gcloud() {
  printf '%s\n' "$*" >> "$COMMANDS"
  case "$1 $2 $3" in
    'container images add-tag') [ "$COPY_FAILS" != true ] ;;
    'container images describe') printf '%s' "$DESTINATION_DIGEST" ;;
    'builds submit '*) return 0 ;;
    'auth configure-docker '*) return 0 ;;
    *) echo UNEXPECTED_COMMAND >&2; return 95 ;;
  esac
}
docker() {
  if [[ "$*" != *"${DESTINATION_REFERENCE}"* ]]; then
    echo UNEXPECTED_MUTABLE_LOOKUP >&2; return 96
  fi
  cat "$MANIFEST"
}
"""
    guards += f'python3() {{ {shlex.quote(sys.executable)} "$@"; }};\n'
    environment = {
        **os.environ,
        "GITHUB_OUTPUT": str(output),
        "BACKEND_IMAGE_SOURCE": mode,
        "COMMANDS": str(commands),
        "DESTINATION_DIGEST": digest,
        "DESTINATION_REFERENCE": f"{UAT}@{digest}",
        "COPY_FAILS": str(copy_fails).lower(),
        "MANIFEST": str(tmp_path / "manifest.json"),
    }
    environment.pop("BASH_ENV", None)
    result = subprocess.run(  # noqa: S603 - trusted shell with guarded cloud adapters
        [shutil.which("bash"), "-c", guards + script],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert "UNEXPECTED_COMMAND" not in result.stderr
    return (
        result,
        output.read_text().splitlines() if output.exists() else [],
        commands.read_text().splitlines() if commands.exists() else [],
        digest,
    )


@pytest.mark.parametrize("mode", ["auto", "promote-from-dev"])
def test_promotion_copies_only_the_accepted_executable_digest(tmp_path, mode):
    _, digest = executable_manifest()
    source = f"{DEV}@{digest}"
    result, output, commands, _ = _run_image_step(tmp_path, {"image_reference": source}, mode)
    assert result.returncode == 0, result.stderr
    assert commands[0] == f"container images add-tag --quiet {source} {UAT}:uat-{SHA}"
    assert not any(command.startswith("builds submit") for command in commands)
    assert output == [f"image_reference={UAT}@{digest}", "image_source=promote-from-dev"]


@pytest.mark.parametrize("mode,has_proof", [("auto", False), ("build-from-source", True)])
def test_historical_receipt_and_explicit_source_build_keep_the_build_path(
    tmp_path, mode, has_proof
):
    _, digest = executable_manifest()
    pin = {"image_reference": f"{DEV}@{digest}"} if has_proof else {}
    result, output, commands, _ = _run_image_step(tmp_path, pin, mode)
    assert result.returncode == 0, result.stderr
    assert commands[0].startswith("builds submit --project=hushh-pda-uat")
    assert not any("add-tag" in command for command in commands)
    assert output == [f"image_reference={UAT}@{digest}", "image_source=build-from-source"]


@pytest.mark.parametrize(
    "reference", ["", None, "gcr.io/other/consent-protocol@sha256:" + "a" * 64]
)
def test_present_invalid_image_proof_cannot_trigger_a_source_build(tmp_path, reference):
    result, output, commands, _ = _run_image_step(tmp_path, {"image_reference": reference})
    assert result.returncode != 0
    assert not commands and not output


def test_forced_promotion_refuses_a_historical_receipt(tmp_path):
    result, output, commands, _ = _run_image_step(tmp_path, {}, "promote-from-dev")
    assert result.returncode != 0
    assert not commands and not output


@pytest.mark.parametrize("copy_fails,changed", [(True, False), (False, True)])
def test_copy_failure_or_valid_but_different_destination_fails_closed(
    tmp_path, copy_fails, changed
):
    _, digest = executable_manifest()
    result, output, commands, _ = _run_image_step(
        tmp_path, {"image_reference": f"{DEV}@{digest}"}, copy_fails=copy_fails, changed=changed
    )
    assert result.returncode != 0
    assert not output
    assert not any(command.startswith("builds submit") for command in commands)
    if changed:
        assert "Copied backend executable digest differs" in result.stderr


def test_promotion_keeps_exact_acceptance_and_current_tools_before_mutation():
    steps = _steps()
    names = [step.get("name") for step in steps]
    resolve = names.index("Resolve the exact accepted Dev backend image")
    assert resolve == names.index("Require exact-SHA dev acceptance") + 1
    assert resolve < names.index("Sync canonical hosted runtime secrets") < names.index(BUILD)
    gate = steps[resolve]
    assert gate["if"] == "steps.scope.outputs.deploy_backend == 'true'"
    assert "backend-image" in gate["run"] and "--environment dev" in gate["run"]
    assert "--predecessor /tmp/uat-predecessor-acceptance.json" in gate["run"]
    for lane in ("dev", "uat", "production", "uat-one-chat"):
        workflow = yaml.safe_load((WORKFLOW.parent / f"deploy-{lane}.yml").read_text())
        lane_steps = [step for job in workflow["jobs"].values() for step in job.get("steps", [])]
        preserve = next(
            step["run"]
            for step in lane_steps
            if step.get("name")
            == ("Checkout deployment SHA" if lane == "dev" else "Preserve current release tooling")
        )
        assert "cp scripts/ci/release_acceptance_provenance.py" in preserve
        if lane in {"dev", "uat"}:
            assert "cp scripts/ci/verify-cloudrun-revision-provenance.py" in preserve


@pytest.mark.parametrize(
    "arguments,count",
    [([], 0), (["--apply"], 1), (["--apply", "--include-uat-writer"], 2), (["--invalid"], 0)],
)
def test_iam_plan_requires_apply_and_an_independent_destination_writer_option(
    tmp_path, arguments, count
):
    adapter = tmp_path / "gcloud"
    adapter.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMANDS"\n')
    adapter.chmod(0o755)
    commands = tmp_path / "commands"
    environment = {
        **os.environ,
        "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
        "COMMANDS": str(commands),
    }
    environment.pop("BASH_ENV", None)
    result = subprocess.run(  # noqa: S603 - fixed IAM helper, fake gcloud records arguments only
        [shutil.which("bash"), str(ROOT / "deploy/iam/grant_uat_image_promotion.sh"), *arguments],
        env=environment,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == (2 if "--invalid" in arguments else 0)
    calls = commands.read_text().splitlines() if commands.exists() else []
    member = "serviceAccount:github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com"
    assert calls == [
        f"artifacts repositories add-iam-policy-binding gcr.io --project=hushh-pda-{lane} --location=us --member={member} --role=roles/artifactregistry.{role} --quiet --format=none"
        for lane, role in [("dev", "reader"), ("uat", "writer")][:count]
    ]


@pytest.mark.parametrize("architecture", ["amd64", "arm64"])
def test_uat_pins_executable_manifest_instead_of_attested_index(tmp_path, architecture):
    child_digest = "sha256:" + "a" * 64
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": "sha256:" + "b" * 64,
                    "size": 1234,
                    "platform": {"os": "unknown", "architecture": "unknown"},
                    "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": child_digest,
                    "size": 1234,
                    "platform": {"os": "linux", "architecture": architecture},
                },
            ],
        }
    )
    result, output, _, _ = _run_image_step(
        tmp_path, {}, "build-from-source", manifest_override=manifest
    )
    assert "UNEXPECTED_" not in result.stdout + result.stderr
    if architecture != "amd64":
        assert result.returncode != 0
        assert "exactly one executable linux/amd64" in result.stderr
        assert not output
        return
    assert result.returncode == 0, result.stdout + result.stderr
    assert output == [f"image_reference={UAT}@{child_digest}", "image_source=build-from-source"]
