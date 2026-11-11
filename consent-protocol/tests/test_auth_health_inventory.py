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


REPLACEMENT_IMAGES = (
    ("ril_zeg_poh", "0654bc47a5e6d80efd61aef2962abe7fcfe3ee574c3700a071b8f2facbd87a35"),
    ("dak_viz_val", "590c55fa1d4322fca37fecd62a41bf6cf3bcd3ba8690d4e7ca17f1acc1237e03"),
)


def _replacement_job(owner, position):
    nonce, digest = REPLACEMENT_IMAGES[position]
    job = _observer_job(owner)
    job["metadata"]["generation"] = owner["REPLACEMENTS"][position]["generation"]
    job["spec"]["template"]["metadata"]["labels"]["client.knative.dev/nonce"] = nonce
    task = job["spec"]["template"]["spec"]["template"]["spec"]
    task["containers"][0]["image"] = "gcr.io/hushh-pda/auth-health-job@sha256:" + digest
    return job


def test_reviewed_replacements_are_the_only_other_zero_connection_incarnations():
    owner = run_path(str(ROOT / "deploy/observability/auth_health_inventory.py"))
    jobs = [_observer_job(owner), _replacement_job(owner, 0), _replacement_job(owner, 1)]
    # Each pinned replacement differs from generation 1 only by image and nonce.
    for job, row in zip(jobs[1:], owner["REPLACEMENTS"], strict=True):
        assert owner["fingerprint"](job["spec"]) == row["spec"]
        qualified = owner["qualify_job"](job)
        assert qualified["source"] == row["source"] and qualified["connections"] == 0
    for job in jobs:
        for generation in {1, 2, 3, 4} - {job["metadata"]["generation"]}:
            mixed = copy.deepcopy(job)
            mixed["metadata"]["generation"] = generation
            with pytest.raises(ValueError):
                owner["qualify_job"](mixed)


REPLACEMENT_STAMPS = (
    (
        "2026-10-29T22:48:18.04Z",
        "2026-10-29T22:48:18.51Z",
        "2026-10-29T22:50:00Z",
        "2026-10-29T22:52:00Z",
    ),
    (
        "2026-10-29T23:55:16.36Z",
        "2026-10-29T23:55:16.82Z",
        "2026-10-29T23:57:38Z",
        "2026-10-30T00:00:08Z",
    ),
)


def _replacement_events(owner, execution):
    pairs, runs = [], []
    for position, (requested, replaced, created, finished) in enumerate(REPLACEMENT_STAMPS):
        pair = [
            _event(
                "activity", "google.cloud.run.v1.Jobs.ReplaceJob", requested, f"replace-{position}"
            ),
            _event("system_event", "/Jobs.ReplaceJob", replaced, f"replaced-{position}"),
        ]
        later = copy.deepcopy(execution)
        later["metadata"].update(
            name=f"{owner['NAME']}-r{position}xyz",
            uid=f"synthetic-replacement-{position}",
            creationTimestamp=created,
        )
        later["spec"] = copy.deepcopy(_replacement_job(owner, position)["spec"]["template"]["spec"])
        run = _event("system_event", "/Jobs.RunJob", finished, f"replacement-run-{position}")
        run["protoPayload"].update(
            response=later,
            status={"code": 10},
            resourceName="namespaces/hushh-pda/executions/" + later["metadata"]["name"],
        )
        for event in (*pair, run):
            event["resource"]["labels"]["job_name"] = owner["NAME"]
        pairs.append(pair)
        runs.append((later, run))
    owner["review_history"].__globals__["REPLACEMENTS"] = tuple(
        {**row, "events": tuple(owner["fingerprint"](event) for event in pair)}
        for row, pair in zip(owner["REPLACEMENTS"], pairs, strict=True)
    )
    return pairs, runs


@pytest.mark.parametrize(
    "changed",
    [
        None,
        "generation-two",
        "missing-second",
        "out-of-order",
        "late-generation-two-task",
        "early-generation-three-task",
        "half",
        "repeated",
    ],
)
def test_history_admits_only_the_exact_reviewed_replacements(history, monkeypatch, changed):
    module, _producer, _events_unused, proof = history
    owner = run_path(str(ROOT / "deploy/observability/auth_health_inventory.py"))
    events, execution = _observer_events(owner, _observer_job(owner))
    pairs, runs = _replacement_events(owner, execution)
    origin = events
    events, job = (
        [*origin, *pairs[0], runs[0][1], *pairs[1], runs[1][1]],
        _replacement_job(owner, 1),
    )
    if changed == "generation-two":
        events, job = [*origin, *pairs[0], runs[0][1]], _replacement_job(owner, 0)
    elif changed == "missing-second":
        events = [event for event in events if event not in pairs[1]]
    elif changed == "out-of-order":
        events = [*origin, *pairs[1], runs[0][1], *pairs[0], runs[1][1]]
    elif changed == "late-generation-two-task":
        runs[1][0]["spec"] = copy.deepcopy(runs[0][0]["spec"])
    elif changed == "early-generation-three-task":
        runs[0][0]["spec"] = copy.deepcopy(runs[1][0]["spec"])
    elif changed == "half":
        events.remove(pairs[1][1])
    elif changed == "repeated":
        with pytest.raises(ValueError):
            owner["review_history"]([*events, *pairs[0]], job)
        return
    monkeypatch.setattr(module, "run_path", lambda _path: owner)

    def review():
        return module.review(
            events,
            {},
            {},
            "2026-10-30T01:00:00Z",
            submissions=lambda: proof,
            project_number=owner["NUMBER"],
            observers={owner["NAME"]: job},
        )

    if changed not in (None, "generation-two"):
        with pytest.raises(ValueError):
            review()
        return
    observed = review()["observers"]
    applied = 1 if changed else 2
    assert observed["source"] == owner["REPLACEMENTS"][applied - 1]["source"]
    assert len(observed["replacements"]) == applied
    assert [row["uid"] for row in observed["executions"]] == [
        "synthetic-execution",
        *(f"synthetic-replacement-{position}" for position in range(applied)),
    ]
