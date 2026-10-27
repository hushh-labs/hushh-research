# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Original-pair recovery, retry provenance and production mutation boundaries."""

from __future__ import annotations

import copy
import hashlib
import json
import runpy
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZipFile

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


@pytest.fixture
def operation(monkeypatch):
    module = runpy.run_path(str(ROOT / "deploy/account-deletion/restoration_operation.py"))
    record = json.loads((ROOT / "deploy/account-deletion/production-restoration.json").read_text())
    revisions, services = {}, {}
    for service, value in record["previousServices"].items():
        env = {
            "HUSHH_DEPLOY_ENV": "production",
            "HUSHH_DEPLOY_SOURCE": "deploy-production",
            "HUSHH_DEPLOY_SHA": value["sha"],
            "HUSHH_DEPLOY_RUN_ID": value["deployRunId"],
        }
        revisions[value["revision"]] = {
            "metadata": {
                "name": value["revision"],
                "labels": {
                    "serving.knative.dev/service": service,
                    "deploy-env": "production",
                    "deploy-source": "deploy-production",
                    "deploy-sha": value["sha"],
                    "github-run-id": value["deployRunId"],
                    "account-deletion-contract": "v201",
                },
            },
            "spec": {
                "serviceAccountName": value["runtimePrincipal"],
                "containers": [
                    {
                        "image": value["image"],
                        "env": [{"name": k, "value": v} for k, v in env.items()],
                    }
                ],
            },
            "status": {
                "imageDigest": value["image"],
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
        services[service] = {
            "metadata": {"name": service},
            "status": {
                "url": f"https://{service}-test.a.run.app",
                "traffic": [{"revisionName": value["revision"], "percent": 100}],
            },
        }

    # Source admission has its own negative controls. These runtime tests use
    # the recorded policy without depending on a separately fetched Git ref.
    def source(sha):
        module["require"](sha == record["sourceSha"], "Unrecorded source")
        return copy.deepcopy(record)

    monkeypatch.setitem(module["AUTHORITY"], "qualify_source", source)
    calls = []
    globals_ = module["initial_plan"].__globals__
    monkeypatch.setitem(
        globals_,
        "cloud",
        lambda kind, name: copy.deepcopy(
            revisions[name] if kind == "revisions" else services[name]
        ),
    )
    monkeypatch.setitem(globals_, "command", lambda command, **kwargs: calls.append(command) or "")
    args = dict(sha=record["sourceSha"], run_id="42", workflow_sha="a" * 40)
    return SimpleNamespace(
        module=module, record=record, revisions=revisions, services=services, calls=calls, args=args
    )


@pytest.mark.parametrize(
    "failure",
    [
        None,
        "source",
        "principal",
        "image",
        "ready",
        "launcher",
        "secret-env",
        "duplicate-env",
        "generation-secret",
        "traffic",
    ],
)
def test_original_pair_requires_live_identity_digest_health_and_sole_traffic(operation, failure):
    op = operation
    expected = op.record["previousServices"]["consent-protocol"]
    revision = op.revisions[expected["revision"]]
    container = revision["spec"]["containers"][0]
    if failure == "source":
        revision["metadata"]["labels"]["deploy-sha"] = "b" * 40
    elif failure == "principal":
        revision["spec"]["serviceAccountName"] = "another-owner@example.test"
    elif failure == "image":
        revision["status"]["imageDigest"] = "unqualified@sha256:" + "b" * 64
    elif failure == "ready":
        revision["status"]["conditions"] = []
    elif failure == "launcher":
        container["command"] = ["unreviewed"]
    elif failure == "secret-env":
        container["env"][0] = {
            "name": "HUSHH_DEPLOY_ENV",
            "valueFrom": {"secretKeyRef": {"name": "mutable"}},
        }
    elif failure == "duplicate-env":
        container["env"].append(container["env"][0])
    elif failure == "generation-secret":
        container["env"].append(
            {
                "name": "ACCOUNT_GENERATION_ADMISSION_ENABLED",
                "valueFrom": {"secretKeyRef": {"name": "mutable"}},
            }
        )
    elif failure == "traffic":
        op.services["consent-protocol"]["status"]["traffic"][0]["revisionName"] = "other-revision"
    if failure:
        with pytest.raises(ValueError):
            op.module["initial_plan"](**op.args)
    else:
        plan = op.module["initial_plan"](**op.args)
        assert plan["previous"] == op.record["previousServices"]
        assert len(op.calls) == 2 and all(call[0] == "bash" for call in op.calls)
        assert op.module["qualify_plan"](plan, **op.args) == op.record


@pytest.mark.parametrize(
    "failure", ["runId", "sourceSha", "workflowSha", "recordSha256", "previous"]
)
def test_resumed_operation_cannot_replace_original_pair_or_cross_runs(operation, failure):
    plan = operation.module["initial_plan"](**operation.args)
    plan[failure] = {} if failure == "previous" else "wrong"
    with pytest.raises(ValueError, match="immutable baseline"):
        operation.module["qualify_plan"](plan, **operation.args)


@pytest.mark.parametrize(
    "failure", [None, "run", "workflow", "artifact", "digest", "publication", "truncated"]
)
def test_retry_uses_only_the_same_runs_confirmed_immutable_baseline(operation, failure):
    module = operation.module
    plan = module["initial_plan"](**operation.args)
    payload = BytesIO()
    with ZipFile(payload, "w") as bundle:
        bundle.writestr("acceptance.json", json.dumps(plan))
    archive = payload.getvalue()
    artifact = {
        "id": 9,
        "name": "production-restoration-operation-42-1",
        "expired": False,
        "size_in_bytes": len(archive),
        "digest": "sha256:" + hashlib.sha256(archive).hexdigest(),
        "workflow_run": {"id": 42, "head_sha": "a" * 40},
    }
    run = {
        "id": 42,
        "run_attempt": 2,
        "head_sha": "a" * 40,
        "head_branch": "main",
        "path": module["WORKFLOW"],
        "event": "workflow_dispatch",
        "repository": {"full_name": module["TRANSPORT"]["REPOSITORY"]},
    }
    step = {
        "name": "Upload immutable recovery baseline",
        "status": "completed",
        "conclusion": "success",
    }
    if failure == "run":
        run["id"] = 43
    elif failure == "workflow":
        run["head_branch"] = "feature"
    elif failure == "artifact":
        artifact["workflow_run"]["id"] = 43
    elif failure == "digest":
        artifact["digest"] = "sha256:" + "0" * 64
    elif failure == "publication":
        step["conclusion"] = "skipped"
    answers = {
        "runs/42": run,
        "runs/42/artifacts?per_page=100": {
            "total_count": 101 if failure == "truncated" else 1,
            "artifacts": [artifact],
        },
        "runs/42/attempts/1/jobs?per_page=100": {"total_count": 1, "jobs": [{"steps": [step]}]},
        "artifacts/9/zip": archive,
    }
    client = SimpleNamespace(read=lambda path, **_kwargs: answers[path])
    if failure:
        with pytest.raises(ValueError):
            module["previous_plan"](client, run_id="42", attempt=2, workflow_sha="a" * 40)
    else:
        assert (
            module["previous_plan"](client, run_id="42", attempt=2, workflow_sha="a" * 40) == plan
        )


def test_recovery_workflow_joins_images_and_preserves_ordinary_migrations():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    ids = {step.get("id"): index for index, step in enumerate(steps) if step.get("id")}
    assert ids["phone-rollback-plan"] < ids["install-account-deletion-fence"]
    assert ids["build-backend-image"] < ids["install-account-deletion-fence"]
    assert ids["build-frontend-image"] < ids["install-account-deletion-fence"]
    gate = steps[ids["predeploy-db-gate"]]
    assert 'if [ -n "$RESTORATION_RUN" ]; then' in gate["run"]
    assert "restoration_database.py prepare" in gate["run"]
    assert gate["run"].index("restoration_database.py prepare") < gate["run"].index("db/migrate.py")
    assert "else\n" in gate["run"] and "--migration-mode replay" in gate["run"]
    for step_id in ("deploy-drive-worker", "promote-traffic", "pause-drive-worker", "classify"):
        assert "maintenance_required" in json.dumps(steps[ids[step_id]])
    assert "--production-restoration" in steps[ids["activate-account-deletion"]]["run"]
    assert "restoration_operation.py verify" in steps[ids["phone-rollback-qualified"]]["run"]


def test_cleanup_failure_recovery_requires_both_original_readers(operation):
    plan = operation.module["initial_plan"](**operation.args)
    operation.services["hushh-webapp"]["status"]["traffic"][0]["revisionName"] = (
        "partial-restoration"
    )
    with pytest.raises(ValueError, match="baseline has changed"):
        operation.module["restore_cleanup"](plan, **operation.args)
    assert all(call[0] == "bash" for call in operation.calls)


@pytest.mark.parametrize("foreign", [False, True])
@pytest.mark.parametrize("ready", [False, True])
def test_retry_phase_accepts_only_this_operations_partial_promotion(operation, foreign, ready):
    op = operation
    plan = op.module["initial_plan"](**op.args)
    original = op.record["previousServices"]["hushh-webapp"]
    candidate = copy.deepcopy(op.revisions[original["revision"]])
    name = "hushh-webapp-recovery-candidate"
    candidate["metadata"]["name"] = name
    candidate["status"]["conditions"] = [{"type": "Ready", "status": "True" if ready else "False"}]
    labels = candidate["metadata"]["labels"]
    labels.update({"deploy-sha": op.args["sha"], "github-run-id": "43" if foreign else "42"})
    for row in candidate["spec"]["containers"][0]["env"]:
        if row["name"] == "HUSHH_DEPLOY_SHA":
            row["value"] = op.args["sha"]
        if row["name"] == "HUSHH_DEPLOY_RUN_ID":
            row["value"] = labels["github-run-id"]
    op.revisions[name] = candidate
    op.services["hushh-webapp"]["status"]["traffic"][0]["revisionName"] = name
    if foreign:
        with pytest.raises(ValueError):
            op.module["qualify_plan"](plan, **op.args)
    else:
        assert op.module["qualify_plan"](plan, **op.args) == op.record


@pytest.mark.parametrize("recovery", ["true", "false"])
@pytest.mark.parametrize("failed_service", ["backend", "frontend"])
def test_recovery_health_failure_rolls_back_the_pair_and_preserves_normal_scope(
    tmp_path, recovery, failed_service
):
    import os
    import subprocess

    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    step = next(
        step for step in workflow["jobs"]["deploy"]["steps"] if step.get("id") == "classify"
    )
    output = tmp_path / "output"
    values = {key: "success" for key in step["env"]}
    values.update(
        RECOVERY_MODE=recovery,
        DEPLOY_BACKEND="true",
        DEPLOY_FRONTEND="true",
        DRIVE_ENABLED="false",
        DOCUMENT_DELIVERY_CONFIGURED="false",
        DRIVE_PAUSE_SNAPSHOT="",
        DRIVE_WORKER_OUTCOME="skipped",
        GITHUB_OUTPUT=str(output),
    )
    values["HEALTH_" + failed_service.upper()] = "failure"
    result = subprocess.run(  # noqa: S603 -- actual authored classifier, no cloud operations.
        ["bash", "-euc", step["run"]],
        env={**os.environ, **values},
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr
    observed = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert observed[failed_service + "_failure"] == "true"
    other = "frontend" if failed_service == "backend" else "backend"
    assert observed[other + "_failure"] == ("true" if recovery == "true" else "false")
    assert observed["release_failed"] == "true"


@pytest.mark.parametrize(
    ("restoration", "fallback", "reservation"),
    [
        ("42", "", ["--candidate-service", "consent-protocol"]),
        ("", "", []),
        ("", "a" * 40, ["--additional-candidate-service", "consent-protocol"]),
    ],
)
def test_recovery_reserves_only_its_real_candidate(tmp_path, restoration, fallback, reservation):
    import os
    import subprocess

    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("name") == "Enforce production database connection budget before deployment"
    )
    assert "RESTORATION_RUN" in step["env"]
    # Capture the actual authored invocation without contacting a cloud provider.
    timeout = tmp_path / "timeout"
    timeout.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n')
    timeout.chmod(0o755)
    capture = tmp_path / "args"
    subprocess.run(  # noqa: S603 -- authored workflow with the provider command replaced.
        ["bash", "-euc", step["run"]],
        check=True,
        timeout=5,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "RESTORATION_RUN": restoration,
            "PHONE_DEPLOY_PHASE": "standard",
            "STAGED_WORKER_LOADED": "false",
            "PHONE_ROLLBACK_SHA": fallback,
            "CAPTURE": str(capture),
        },
    )
    assert capture.read_text().splitlines() == [
        "--signal=TERM",
        "--kill-after=2s",
        "295s",
        "python3",
        "scripts/ci/runtime-capacity-budget.py",
        "--environment",
        "production",
        *reservation,
    ]


def _history_authority(monkeypatch, tmp_path):
    authority = runpy.run_path(str(ROOT / "deploy/account-deletion/compatibility_restoration.py"))
    record = json.loads((ROOT / "deploy/account-deletion/production-restoration.json").read_text())
    policy = '{"version": 1}\n'
    record["authorityPolicySha256"] = hashlib.sha256(policy.encode()).hexdigest()
    selected = tmp_path / "restoration.json"
    selected.write_text(json.dumps(record))
    globals_ = authority["qualify_source"].__globals__
    monkeypatch.setitem(globals_, "RECORD", selected)

    def git(*args):
        assert args in (
            ("merge-base", "--is-ancestor", record["baselineSha"], record["sourceSha"]),
            ("show", f"{record['sourceSha']}:{authority['POLICY']}"),
        )
        return policy if args[0] == "show" else ""

    monkeypatch.setitem(globals_, "git", git)
    return authority, record


@pytest.mark.parametrize(
    "changed", [None, "enabled", "missing", "secret", "birth-enabled", "unknown", "dev", "uat"]
)
def test_workos_default_history_admits_only_production_exact_closed_restoration(
    operation, monkeypatch, tmp_path, changed
):
    import subprocess

    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    import workos_rollout as closed

    authority, record = _history_authority(monkeypatch, tmp_path)
    source = record["sourceSha"]
    revision = copy.deepcopy(next(iter(operation.revisions.values())))
    revision["metadata"].update(creationTimestamp="2026-10-26T06:00:00Z")
    revision["metadata"]["labels"]["deploy-sha"] = "e" * 40 if changed == "unknown" else source
    env = revision["spec"]["containers"][0]["env"]
    flag = {"name": "WORKOS_SSO_ENABLED", "value": "true" if changed == "enabled" else "false"}
    if changed == "secret":
        flag = {"name": "WORKOS_SSO_ENABLED", "valueFrom": {"secretKeyRef": {"name": "flag"}}}
    if changed != "missing":
        env.append(flag)
    birth = copy.deepcopy(revision)
    if changed == "birth-enabled":
        birth["spec"]["containers"][0]["env"][-1]["value"] = "true"
    event = {
        "resource": {"labels": {"service_name": closed.SERVICE}},
        "timestamp": birth["metadata"]["creationTimestamp"],
        "logName": "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Factivity",
        "protoPayload": {
            "serviceName": "run.googleapis.com",
            "methodName": "/Services.ReplaceService",
            "response": {
                "kind": "Service",
                "spec": {"template": birth},
                "status": {"latestCreatedRevisionName": birth["metadata"]["name"]},
            },
        },
    }
    monkeypatch.setattr(closed, "run_path", lambda _path: authority)

    def main_only(_sha):
        raise subprocess.CalledProcessError(1, ["git", "merge-base"])

    monkeypatch.setattr(closed, "source_capable", main_only)
    monkeypatch.setattr(
        closed,
        "_document",
        lambda command: [event] if command[1:3] == ["logging", "read"] else [revision],
    )
    databases = []
    monkeypatch.setattr(
        closed, "database_evidence", lambda project: databases.append(project) or {}
    )
    project = "hushh-pda-" + changed if changed in {"dev", "uat"} else "hushh-pda"
    with pytest.raises(ValueError, match="reviewed production restoration"):
        closed._capable("e" * 40, "e" * 40)
    if changed in {"dev", "uat"}:
        with pytest.raises(ValueError, match="restoration_project_invalid"):
            closed.qualify(project, source)
    if changed:
        with pytest.raises((ValueError, subprocess.CalledProcessError)):
            closed.qualify(project)
        assert databases == []
    else:
        result = closed.qualify(project)
        assert result["restoration_source"] == source
        assert result["revisions"][0]["capable"] is True
        assert result["revisions"][0]["direct_sso_false"] is True
        assert databases == ["hushh-pda"]
        assert result["sso_activation_qualified"] is False
