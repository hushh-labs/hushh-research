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
