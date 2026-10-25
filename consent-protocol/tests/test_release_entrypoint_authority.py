"""Release entrypoints preserve source and authority; untrusted inputs stay data."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def _workflow(name):
    return yaml.safe_load((ROOT / ".github/workflows" / name).read_text())


def _expand(value, context):
    return re.sub(r"\$\{\{\s*(.*?)\s*\}\}", lambda match: context[match[1]], str(value))


def _execute_step(step, directory, context, **env):
    variables = {key: _expand(value, context) for key, value in step.get("env", {}).items()}
    return subprocess.run(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
        ["bash", "-eu", "-c", _expand(step["run"], context)],
        cwd=directory,
        env={**os.environ, **variables, **env},
        capture_output=True,
        text=True,
        timeout=10,
    )


@pytest.mark.parametrize("lane", ["uat", "production"])
def test_failure_summary_treats_dispatch_input_as_literal_text(tmp_path, lane):
    steps = _workflow("rollback.yml")["jobs"][f"rollback-{lane}"]["steps"]
    summary = next(step for step in steps if step.get("name") == "Rollback summary")
    assert summary["if"] == "always()"  # Preserve useful denied/failed-run audit output.
    sentinel = tmp_path / "executed"
    hostile = f'$(touch "{sentinel}")"; touch "{sentinel}"; #\nsecond line'
    context = {
        "github.event.inputs.reason": hostile,
        "github.event.inputs.scope": "all",
        "steps.rollback-backend.outputs.revision || 'n/a (not in scope)'": hostile,
        "steps.rollback-frontend.outputs.revision || 'n/a (not in scope)'": "n/a (not in scope)",
    }
    output = tmp_path / "summary"
    result = _execute_step(
        summary, tmp_path, context, GITHUB_STEP_SUMMARY=str(output), GITHUB_ACTOR="synthetic"
    )
    assert result.returncode == 0, result.stderr
    assert not sentinel.exists()
    assert hostile in output.read_text()


@pytest.mark.parametrize("lane", ["uat", "production"])
@pytest.mark.parametrize("surface", ["backend", "frontend"])
def test_rollback_revision_is_one_literal_resolver_argument(tmp_path, lane, surface):
    job = _workflow("rollback.yml")["jobs"][f"rollback-{lane}"]
    step = next(s for s in job["steps"] if s.get("id") == f"rollback-{surface}")
    helpers = tmp_path / "scripts/ci"
    helpers.mkdir(parents=True)
    (helpers / "resolve-rollback-target.sh").write_text(
        'printf "%s" "$3" > "$CAPTURE"\nprintf "verified-revision\\n"\n'
    )
    (helpers / "cloudrun-rollback.sh").write_text('test "$3" = verified-revision\n')
    sentinel = tmp_path / "executed"
    hostile = f'$(touch "{sentinel}")"; touch "{sentinel}"; #'
    context = {
        f"github.event.inputs.{surface}_revision": hostile,
        f"env.{surface.upper()}_SERVICE": "service",
        "env.GCP_REGION": "region",
        "env.GCP_PROJECT_ID": "project",
    }
    capture = tmp_path / "argument"
    result = _execute_step(
        step, tmp_path, context, CAPTURE=str(capture), GITHUB_OUTPUT=str(tmp_path / "output")
    )
    assert result.returncode == 0, result.stderr
    assert not sentinel.exists()
    assert capture.read_text() == hostile


@pytest.mark.parametrize(
    "requested,checkout,passes", [("a", "a", True), ("b", "a", False), ("a", "b", False)]
)
def test_smoke_identity_executes_the_actual_checkout_comparison(
    tmp_path, requested, checkout, passes
):
    step = next(
        s
        for s in _workflow("main-post-merge-smoke.yml")["jobs"]["smoke-gate"]["steps"]
        if s.get("name") == "Verify smoke source identity"
    )
    stubs = tmp_path / "bin"
    stubs.mkdir()
    git = stubs / "git"
    git.write_text('#!/bin/sh\n[ "$1" != rev-parse ] || printf "%s\\n" "$CHECKOUT_SHA"\n')
    git.chmod(0o755)
    result = _execute_step(
        step,
        tmp_path,
        {"github.event.inputs.sha || github.sha": requested * 40},
        GITHUB_SHA="a" * 40,
        CHECKOUT_SHA=checkout * 40,
        GITHUB_EVENT_NAME="workflow_dispatch",
        PATH=f"{stubs}:{os.environ['PATH']}",
    )
    assert (result.returncode == 0) is passes, result.stderr


@pytest.fixture
def release_repository(tmp_path):
    def git(*args):
        return subprocess.check_output(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
            ["git", *args], cwd=tmp_path, text=True, stderr=subprocess.DEVNULL
        ).strip()

    git("init", "-b", "main")
    git("config", "user.name", "Synthetic")
    git("config", "user.email", "synthetic@example.test")
    git("config", "core.hooksPath", "/dev/null")
    git("config", "commit.gpgsign", "false")
    source = tmp_path / "source"
    source.write_text("accepted")
    git("add", ".")
    git("commit", "-m", "accepted")
    accepted = git("rev-parse", "HEAD")
    source.write_text("later")
    git("commit", "-am", "later")
    git("remote", "add", "origin", str(tmp_path / ".git"))
    source.write_text("uncommitted work must never be uploaded")
    stubs = tmp_path / "bin"
    stubs.mkdir()
    gh = stubs / "gh"
    gh.write_text(
        '#!/usr/bin/env python3\nimport json,os,sys\njson.dump(sys.argv[1:],open(os.environ["DISPATCH"],"w"))\n'
    )
    gh.chmod(0o755)
    gcloud = stubs / "gcloud"
    gcloud.write_text("#!/bin/sh\nexit 97\n")
    gcloud.chmod(0o755)
    return (
        accepted,
        git("rev-parse", "HEAD"),
        {
            **os.environ,
            "PATH": f"{stubs}:{os.environ['PATH']}",
            "DISPATCH": str(tmp_path / "dispatch"),
        },
    )


@pytest.mark.parametrize("lane", ["dev", "uat", "production"])
def test_fallback_dispatches_immutable_content_without_uploading_dirty_checkout(
    tmp_path, release_repository, lane
):
    accepted, head, env = release_repository
    result = subprocess.run(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
        [
            "bash",
            str(ROOT / "scripts/ops/cloudbuild_release.sh"),
            "--env",
            lane,
            "--sha",
            accepted,
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    args = json.loads((tmp_path / "dispatch").read_text())
    assert args == [
        "workflow",
        "run",
        f"deploy-{lane}.yml",
        "--repo",
        "hushh-labs/hushh-research",
        "--ref",
        "main",
        "-f",
        f"sha={accepted}",
        "-f",
        "scope=auto",
    ] + (["-f", "ref=main"] if lane == "dev" else [])
    assert (
        subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True).strip()
        == head
    )
    assert (tmp_path / "source").read_text() == "uncommitted work must never be uploaded"
    assert "Dispatch requested" in result.stdout and "healthy" not in result.stdout


@pytest.mark.parametrize("flag", ["--skip-ci-check", "--skip-migrations", "--from", "--fast-gate"])
def test_local_release_cannot_waive_governed_gates(tmp_path, release_repository, flag):
    accepted, _, env = release_repository
    result = subprocess.run(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
        [
            "bash",
            str(ROOT / "scripts/ops/cloudbuild_release.sh"),
            "--env",
            "uat",
            "--sha",
            accepted,
            flag,
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0
    assert not (tmp_path / "dispatch").exists()


def test_fallback_dry_run_never_dispatches(tmp_path, release_repository):
    accepted, _, env = release_repository
    result = subprocess.run(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
        [
            "bash",
            str(ROOT / "scripts/ops/cloudbuild_release.sh"),
            "--env",
            "uat",
            "--sha",
            accepted,
            "--dry-run",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "dispatch").exists()


def test_cloudbuild_diagnostics_have_no_check_publication_credentials():
    config = yaml.safe_load((ROOT / "deploy/ci.cloudbuild.yaml").read_text())
    assert not config.get("availableSecrets")
    assert all(not step.get("secretEnv") for step in config["steps"])
    assert "_PUBLISH_CHECK" not in config["substitutions"]
    assert "_CHECK_NAME" not in config["substitutions"]
    for step in config["steps"]:
        source = "\n".join(step.get("args", []))
        assert not re.search(r"(?<!\$)\$\{_(?:SHA|BASE_SHA|STAGE|GITLEAKS_LOG_OPTS)\}", source)


@pytest.mark.parametrize(
    "stage,docs_fail", [("advisory", False), ("advisory", True), ("all", False), ("all", True)]
)
def test_orchestration_runs_docs_once_without_weakening_failure(tmp_path, stage, docs_fail):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    scripts = tmp_path / "scripts/ci"
    scripts.mkdir(parents=True)
    shutil.copy(ROOT / "scripts/ci/orchestrate.sh", scripts / "orchestrate.sh")
    for name in [
        "secret-scan",
        "web-full-check",
        "protocol-check",
        "hushh-mcp-package-check",
        "integration-check",
        "subtree-sync-check",
        "github-security-alerts",
        "verify-production-environment-governance",
    ]:
        p = scripts / f"{name}.sh"
        p.write_text("#!/bin/sh\nexit 0\n")
        p.chmod(0o755)
    for name in ["repo-governance-check", "docs-parity-check"]:
        p = scripts / f"{name}.sh"
        p.write_text("#!/bin/sh\nexec ./bin/hushh docs verify\n")
        p.chmod(0o755)
    (tmp_path / "bin").mkdir()
    hushh = tmp_path / "bin/hushh"
    hushh.write_text(
        '#!/bin/sh\nif [ "$1" = docs ]; then echo docs >> "$DOC_LOG"; [ "$DOC_FAIL" = 0 ]; fi\n'
    )
    hushh.chmod(0o755)
    result = subprocess.run(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
        ["bash", str(scripts / "orchestrate.sh"), stage],
        cwd=tmp_path,
        env={
            **os.environ,
            "INCLUDE_ADVISORY_CHECKS": "1",
            "governance_passed": "1",
            "DOC_LOG": str(tmp_path / "docs"),
            "DOC_FAIL": str(int(docs_fail)),
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert (tmp_path / "docs").read_text().splitlines() == ["docs"]
    assert (result.returncode == 0) is not docs_fail, result.stderr


def test_legacy_pipeline_uses_the_same_governed_dispatch(tmp_path, release_repository):
    accepted, _, env = release_repository
    helpers = tmp_path / "scripts/ops"
    helpers.mkdir(parents=True)
    shutil.copy(ROOT / "scripts/ops/cloudbuild_release.sh", helpers / "cloudbuild_release.sh")
    result = subprocess.run(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
        [
            "bash",
            str(ROOT / "scripts/ops/release_pipeline.sh"),
            "--env",
            "uat",
            "--sha",
            accepted,
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads((tmp_path / "dispatch").read_text())[2] == "deploy-uat.yml"


@pytest.mark.parametrize("failure", ["fetch", "non-main"])
def test_dispatch_refuses_unverified_main_ancestry(tmp_path, release_repository, failure):
    accepted, _, env = release_repository
    if failure == "fetch":
        subprocess.run(["git", "remote", "remove", "origin"], cwd=tmp_path, check=True)
    else:
        subprocess.run(
            ["git", "checkout", "--orphan", "isolated"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
        )
        subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
        subprocess.run(
            ["git", "commit", "-m", "unrelated"], cwd=tmp_path, check=True, capture_output=True
        )
        accepted = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True
        ).strip()
    result = subprocess.run(  # noqa: S603 - repository script or fixed Git fixture, hermetic inputs
        [
            "bash",
            str(ROOT / "scripts/ops/cloudbuild_release.sh"),
            "--env",
            "uat",
            "--sha",
            accepted,
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0
    assert not (tmp_path / "dispatch").exists()


def test_sha_gate_callers_include_read_only_actions_authority():
    for path in (ROOT / ".github/workflows").glob("*.yml"):
        workflow = yaml.safe_load(path.read_text())
        for name, job in workflow.get("jobs", {}).items():
            consumers = ("require-deploy-sha-on-main.sh", "wait-uat-capacity.py")
            if not any(
                any(consumer in step.get("run", "") for consumer in consumers)
                for step in job.get("steps", [])
            ):
                continue
            permissions = job.get("permissions", workflow.get("permissions", {}))
            assert permissions.get("actions") in {"read", "write"}, (path.name, name)
            assert permissions.get("checks") in {"read", "write"}, (path.name, name)
