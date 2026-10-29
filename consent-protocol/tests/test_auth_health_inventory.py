# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""The immutable health observer cannot hide a phone writer or SQL workload."""

import copy
import json
from runpy import run_path

import pytest

from tests.test_phone_rollback_release import ROOT
from tests.test_phone_schema_job_history import _event
from tests.test_phone_schema_job_history import history as history

pytestmark = pytest.mark.feature_auth_reliability


def _observer_job(owner):
    return {
        "metadata": {
            "name": owner["NAME"],
            "namespace": owner["NUMBER"],
            "uid": owner["UID"],
            "creationTimestamp": owner["CREATED"],
            "generation": 1,
        },
        "spec": {
            "template": {
                "metadata": {
                    "labels": {
                        "client.knative.dev/nonce": "rep_hoc_zed",
                        "managed_by": "repo_observability",
                        "operation": "a2ffdd150a3a41b7bb076700b5631939",
                        "purpose": "auth_health",
                    },
                    "annotations": {
                        "run.googleapis.com/client-name": "gcloud",
                        "run.googleapis.com/client-version": "577.0.0",
                        "run.googleapis.com/execution-environment": "gen2",
                    },
                },
                "spec": {
                    "parallelism": 1,
                    "taskCount": 1,
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "image": "gcr.io/hushh-pda/auth-health-job@sha256:290966a59c21221ecec03ad14fbcb6a42e609fa4836d6ffde243e05fe1ff5a38",
                                    "env": [
                                        {"name": "AUTH_HEALTH_PROJECT", "value": "hushh-pda"},
                                        {
                                            "name": "AUTH_PHONE_RUNTIME_HEALTH_ENABLED",
                                            "value": "false",
                                        },
                                    ],
                                    "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
                                }
                            ],
                            "maxRetries": 0,
                            "timeoutSeconds": "600",
                            "serviceAccountName": "auth-health-check@hushh-pda.iam.gserviceaccount.com",
                        }
                    },
                },
            }
        },
    }


@pytest.mark.parametrize(
    "changed",
    [
        None,
        "image",
        "args",
        "env",
        "sidecar",
        "volume",
        "uid",
        "namespace",
        "generation",
        "missing-proof",
        "foreign-project",
        "forged-proof",
    ],
)
def test_observer_capacity_is_zero_only_for_the_immutable_reviewed_workload(changed):
    owner = run_path(str(ROOT / "deploy/observability/auth_health_inventory.py"))
    budget = run_path(str(ROOT / "scripts/ci/runtime-capacity-budget.py"))
    job = _observer_job(owner)
    original = copy.deepcopy(job)
    proof = owner["collect"](job, lambda *_: [], ())
    task = job["spec"]["template"]["spec"]["template"]["spec"]
    if changed in {"image", "args", "env"}:
        task["containers"][0][changed] = "unreviewed"
    elif changed == "sidecar":
        task["containers"].append(copy.deepcopy(task["containers"][0]))
    elif changed == "volume":
        task["volumes"] = [{}]
    elif changed in {"uid", "namespace", "generation"}:
        job["metadata"][changed] = "unreviewed"
    profile = json.loads((ROOT / "config/runtime-capacity.json").read_text())
    config = profile["environments"]["production"]
    config.update(services={}, jobs={})
    if changed == "foreign-project":
        config["project"] = "hushh-pda-uat"
    inventory_owner = budget["evaluate"].__globals__["_inventory"]
    inventory = {
        "database_max_connections": 400,
        "services": {},
        "jobs": {owner["NAME"]: job},
        "observer_jobs": inventory_owner.VerifiedObserverJobs((proof,)),
    }
    if changed == "missing-proof":
        inventory.pop("observer_jobs")
    elif changed == "forged-proof":
        inventory["observer_jobs"] = {owner["NAME"]: proof}
    if changed:
        with pytest.raises(ValueError):
            budget["evaluate"](profile, "production", inventory, phase="post-release")
    else:
        result = budget["evaluate"](profile, "production", inventory, phase="post-release")
        assert result["projected_connections"] == result["administrative_reserve"] == 30
        assert result["jobs"][0]["uid"] == owner["UID"]
        assert job == original


