"""Each dev pod release is published where Connect Azure imports it from, with no operator.

Azure's image reader is granted one pod-only release repository and nothing else, and
the hub's runtime identity cannot write there (measured 2026-10-05: the repository
grants only the reader; the hub holds aiplatform.user, cloudsql.client, run.admin and
secretAccessor). So `deploy/backend.cloudbuild.yaml` copies exactly the digest the hub
will offer into that repository, as the build identity, before `deploy-backend` can
offer it. These tests run the real step under bash with a fake ``gcloud``, the way
`test_pod_image_build_contract.py` runs the pod build guard, because a guard that is
merely present is not one that holds.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUDBUILD = REPO_ROOT / "deploy" / "backend.cloudbuild.yaml"
SYNC_SCRIPT = REPO_ROOT / "scripts" / "ops" / "sync_backend_runtime_secrets.py"
STEP_ID = "publish-azure-pod-release"
PROJECT = "hushh-pda-dev"
TAG = "dev-0123abcd-77-1"
DIGEST = "sha256:" + "c" * 64
POD_IMAGE = f"gcr.io/{PROJECT}/consent-protocol-pod@{DIGEST}"
RELEASE = f"us-central1-docker.pkg.dev/{PROJECT}/one-pod-release/consent-protocol-pod"

# Records every call, and keeps the release repository's digests in $FAKE_REGISTRY.
# FAKE_ADD_TAG: copy (the digest lands), lost (claims success, nothing lands), fail.
FAKE_GCLOUD = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_GCLOUD_LOG"
if [[ "$1 $2 $3 $4" == "artifacts docker images describe" ]]; then
  if grep -qxF "$5" "$FAKE_REGISTRY"; then printf '%s\n' "${5##*@}"; exit 0; fi
  exit 1
fi
if [[ "$1 $2 $3" == "container images add-tag" ]]; then
  [[ "$FAKE_ADD_TAG" == "fail" ]] && exit 1
  [[ "$FAKE_ADD_TAG" == "copy" ]] && printf '%s@%s\n' "${5%:*}" "${4##*@}" >> "$FAKE_REGISTRY"
  exit 0
fi
exit 2
"""


@pytest.fixture(scope="module")
def config() -> dict:
    return yaml.safe_load(CLOUDBUILD.read_text(encoding="utf-8"))


def _step(config: dict, step_id: str) -> dict:
    for step in config["steps"]:
        if step.get("id") == step_id:
            return step
    raise AssertionError(f"{step_id} step is missing from backend.cloudbuild.yaml")


@pytest.fixture(scope="module")
def script(config: dict) -> str:
    return str(_step(config, STEP_ID)["args"][1])


def _run(
    script: str,
    tmp_path: Path,
    *,
    deploy_env: str = "dev",
    build_flag: str = "true",
    pod_image: str = POD_IMAGE,
    published: tuple[str, ...] = (),
    add_tag: str = "copy",
    namespace: str = "",
) -> tuple[subprocess.CompletedProcess, list[str], list[str]]:
    """The step with Cloud Build's substitutions expanded textually, as Cloud Build does."""
    workspace, bin_dir = tmp_path / "workspace", tmp_path / "bin"
    workspace.mkdir()
    bin_dir.mkdir()
    (workspace / "pod-image-reference").write_text(pod_image + "\n")
    registry, log = tmp_path / "registry", tmp_path / "gcloud.log"
    registry.write_text("".join(f"{ref}\n" for ref in published))
    log.write_text("")
    gcloud = bin_dir / "gcloud"
    gcloud.write_text(FAKE_GCLOUD)
    gcloud.chmod(0o755)
    expanded = (
        script.replace("${_DEPLOY_ENV}", deploy_env)
        .replace("${_BUILD_POD_IMAGE}", build_flag)
        .replace("${_SECRET_PREFIX}", namespace)
        .replace("${_IMAGE_TAG}", TAG)
        .replace("$PROJECT_ID", PROJECT)
        .replace("/workspace/", f"{workspace}/")
    )
    assert "${_" not in expanded, "a Cloud Build substitution the test does not model"
    result = subprocess.run(  # noqa: S603 - fixed argv, repository-owned script
        ["bash", "-c", expanded],  # noqa: S607 - bash is resolved from PATH by design
        env={
            "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "FAKE_GCLOUD_LOG": str(log),
            "FAKE_REGISTRY": str(registry),
            "FAKE_ADD_TAG": add_tag,
        },
        text=True,
        capture_output=True,
        check=False,
    )
    return result, log.read_text().splitlines(), registry.read_text().splitlines()


@pytest.mark.parametrize(
    ("deploy_env", "build_flag"),
    [("uat", "true"), ("prod", "true"), ("production", "true"), ("manual", "true"), ("", "true"),
     ("dev", "false"), ("dev", "")],
)  # fmt: skip
def test_only_a_dev_pod_build_publishes(script, tmp_path, deploy_env, build_flag):
    result, calls, _ = _run(script, tmp_path, deploy_env=deploy_env, build_flag=build_flag)
    assert result.returncode == 0 and "skipped" in result.stdout
    assert calls == []


