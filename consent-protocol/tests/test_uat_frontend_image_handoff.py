"""Release-duration regressions must preserve readiness and browser gates."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from tests.helpers.deployment_cli import frontend_release as _frontend_release
from tests.helpers.deployment_cli import uat_build_module as _uat_build_module

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


@pytest.fixture
def image_handoff(monkeypatch):
    monkeypatch.syspath_prepend(str(REPO_ROOT / "scripts/ci"))
    return importlib.import_module("uat_frontend_image_handoff")


def _pending_frontend_config():
    module = _uat_build_module()
    release = _frontend_release()
    release["_IMAGE_REFERENCE"] = ""
    backend = module.candidate_parallel_config(
        yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    )
    return (
        module,
        backend,
        module.frontend_parallel_config(
            backend,
            yaml.safe_load(_read("deploy/frontend.cloudbuild.yaml")),
            {key: release[key] for key in module.SHARED_SUBSTITUTIONS},
            release,
            frontend_image_build_id="11111111-1111-4111-8111-111111111111",
        ),
    )


def test_late_frontend_wait_is_independent_of_probes_and_keeps_the_complete_build_join():
    module, backend, config = _pending_frontend_config()
    assert config["steps"][: len(backend["steps"])] == backend["steps"]
    steps = {step["id"]: step for step in config["steps"]}
    assert steps["await-frontend-image"]["waitFor"] == ["build-backend-image", "verify-runtime-iam"]
    assert steps["inspect-frontend-image-manifest"]["waitFor"] == ["await-frontend-image"]
    assert steps["pin-frontend-image"]["waitFor"] == ["inspect-frontend-image-manifest"]
    assert steps[module.FRONTEND_STEPS[0]]["waitFor"] == ["pin-frontend-image"]
    assert steps["verify-managed-provider-readiness"]["waitFor"] == [
        "deploy-backend",
        "verify-azure-pwm-runtime",
        "verify-managed-vertex-runtime",
    ]
    assert all(
        not s.get("allowFailure") and not s.get("allowExitCodes")
        for s in config["steps"][len(backend["steps"]) :]
    )
    assert config["options"] == backend["options"]
    assert not config["options"].get("dynamicSubstitutions")
    assert "_WEB_IMAGE_REFERENCE" not in config["substitutions"]
    # The canonical frontend guards/configuration/rollout all remain present.
    assert all(name in steps for name in module.FRONTEND_STEPS)
    for step in config["steps"]:
        assert len(step.get("env", [])) <= 100
        for value in step.get("args", []) + step.get("env", []):
            rendered = module.CUSTOM_SUBSTITUTION.sub(
                lambda m: config["substitutions"][m[1]], value
            )
            assert len(rendered) <= 9500


@pytest.mark.parametrize("mutation", ["valid", "other_run", "mutable", "extra_line", "shell_text"])
def test_generated_frontend_guard_consumes_only_this_builds_exact_pin(tmp_path, mutation):
    module, _, config = _pending_frontend_config()
    step = next(s for s in config["steps"] if s["id"] == "build-frontend-image")
    expected = "a" * 40 + "|42|1|11111111-1111-4111-8111-111111111111|deployment"
    image = "gcr.io/hushh-pda-uat/hushh-webapp@sha256:" + "b" * 64
    header, suffix = expected, ""
    if mutation == "other_run":
        header = expected.replace("|42|", "|43|")
    elif mutation == "mutable":
        image = "gcr.io/hushh-pda-uat/hushh-webapp:latest"
    elif mutation == "extra_line":
        suffix = "\n"
    elif mutation == "shell_text":
        image = "$(touch should-not-execute)"
    (tmp_path / ".uat-frontend-image-reference").write_text(header + "\n" + image + "\n" + suffix)
    script = module.CUSTOM_SUBSTITUTION.sub(
        lambda m: config["substitutions"][m[1]], step["args"][1]
    )
    script = script.replace("$$", "$").replace("/workspace/", str(tmp_path) + "/")
    result = subprocess.run(  # noqa: S603 - real digest guard; no cloud/deploy commands run.
        [shutil.which("bash") or "bash", "-c", script],
        cwd=tmp_path,
        env={**os.environ, "UAT_EXPECTED_IMAGE_CONTEXT": expected},
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert (result.returncode == 0) is (mutation == "valid"), result.stderr
    assert not (tmp_path / "should-not-execute").exists()


def _handoff_context(module):
    return module.Context(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "a" * 40,
        "42",
        "1",
    )


def _image_manifest():
    raw = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "size": 42,
                    "digest": "sha256:" + "b" * 64,
                    "platform": {"os": "linux", "architecture": "amd64"},
                }
            ],
        }
    ).encode()
    return raw, "sha256:" + hashlib.sha256(raw).hexdigest()


def _pin_late_image(module, context, tmp_path, monkeypatch, build_values=None):
    raw, digest = _image_manifest()
    statuses = iter(["WORKING", "SUCCESS"])
    calls = []

    def cloud(arguments, _deadline):
        calls.append(arguments)
        if arguments[:2] == ["builds", "describe"]:
            return {
                "id": context.image_build_id,
                "projectId": module.PROJECT,
                "status": next(statuses),
                "substitutions": build_values
                or {
                    "_IMAGE_TAG": context.tag,
                    "_APP_ENV": "uat",
                    "_DEPLOY_ENV": "uat",
                },
            }
        assert arguments[:3] == ["container", "images", "describe"]
        return {"image_summary": {"digest": digest}}

    monkeypatch.setattr(module, "cloud_json", cloud)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)
    module.await_image(context, tmp_path, float("inf"))
    (tmp_path / module.MANIFEST_FILE).write_bytes(raw)
    native_output = tmp_path / "builder-output"
    native_output.mkdir()
    monkeypatch.setenv("BUILDER_OUTPUT", str(native_output))
    monkeypatch.setattr(
        module.sys,
        "argv",
        [module.MODULE_PATH, "pin", *context.arguments(), "--workspace", str(tmp_path)],
    )
    assert module.main() == 0
    report = json.loads((native_output / "output").read_bytes())
    assert [a[:2] for a in calls] == [
        ["builds", "describe"],
        ["builds", "describe"],
        ["container", "images"],
    ]
    assert (tmp_path / module.REFERENCE_FILE).read_text() == context.header + "\n" + report[
        "image"
    ]["image_reference"] + "\n"
    return report


def _frontend_producer_values(module, context, tmp_path):
    # Run the actual tag/substitution producer: a synthetic consumer-only tag
    # missed a real mismatch between this workflow and the pending handoff.
    workflow_steps = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))["jobs"]["deploy"][
        "steps"
    ]
    producer = next(s["run"] for s in workflow_steps if s.get("id") == "start-frontend-image-build")
    expressions = {
        "steps.resolve-sha.outputs.sha": context.sha,
        "github.run_id": context.github_run,
        "github.run_attempt": context.github_attempt,
        "env.GCP_PROJECT_ID": module.PROJECT,
    }
    producer = re.sub(r"\$\{\{\s*(.*?)\s*\}\}", lambda m: expressions.get(m[1], "false"), producer)
    output = tmp_path / "producer-output"
    produced = subprocess.run(  # noqa: S603 - authored workflow and synthetic cloud transport.
        [
            shutil.which("bash"),
            "-c",
            'gcloud() { printf "%s\\n" "' + context.image_build_id + '"; };\n' + producer,
        ],
        cwd=REPO_ROOT,
        env={**os.environ, "GITHUB_OUTPUT": str(output)},
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert produced.returncode == 0, produced.stderr
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return _uat_build_module().substitutions(outputs["build_substitutions"], ",")


def _completed_deployment_build(module, context, report):
    pin = {
        "id": module.PIN_STEP,
        "status": "SUCCESS",
        "entrypoint": "python3",
        "args": [module.MODULE_PATH, "pin", *context.arguments()],
        "waitFor": ["inspect-frontend-image-manifest"],
    }
    return {
        "id": context.deployment_build_id,
        "projectId": module.PROJECT,
        "status": "SUCCESS",
        "startTime": "2026-10-25T00:00:00Z",
        "finishTime": "2026-10-25T00:01:00Z",
        "substitutions": {
            "_DEPLOY_SHA": context.sha,
            "_GITHUB_RUN_ID": context.github_run,
            "_IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "c" * 64,
            "_RUNTIME_SERVICE_ACCOUNT": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "_DEPLOY_ENV": "uat",
            "_REGION": "us-central1",
            "_BACKEND_SERVICE": "consent-protocol",
            "_CLOUD_RUN_TAG": "account-deletion-42",
            "_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE": "false",
        },
        "results": {
            "buildStepOutputs": ["", base64.b64encode(json.dumps(report).encode()).decode(), ""]
        },
        "steps": [
            {
                "id": "verify-managed-provider-readiness",
                "status": "SUCCESS",
                "waitFor": [
                    "deploy-backend",
                    "verify-azure-pwm-runtime",
                    "verify-managed-vertex-runtime",
                ],
            },
            pin,
            {
                "id": "await-frontend-image",
                "status": "SUCCESS",
                "entrypoint": "python3",
                "args": [module.MODULE_PATH, "wait", *context.arguments()],
                "waitFor": ["build-backend-image", "verify-runtime-iam"],
                "timing": {
                    "startTime": "2026-10-25T00:00:01.100Z",
                    "endTime": "2026-10-25T00:00:13.200Z",
                },
            },
        ],
    }


def test_late_image_roundtrip_uses_the_original_hash_checked_pin_without_resolving_the_tag_again(
    image_handoff, tmp_path, monkeypatch
):
    module = image_handoff
    context = _handoff_context(module)
    values = _frontend_producer_values(module, context, tmp_path)
    report = _pin_late_image(module, context, tmp_path, monkeypatch, values)
    build = _completed_deployment_build(module, context, report)
    calls = []

    def cloud(arguments, _deadline):
        calls.append(arguments)
        assert arguments[:2] == ["builds", "describe"]
        return build

    monkeypatch.setattr(module, "cloud_json", cloud)
    image, proof = module.collect_image(
        context, build["substitutions"]["_IMAGE_REFERENCE"], False, float("inf")
    )
    assert image == report["image"]
    assert proof["context"] == module.asdict(context) and proof["build_step"] == {
        "id": module.PIN_STEP,
        "index": 1,
    }
    assert proof["image_wait_seconds"] == 13
    assert len(calls) == 1
    build["results"]["buildStepOutputs"].pop(1)
    with pytest.raises(ValueError):
        module.collect_image(
            context, build["substitutions"]["_IMAGE_REFERENCE"], False, float("inf")
        )
    build["results"]["buildStepOutputs"].insert(
        1, base64.b64encode(json.dumps(report).encode()).decode()
    )
    # Reproduce the original raw artifact by its immutable index, independently
    # checking byte hash and executable selection. No mutable tag is consulted.
    raw, _ = _image_manifest()

    def docker(arguments, **_kwargs):
        assert arguments == [
            "docker",
            "buildx",
            "imagetools",
            "inspect",
            "--raw",
            image["index_reference"],
        ]
        return subprocess.CompletedProcess(arguments, 0, raw, b"")

    monkeypatch.setattr(module.subprocess, "run", docker)
    manifest = tmp_path / "collected-manifest.json"
    module.collect_manifest(image, manifest, float("inf"))
    assert manifest.read_bytes() == raw
    with pytest.raises(ValueError):
        module.collect_manifest(
            {**image, "image_reference": module.REPOSITORY + "@sha256:" + "e" * 64},
            manifest,
            float("inf"),
        )
    build["steps"][-1]["timing"]["endTime"] = "2026-10-25T00:00:00Z"
    with pytest.raises(module.ReceiptError, match="image_wait_timing_invalid"):
        module.collect_image(
            context, build["substitutions"]["_IMAGE_REFERENCE"], False, float("inf")
        )
    # A provider/build failure cannot be converted into a successful image handoff.
    build["status"] = "FAILURE"
    with pytest.raises(module.ReceiptError, match="build_not_exact_success"):
        module.collect_image(
            context, build["substitutions"]["_IMAGE_REFERENCE"], False, float("inf")
        )


def test_historical_checkout_keeps_the_current_handoff_and_its_resolver(tmp_path):
    steps = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))["jobs"]["deploy"]["steps"]
    scripts = [
        next(s["run"] for s in steps if s.get("name") == name)
        for name in ("Preserve current release tooling", "Checkout deployment SHA")
    ]
    names = (
        "uat_backend_build_config.py",
        "uat_frontend_image_handoff.py",
        "resolve-cloud-run-image.py",
        "capture_managed_provider_receipt.py",
    )
    directory = tmp_path / "scripts/ci"
    directory.mkdir(parents=True)
    for name in names:
        shutil.copy2(REPO_ROOT / "scripts/ci" / name, directory / name)
    # Other tool bundles are tested by their own release contracts. Execute
    # these real copy commands across an empty historical scripts directory.
    adapters = (
        'cp() { case "${1##*/}" in '
        + "|".join(names)
        + ') command cp "$@" ;; *) return 0 ;; esac; };\ngit() { return 0; };\n'
    )
    for index, script in enumerate(scripts):
        if index:
            for name in names:
                (directory / name).unlink()
        script = re.sub(r"\$\{\{[^}]+\}\}", "false", script)
        result = subprocess.run(  # noqa: S603 - real copy steps, isolated synthetic checkout.
            [shutil.which("bash"), "-c", adapters + script],
            cwd=tmp_path,
            env={**os.environ, "RUNNER_TEMP": str(tmp_path / "runner")},
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert result.returncode == 0, result.stderr
    for name in names:
        assert (directory / name).read_bytes() == (REPO_ROOT / "scripts/ci" / name).read_bytes()


@pytest.mark.parametrize(
    "mutation",
    ["manifest_bytes", "state_run", "output_context", "output_schema", "bad_base64", "truncated"],
)
def test_late_image_rejects_corrupt_or_misbound_evidence(
    image_handoff, tmp_path, monkeypatch, mutation
):
    module = image_handoff
    context = _handoff_context(module)
    report = _pin_late_image(module, context, tmp_path, monkeypatch)
    if mutation in {"manifest_bytes", "state_run"}:
        if mutation == "manifest_bytes":
            (tmp_path / module.MANIFEST_FILE).write_bytes(b"{}")
        else:
            state = json.loads((tmp_path / module.STATE_FILE).read_text())
            state["context"]["github_run"] = "43"
            (tmp_path / module.STATE_FILE).write_text(json.dumps(state))
        with pytest.raises(ValueError):
            module.pin_image(context, tmp_path)
        return
    if mutation == "output_context":
        report["context"]["github_attempt"] = "2"
    elif mutation == "output_schema":
        report["schema"] = "unknown"
    encoded = base64.b64encode(json.dumps(report).encode()).decode()
    if mutation == "bad_base64":
        encoded = "!invalid-base64!"
    elif mutation == "truncated":
        encoded = base64.b64encode(json.dumps(report).encode()[:-1]).decode()
    with pytest.raises(ValueError):
        module.image_from_output(encoded, context)