def _observer_events(owner, job):
    births = [
        _event(
            "activity",
            "google.cloud.run.v1.Jobs.CreateJob",
            "2026-10-29T16:21:33.2Z",
            "observer-birth",
        ),
        _event("system_event", "/Jobs.CreateJob", "2026-10-29T16:21:33.8Z", "observer-born"),
    ]
    for event in births:
        event["resource"]["labels"]["job_name"] = owner["NAME"]
    owner["review_history"].__globals__["BIRTH"] = tuple(
        owner["fingerprint"](event) for event in births
    )
    execution = {
        "kind": "Execution",
        "metadata": {
            "name": owner["NAME"] + "-abcde",
            "uid": "synthetic-execution",
            "namespace": owner["NUMBER"],
            "creationTimestamp": "2026-10-29T16:22:00Z",
            "ownerReferences": [
                {
                    "kind": "Job",
                    "name": owner["NAME"],
                    "uid": owner["UID"],
                    "apiVersion": "serving.knative.dev/v1",
                    "controller": True,
                    "blockOwnerDeletion": True,
                }
            ],
        },
        "spec": copy.deepcopy(job["spec"]["template"]["spec"]),
        "status": {"conditions": [{"type": "Completed", "status": "False"}]},
    }
    event = _event("system_event", "/Jobs.RunJob", "2026-10-29T16:24:00Z", "observer-execution")
    event["resource"]["labels"]["job_name"] = owner["NAME"]
    event["protoPayload"].update(
        response=execution,
        status={"code": 10},
        resourceName="namespaces/hushh-pda/executions/" + execution["metadata"]["name"],
    )
    return births + [event], execution


@pytest.mark.parametrize(
    "changed",
    [
        None,
        "birth",
        "mutation",
        "override",
        "execution-env",
        "owner",
        "duplicate",
        "resource",
        "missing-birth",
        "active-env",
    ],
)
def test_observer_history_and_active_executions_cannot_hide_a_writer(history, monkeypatch, changed):
    module, _producer, _events_unused, proof = history
    owner = run_path(str(ROOT / "deploy/observability/auth_health_inventory.py"))
    job = _observer_job(owner)
    events, execution = _observer_events(owner, job)
    event = events[-1]
    if changed == "birth":
        events[0]["insertId"] = "different-birth"
    elif changed == "mutation":
        event["protoPayload"]["methodName"] = "google.cloud.run.v1.Jobs.ReplaceJob"
    elif changed == "override":
        event["protoPayload"]["request"] = {"overrides": {}}
    elif changed in {"execution-env", "active-env"}:
        execution["spec"]["template"]["spec"]["containers"][0]["env"].append(
            {"name": "PYTHONPATH", "value": "/unreviewed"}
        )
    elif changed == "owner":
        execution["metadata"]["ownerReferences"][0]["uid"] = "replacement"
    elif changed == "duplicate":
        duplicate = copy.deepcopy(event)
        duplicate["insertId"] = "duplicate-execution"
        events.append(duplicate)
    elif changed == "resource":
        event["protoPayload"]["resourceName"] = "namespaces/other/executions/other"
    elif changed == "missing-birth":
        events.pop(0)
    monkeypatch.setattr(module, "run_path", lambda _path: owner)
    if changed == "active-env":
        with pytest.raises(ValueError):
            owner["collect"](job, lambda *args: [execution] if args[3] == "list" else execution, ())
    elif changed:
        with pytest.raises(ValueError):
            module.review(
                events,
                {},
                {},
                "2026-10-29T17:00:00Z",
                submissions=lambda: proof,
                project_number=owner["NUMBER"],
                observers={owner["NAME"]: job},
            )
    else:
        result = module.review(
            events,
            {},
            {},
            "2026-10-29T17:00:00Z",
            submissions=lambda: proof,
            project_number=owner["NUMBER"],
            observers={owner["NAME"]: job},
        )
        assert result["closed_jobs"] == []
        assert result["observers"]["executions"][0]["uid"] == "synthetic-execution"
        assert (
            owner["collect"](
                job, lambda *args: [execution] if args[3] == "list" else execution, ()
            )["connections"]
            == 0
        )