def test_a_new_digest_is_copied_and_proven_by_that_digest(script, tmp_path):
    result, calls, registry = _run(script, tmp_path)
    assert result.returncode == 0, result.stderr
    assert f"container images add-tag {POD_IMAGE} {RELEASE}:{TAG} --quiet" in calls
    # The proof reads back the exact digest after the copy, never a tag.
    assert calls[-1].startswith(f"artifacts docker images describe {RELEASE}@{DIGEST}")
    assert registry == [f"{RELEASE}@{DIGEST}"]
    assert f"published {DIGEST}" in result.stdout


def test_a_digest_already_published_is_left_alone(script, tmp_path):
    result, calls, _ = _run(script, tmp_path, published=(f"{RELEASE}@{DIGEST}",))
    assert result.returncode == 0, result.stderr
    assert not any("add-tag" in call for call in calls)
    assert "already published" in result.stdout


@pytest.mark.parametrize("add_tag", ["lost", "fail"])
def test_a_copy_that_does_not_land_stops_the_deploy(script, tmp_path, add_tag):
    result, _, registry = _run(script, tmp_path, add_tag=add_tag)
    assert result.returncode != 0
    assert registry == []


def test_a_mutable_pod_reference_is_never_published(script, tmp_path):
    result, calls, _ = _run(
        script, tmp_path, pod_image=f"gcr.io/{PROJECT}/consent-protocol-pod:latest"
    )
    assert result.returncode == 1 and "not a digest" in result.stderr
    assert calls == []


def test_deploy_cannot_offer_a_release_before_it_is_published(config):
    dependencies: dict[str, set[str]] = {}
    preceding: list[str] = []
    for step in config["steps"]:
        dependencies[step["id"]] = set(step.get("waitFor", preceding)) - {"-"}
        preceding.append(step["id"])

    def ancestors(step_id: str) -> set[str]:
        direct = dependencies[step_id]
        return direct | {ancestor for parent in direct for ancestor in ancestors(parent)}

    assert STEP_ID in ancestors("deploy-backend")
    assert "resolve-pod-image-digest" in ancestors(STEP_ID)


def test_the_build_publishes_where_the_hub_imports_from(script):
    spec = importlib.util.spec_from_file_location("sync_backend_runtime_secrets", SYNC_SCRIPT)
    assert spec is not None and spec.loader is not None
    sync = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync)
    configured = sync._AZURE_OWNER_CLOUD_BY_PROJECT[PROJECT]["hussh_azure_pod_image_repository"]
    assert f'release_repository="{configured.replace(PROJECT, "$PROJECT_ID")}"' in script
    assert configured == RELEASE


def test_the_step_publishes_the_digest_the_hub_offers(script):
    """The hub's HUSSH_ONE_POD_IMAGE comes from the same workspace record."""
    offered = (REPO_ROOT / "scripts" / "deploy" / "pod-release-env.sh").read_text()
    assert "/workspace/pod-image-reference" in script
    assert '"${workspace}/pod-image-reference"' in offered


def test_the_step_never_changes_who_may_read_or_write(script):
    """Publishing copies bytes; it must never widen the reader or grant the hub."""
    for forbidden in ("iam-policy", "add-iam", "set-iam", "roles/", "serviceAccount:"):
        assert forbidden not in script


def test_isolated_preview_never_publishes_shared_azure_pod_release(script, tmp_path):
    result, calls, registry = _run(script, tmp_path, namespace="SCOPE_COMMERCE_SANDBOX_")
    assert result.returncode == 0 and "skipped" in result.stdout
    assert calls == [] and registry == []


