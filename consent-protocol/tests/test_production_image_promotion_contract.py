"""Contract for promoting the UAT-verified backend image into production.

With ``backend_image_source=promote-from-uat`` the production lane deploys the
exact backend digest UAT verified for the same SHA instead of rebuilding it.
The source digest must be proven by UAT's own release evidence and every
mismatch must stop the run before production changes. ``build-from-source``
remains the default until the founder grants the IAM and flips it.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-production.yml"
VERIFIER = ROOT / "scripts" / "ci" / "resolve-uat-verified-image.py"
IMAGE_RESOLVER = ROOT / "scripts" / "ci" / "resolve-cloud-run-image.py"
UAT_REPOSITORY = "gcr.io/hushh-pda-uat/consent-protocol"
PROD_REPOSITORY = "gcr.io/hushh-pda/consent-protocol"
PREFLIGHT = "Resolve UAT-verified backend image for promotion"
BUILD = "Build and pin backend image before lifecycle migration"


def _verifier():
    spec = importlib.util.spec_from_file_location("resolve_uat_verified_image", VERIFIER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _direct_manifest() -> tuple[str, str]:
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": "sha256:" + "1" * 64,
                "size": 100,
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": "sha256:" + "2" * 64,
                    "size": 200,
                }
            ],
        }
    )
    return manifest, "sha256:" + hashlib.sha256(manifest.encode()).hexdigest()


def _revision(sha: str, name: str = "consent-protocol-00500-abc", **overrides) -> dict:
    _, digest = _direct_manifest()
    labels = {"deploy-sha": sha, "deploy-env": "uat", "deploy-source": "deploy-uat"}
    labels.update(overrides.pop("labels", {}))
    env = {"HUSHH_DEPLOY_SHA": sha, "HUSHH_DEPLOY_ENV": "uat", "HUSHH_DEPLOY_SOURCE": "deploy-uat"}
    env.update(overrides.pop("env", {}))
    image = overrides.pop("image", f"{UAT_REPOSITORY}@{digest}")
    return {
        "metadata": {"name": name, "labels": labels},
        "spec": {
            "containers": [
                {"image": image, "env": [{"name": k, "value": v} for k, v in env.items()]}
            ]
        },
    }


def _steps() -> list[dict]:
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    return workflow["jobs"]["deploy"]["steps"]


def _step(name: str) -> dict:
    return next(step for step in _steps() if step.get("name") == name)


def _bash() -> str:
    bash = shutil.which("bash")
    assert bash is not None
    return bash


# --- verifier --------------------------------------------------------------------


SHA = "f" * 40


def test_verifier_accepts_only_fully_consistent_uat_evidence() -> None:
    module = _verifier()
    _, digest = _direct_manifest()
    image = module.resolve_verified_image(
        _revision(SHA),
        sha=SHA,
        expected_revision="consent-protocol-00500-abc",
        expected_repository=UAT_REPOSITORY,
    )
    assert image == f"{UAT_REPOSITORY}@{digest}"


@pytest.mark.parametrize(
    ("revision", "expected_revision", "reason"),
    [
        (_revision("e" * 40), "consent-protocol-00500-abc", "deploy-sha label"),
        (
            _revision(SHA, env={"HUSHH_DEPLOY_SHA": "e" * 40}),
            "consent-protocol-00500-abc",
            "HUSHH_DEPLOY_SHA",
        ),
        (
            _revision(SHA, labels={"deploy-env": "dev"}),
            "consent-protocol-00500-abc",
            "deployed to uat",
        ),
        (
            _revision(SHA, labels={"deploy-source": "manual"}),
            "consent-protocol-00500-abc",
            "deploy-uat",
        ),
        (
            _revision(SHA, image=f"{UAT_REPOSITORY}:uat-{SHA}"),
            "consent-protocol-00500-abc",
            "immutable image",
        ),
        (
            _revision(SHA, image="gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "3" * 64),
            "consent-protocol-00500-abc",
            "immutable image",
        ),
        (_revision(SHA), "consent-protocol-00499-old", "release tag"),
    ],
)
def test_verifier_fails_closed_on_any_mismatch(
    revision: dict, expected_revision: str, reason: str
) -> None:
    module = _verifier()
    with pytest.raises(module.VerificationError, match=reason):
        module.resolve_verified_image(
            revision,
            sha=SHA,
            expected_revision=expected_revision,
            expected_repository=UAT_REPOSITORY,
        )


def test_verifier_requires_exactly_one_recorded_backend_revision() -> None:
    module = _verifier()
    assert module.parse_release_tag_backend_revision("sha: x\nbackend_revision: rev-1\n") == "rev-1"
    for annotation in (
        "sha: x\n",
        "backend_revision: \n",
        "backend_revision: a\nbackend_revision: b\n",
    ):
        with pytest.raises(module.VerificationError):
            module.parse_release_tag_backend_revision(annotation)


# --- workflow wiring ---------------------------------------------------------------


def test_build_from_source_stays_the_default_until_the_founder_flips_it() -> None:
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    # PyYAML reads the bare `on:` key as boolean True.
    source = (workflow.get("on") or workflow[True])["workflow_dispatch"]["inputs"][
        "backend_image_source"
    ]
    assert source["type"] == "choice"
    assert source["options"] == ["build-from-source", "promote-from-uat"]
    assert source["default"] == "build-from-source"


def test_preflight_runs_before_production_is_changed() -> None:
    names = [str(step.get("name") or "") for step in _steps()]
    preflight = names.index(PREFLIGHT)
    assert names.index("Resolve deployment scope") < preflight
    for later in (
        "Sync canonical hosted runtime secrets",
        "Pre-deploy Cloud SQL backup posture gate",
        BUILD,
        "Install fail-closed account deletion release fence",
        "Apply production DB migrations behind account deletion fence",
    ):
        assert preflight < names.index(later), later
    step = _step(PREFLIGHT)
    assert step["id"] == "uat-verified-backend-image"
    assert step["if"] == (
        "steps.scope.outputs.deploy_backend == 'true' && "
        "github.event.inputs.backend_image_source == 'promote-from-uat'"
    )
    # The verifier comes from main, never from a deployment SHA that predates it.
    assert '"${RUNNER_TEMP}/release-tools/resolve-uat-verified-image.py"' in step["run"]
    preserve = str(_step("Preserve current release tooling")["run"])
    assert "scripts/ci/resolve-uat-verified-image.py" in preserve
    build = _step(BUILD)
    assert build["env"]["UAT_VERIFIED_IMAGE_REFERENCE"] == (
        "${{ steps.uat-verified-backend-image.outputs.image_reference }}"
    )


def test_voice_release_gate_survives_checkout_of_older_uat_sha() -> None:
    preserve = str(_step("Preserve current release tooling")["run"])
    checkout = str(_step("Checkout deployment SHA")["run"])
    deploy = str(_step("Deploy backend using Cloud Build")["run"])
    for path in ("deploy/backend.cloudbuild.yaml", "scripts/ci/assert_one_voice_live_probe.py"):
        assert f"cp {path} " in preserve
        assert checkout.index("git checkout --detach") < checkout.index(path)
    assert "--config=deploy/backend.cloudbuild.yaml" in deploy
    assert "_SKIP_IMAGE_BUILD=true" in deploy


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(  # noqa: S603 - fixed git arguments in a pytest scratch repo
        ["git", *args],  # noqa: S607 - git from PATH, as the workflow runner uses it
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _preflight(tmp_path: Path, scenario: str):
    """Run the real preflight body in a scratch repo with guarded cloud calls."""
    repo = tmp_path / "repo"
    (repo / "scripts" / "ci").mkdir(parents=True)
    shutil.copy(IMAGE_RESOLVER, repo / "scripts" / "ci" / IMAGE_RESOLVER.name)
    release_tools = tmp_path / "runner" / "release-tools"
    release_tools.mkdir(parents=True)
    shutil.copy(VERIFIER, release_tools / VERIFIER.name)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "ci@example.com")
    _git(repo, "config", "user.name", "CI")
    (repo / "f.txt").write_text("x\n")
    _git(repo, "add", "f.txt")
    _git(repo, "commit", "-qm", "c")
    sha = _git(repo, "rev-parse", "HEAD")
    if scenario != "no-tag":
        _git(
            repo,
            "tag",
            "-a",
            f"deployed/uat/{sha[:8]}-20260926T000000Z",
            sha,
            "-m",
            f"Last known good - uat\nsha: {sha}\nbackend_revision: consent-protocol-00500-abc\n",
        )

    manifest, digest = _direct_manifest()
    revision = _revision(sha)
    if scenario == "frontend-only-uat":
        revision = _revision("e" * 40)
    revision_file = tmp_path / "revision.json"
    revision_file.write_text(json.dumps(revision))
    uat_ref = f"{UAT_REPOSITORY}@{digest}"

    run = str(_step(PREFLIGHT)["run"])
    run = run.replace("${{ env.UAT_GCP_PROJECT_ID }}", "hushh-pda-uat")
    run = run.replace("${{ env.UAT_BACKEND_IMAGE_REPOSITORY }}", UAT_REPOSITORY)
    run = run.replace("${{ env.GCP_REGION }}", "us-central1")
    run = run.replace("/tmp/", f"{tmp_path}/")  # noqa: S108 - redirect workflow evidence paths into pytest isolation
    assert "${{" not in run

    revisions = (
        "echo 'ERROR: PERMISSION_DENIED: run.revisions.get' >&2; return 1"
        if scenario == "no-run-viewer"
        else f"cat '{revision_file}'"
    )
    registry = (
        "echo 'denied: Permission artifactregistry.repositories.downloadArtifacts' >&2; return 1"
        if scenario == "no-registry-reader"
        else f"if [[ \"$*\" != *'{uat_ref}'* ]]; then echo UNEXPECTED_REF >&2; return 96; fi; printf '%s' '{manifest}'"
    )
    guards = (
        'git() { if [ "$1" = "fetch" ]; then return 0; fi; command git "$@"; };\n'
        'gcloud() { case "$1 $2" in '
        f"'run revisions') {revisions} ;; "
        "'auth configure-docker') return 0 ;; "
        "*) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;; esac; };\n"
        f"docker() {{ {registry}; }};\n"
        f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
    )
    output = tmp_path / "github-output"
    environment = os.environ.copy()
    environment.pop("BASH_ENV", None)
    environment.update(
        {
            "GITHUB_OUTPUT": output.as_posix(),
            "RUNNER_TEMP": (tmp_path / "runner").as_posix(),
            "DEPLOY_SHA": sha,
        }
    )
    result = subprocess.run(  # noqa: S603 - trusted workflow body, guarded commands
        [_bash(), "-c", guards + run],
        cwd=repo,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    outputs = output.read_text().splitlines() if output.exists() else []
    return result, outputs, uat_ref


def test_preflight_resolves_the_uat_verified_digest(tmp_path: Path) -> None:
    result, outputs, uat_ref = _preflight(tmp_path, "ok")
    assert "UNEXPECTED_" not in result.stdout + result.stderr
    assert result.returncode == 0, result.stderr
    assert f"image_reference={uat_ref}" in outputs
    assert "uat_revision=consent-protocol-00500-abc" in outputs


@pytest.mark.parametrize(
    ("scenario", "message"),
    [
        ("no-tag", "has no healthy UAT release"),
        ("frontend-only-uat", "A frontend-only UAT release does not verify a backend image"),
        ("no-run-viewer", "cannot read Cloud Run revisions in hushh-pda-uat"),
        ("no-registry-reader", "cannot read gcr.io/hushh-pda-uat/consent-protocol@"),
    ],
)
def test_preflight_fails_closed_with_a_clear_reason(
    tmp_path: Path, scenario: str, message: str
) -> None:
    result, outputs, _ = _preflight(tmp_path, scenario)
    assert result.returncode == 1
    assert message in result.stderr
    assert not any(line.startswith("image_reference=") for line in outputs)
    if scenario.startswith("no-") and scenario != "no-tag":
        assert "build-from-source" in result.stderr


def _build_step(tmp_path: Path, uat_ref: str, described_digest: str):
    manifest, digest = _direct_manifest()
    add_tag_log = tmp_path / "add-tag.txt"
    script = str(_step(BUILD)["run"])
    script = script.replace("${{ env.GCP_PROJECT_ID }}", "hushh-pda")
    script = script.replace("${{ github.event.inputs.sha }}", SHA)
    for name in ("prod-backend-image.json", "prod-backend-image-manifest.json"):
        script = script.replace(
            f"/tmp/{name}",  # noqa: S108 - replace workflow paths with pytest isolation
            (tmp_path / name).as_posix(),
        )
    assert "${{" not in script
    guards = (
        'gcloud() { case "$1 $2 $3" in '
        f"'container images add-tag') printf '%s\\n' \"$@\" > '{add_tag_log}' ;; "
        f"'container images describe') printf '%s' '{described_digest}' ;; "
        "'auth configure-docker '*) return 0 ;; "
        "*) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;; esac; };\n"
        f"docker() {{ printf '%s' '{manifest}'; }};\n"
        f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
    )
    output = tmp_path / "github-output"
    environment = os.environ.copy()
    environment.pop("BASH_ENV", None)
    environment.update(
        {
            "GITHUB_OUTPUT": output.as_posix(),
            "BACKEND_IMAGE_SOURCE": "promote-from-uat",
            "UAT_VERIFIED_IMAGE_REFERENCE": uat_ref,
        }
    )
    result = subprocess.run(  # noqa: S603 - trusted workflow body, guarded commands
        [_bash(), "-c", guards + script],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    outputs = output.read_text().splitlines() if output.exists() else []
    add_tag = add_tag_log.read_text().splitlines() if add_tag_log.exists() else []
    return result, outputs, add_tag, digest


def test_promotion_copies_and_deploys_the_exact_uat_digest(tmp_path: Path) -> None:
    _, digest = _direct_manifest()
    uat_ref = f"{UAT_REPOSITORY}@{digest}"
    result, outputs, add_tag, _ = _build_step(tmp_path, uat_ref, digest)
    assert "UNEXPECTED_" not in result.stdout + result.stderr  # never `builds submit`
    assert result.returncode == 0, result.stderr
    assert add_tag == [
        "container",
        "images",
        "add-tag",
        "--quiet",
        uat_ref,
        f"{PROD_REPOSITORY}:prod-{SHA}",
    ]
    assert outputs == [
        f"image_reference={PROD_REPOSITORY}@{digest}",
        "image_source=promote-from-uat",
    ]


def test_promotion_refuses_a_copy_whose_digest_changed(tmp_path: Path) -> None:
    _, digest = _direct_manifest()
    result, outputs, _, _ = _build_step(
        tmp_path, f"{UAT_REPOSITORY}@{digest}", "sha256:" + "9" * 64
    )
    assert result.returncode != 0
    assert not any(line.startswith("image_reference=") for line in outputs)


@pytest.mark.parametrize(
    "uat_ref",
    [
        "",
        f"{UAT_REPOSITORY}:uat-{SHA}",
        "gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "4" * 64,
        f"{PROD_REPOSITORY}@sha256:" + "4" * 64,
    ],
)
def test_promotion_refuses_an_unverified_source(tmp_path: Path, uat_ref: str) -> None:
    _, digest = _direct_manifest()
    result, outputs, add_tag, _ = _build_step(tmp_path, uat_ref, digest)
    assert result.returncode == 1
    assert "missing or malformed" in result.stderr
    assert add_tag == []
    assert outputs == []