def test_reused_publication_archive_follows_its_image_source_and_new_run(config, tmp_path):
    """The real reuse branch archives where a subsequent verified pin looks."""
    import json
    import sys

    source_sha, descriptor_sha, run_id = "a" * 40, "d" * 40, "101"
    workspace, bin_dir, deploy = (tmp_path / name for name in ("workspace", "bin", "deploy"))
    for path in (workspace, bin_dir, deploy):
        path.mkdir()
    (deploy / "pod-release-reuse.json").write_text("{}")
    (deploy / "pod-release.json").write_bytes((REPO_ROOT / "deploy/pod-release.json").read_bytes())
    # Registry/archive validation has its own negative controls. Stub that I/O;
    # execute the actual Cloud Build branch and actual descriptor assembler.
    python = bin_dir / "python3"
    python.write_text(
        f"#!{sys.executable}\n"
        "import os,sys\nfrom pathlib import Path\n"
        "if Path(sys.argv[1]).name == 'reuse-pod-release.py':\n"
        " p=Path(sys.argv[sys.argv.index('--workspace')+1])\n"
        f" (p/'pod-image-source-sha').write_text({source_sha!r})\n"
        f" (p/'pod-image-reference').write_text({POD_IMAGE!r})\n"
        "else:\n"
        " if Path(sys.argv[1]).name == 'assemble-pod-release.py':\n"
        "  sys.argv += ['--browser-qualifications',os.environ['FAKE_BROWSER_PINS']]\n"
        " os.execv(sys.executable,[sys.executable,*sys.argv[1:]])\n"
    )
    gcloud = bin_dir / "gcloud"
    gcloud.write_text(
        "#!/usr/bin/env bash\nset -euo pipefail\n"
        '[[ "$1 $2" == "storage cp" ]] || exit 2\n'
        'cp "$3" "$FAKE_ARCHIVE"\nprintf "%s\\n" "$4" > "$FAKE_DESTINATION"\n'
    )
    for program in (python, gcloud):
        program.chmod(0o755)
    script = str(_step(config, "resolve-pod-image-digest")["args"][1])
    for key, value in {
        "_DEPLOY_ENV": "dev",
        "_BUILD_POD_IMAGE": "true",
        "_SECRET_PREFIX": "",
        "_DEPLOY_SHA": descriptor_sha,
        "_GITHUB_RUN_ID": run_id,
        "_IMAGE_TAG": TAG,
        "PROJECT_ID": PROJECT,
    }.items():
        script = script.replace("${" + key + "}", value)
    script = script.replace("$PROJECT_ID", PROJECT).replace("/workspace", str(workspace))
    script = script.replace(
        "scripts/deploy/assemble-pod-release.py",
        str(REPO_ROOT / "scripts/deploy/assemble-pod-release.py"),
    )
    archive, destination = tmp_path / "archived.json", tmp_path / "destination"
    # Execute only repository-authored build code with synthetic substitutions.
    result = subprocess.run(  # noqa: S603
        ["bash", "-c", script],
        cwd=tmp_path,
        env={
            "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "FAKE_ARCHIVE": str(archive),
            "FAKE_DESTINATION": str(destination),
            "FAKE_BROWSER_PINS": str(tmp_path / "browser-pins.json"),
        },
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    published = json.loads(archive.read_text())
    assert published["image"] == POD_IMAGE
    assert published["sourceRevision"] == source_sha
    assert published["publisher"]["runId"] == run_id
    assert (
        destination.read_text().strip()
        == f"gs://{PROJECT}_cloudbuild/pod-releases/{source_sha}/{run_id}/release.json"
    )


def _publication_builder():
    path = REPO_ROOT / "scripts/deploy/prepare-pod-publication.py"
    spec = importlib.util.spec_from_file_location("publication_build_contract", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_preparation_uses_only_existing_pod_steps_and_requires_guarded_reuse(tmp_path):
    builder = _publication_builder()
    (tmp_path / "deploy").mkdir()
    source = REPO_ROOT / "deploy/backend.cloudbuild.yaml"
    (tmp_path / "deploy/backend.cloudbuild.yaml").write_bytes(source.read_bytes())
    result = builder.build_config(tmp_path, sha="d" * 40, run_id="77", attempt="1")
    original = yaml.safe_load(source.read_text())
    assert [s["id"] for s in result["steps"]] == list(builder.STEP_IDS)
    for step in result["steps"]:
        authored = next(s for s in original["steps"] if s["id"] == step["id"])
        assert {k: v for k, v in step.items() if k != "waitFor"} == {
            k: v for k, v in authored.items() if k != "waitFor"
        }
    pin = tmp_path / "deploy/pod-release-reuse.json"
    pin.write_text("{}")
    with pytest.raises(ValueError, match="Main-owned"):
        builder.build_config(tmp_path, sha="d" * 40, run_id="77", attempt="1")
    builder.build_config(
        tmp_path,
        sha="d" * 40,
        run_id="77",
        attempt="1",
        verified_reuse_sha=hashlib.sha256(pin.read_bytes()).hexdigest(),
    )


def test_workflow_publication_uses_real_protocol_project_before_cloud_authentication():
    workflow = yaml.safe_load((REPO_ROOT / ".github/workflows/deploy-dev.yml").read_text())
    job = workflow["jobs"]["pod-publication"]
    steps = job["steps"]
    setup = next(step for step in steps if step.get("uses", "").endswith("setup-python-uv"))
    project = REPO_ROOT / setup["with"]["protocol-dir"]
    assert (project / "pyproject.toml").is_file() and (project / "uv.lock").is_file()
    auth = next(
        i
        for i, step in enumerate(steps)
        if step.get("uses", "").startswith("google-github-actions/auth@")
    )
    for required in (
        "Admit Main-owned pod publication",
        "Verify exact pod source CI and ref",
        "Verify landed publication control source",
        "Verify metadata reuse with Main-owned source guard",
    ):
        assert next(i for i, step in enumerate(steps) if step.get("name") == required) < auth
    assert steps[0]["with"]["ref"] == "${{ github.sha }}"
    assert "pod-publication" in workflow["jobs"]["deploy"]["if"]
    assert "pod-publication" not in workflow["concurrency"]["group"]
