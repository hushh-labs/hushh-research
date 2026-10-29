# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Redacted requests cannot hide deleted, overridden or unbound job issuers."""

import copy
import hashlib
import importlib
import json
from runpy import run_path
from types import SimpleNamespace

import pytest

from tests.test_phone_rollback_release import IMAGE, ROOT
from tests.test_phone_schema_origin import _timestamp
from tests.test_phone_schema_origin import submission as shared_submission

pytestmark = pytest.mark.feature_auth_reliability
submission = shared_submission
SOURCE = "7d5546e471f2e168a898cd21c9abd7f1e8aaa9cc"
BUILD = "01234567-0123-0123-0123-0123456789ab"


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
    events = births + [event]
    if changed == "birth":
        births[0]["insertId"] = "different-birth"
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


def _event(lane, method, stamp, identity):
    return {
        "logName": "projects/hushh-pda/logs/cloudaudit.googleapis.com%2F" + lane,
        "insertId": identity,
        "timestamp": stamp,
        "resource": {"labels": {"project_id": "hushh-pda", "location": "us-central1"}},
        "protoPayload": {"serviceName": "run.googleapis.com", "methodName": method},
    }


def _task():
    return {
        "serviceAccountName": "synthetic-runtime",
        "maxRetries": 0,
        "timeoutSeconds": "420",
        "containers": [
            {
                "image": IMAGE,
                "env": [{"name": "ENVIRONMENT", "value": "production"}],
                "command": ["python3"],
                "args": ["scripts/verify_managed_vertex_runtime.py"],
                "resources": {"limits": {"cpu": "1"}},
            }
        ],
    }


def _events(name, uid):
    task = _task()
    requested = copy.deepcopy(task)
    for key in ("command", "args"):
        requested["containers"][0].pop(key)
    create = _event(
        "activity", "google.cloud.run.v1.Jobs.CreateJob", "2026-10-26T02:00:00Z", "birth"
    )
    create["protoPayload"]["request"] = {
        "@type": "type.googleapis.com/google.cloud.run.v1.CreateJobRequest",
        "parent": "namespaces/hushh-pda",
        "job": {
            "metadata": {"name": name, "namespace": "hushh-pda"},
            "spec": {"template": {"spec": {"template": {"spec": requested}}}},
        },
    }
    execute = _event("system_event", "/Jobs.RunJob", "2026-10-26T02:01:00Z", "execution")
    execute["protoPayload"]["response"] = {
        "kind": "Execution",
        "metadata": {
            "name": name + "-abcde",
            "uid": "execution-uid",
            "creationTimestamp": "2026-10-26T02:00:01Z",
            "ownerReferences": [
                {
                    "kind": "Job",
                    "controller": True,
                    "blockOwnerDeletion": True,
                    "name": name,
                    "uid": uid,
                }
            ],
        },
        "spec": {"template": {"spec": task}},
        "status": {"conditions": [{"type": "Completed", "status": "True"}]},
    }
    delete = _event(
        "activity", "google.cloud.run.v1.Jobs.DeleteJob", "2026-10-26T02:01:01Z", "delete"
    )
    delete["protoPayload"]["request"] = {
        "@type": "type.googleapis.com/google.cloud.run.v1.DeleteJobRequest",
        "name": "namespaces/hushh-pda/jobs/" + name,
    }
    for event in (create, execute, delete):
        event["resource"]["labels"]["job_name"] = name
    execute["protoPayload"]["resourceName"] = "namespaces/hushh-pda/executions/" + name + "-abcde"
    execute["protoPayload"]["response"]["metadata"]["namespace"] = "1006304528804"
    execute["protoPayload"]["response"]["metadata"]["ownerReferences"][0]["apiVersion"] = (
        "serving.knative.dev/v1"
    )
    born = copy.deepcopy(execute)
    born.update(insertId="created", timestamp="2026-10-26T02:00:00.5Z")
    job = {
        "kind": "Job",
        "metadata": {
            "name": name,
            "uid": uid,
            "namespace": "1006304528804",
            "creationTimestamp": "2026-10-26T02:00:00.1Z",
        },
        "spec": {"template": {"spec": {"template": {"spec": copy.deepcopy(task)}}}},
    }
    born["protoPayload"].update(
        methodName="/Jobs.CreateJob", resourceName="namespaces/hushh-pda/jobs/" + name, response=job
    )
    removed = copy.deepcopy(born)
    removed.update(insertId="job-deleted", timestamp="2026-10-26T02:01:02Z")
    removed["protoPayload"]["methodName"] = "/Jobs.DeleteJob"
    ended = copy.deepcopy(execute)
    ended.update(insertId="execution-deleted", timestamp="2026-10-26T02:01:02.1Z")
    ended["protoPayload"]["methodName"] = "/Jobs.DeleteJob"
    return [create, born, execute, delete, removed, ended]


@pytest.fixture
def history(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    module = importlib.import_module("schema_job_history")
    producer = importlib.import_module("schema_producers")
    monkeypatch.setattr(producer, "source_capable", lambda _sha: False)
    events = _events("genai-ready-" + BUILD, "job-uid")
    proof = {
        "qualification": "passed",
        "acknowledged_attempts": [
            {
                "run_id": "40286563192",
                "build_id": BUILD,
                "image": IMAGE,
                "source": SOURCE,
                "probe_source": SOURCE,
                "probe_image": IMAGE,
            }
        ],
    }
    return module, producer, events, proof


def _change_events(module, events, proof, changed):
    create, execute, delete = events[0], events[2], events[3]
    response = execute["protoPayload"]["response"]
    container = response["spec"]["template"]["spec"]["containers"][0]
    if changed == "missing-execution":
        events.remove(execute)
    elif changed == "missing-birth-proof":
        events.pop(1)
    elif changed == "missing-job-delete-proof":
        events.pop(4)
    elif changed == "missing-execution-delete-proof":
        events.pop(5)
    elif changed == "birth-launcher":
        events[1]["protoPayload"]["response"]["spec"]["template"]["spec"]["template"]["spec"][
            "containers"
        ][0]["command"] = ["sh"]
    elif changed == "delete-uid":
        events[4]["protoPayload"]["response"]["metadata"]["uid"] = "other-job"
    elif changed == "missing-delete":
        events.remove(delete)
    elif changed == "order":
        events.reverse()
    elif changed == "recreate":
        events.append(copy.deepcopy(create))
    elif changed == "uid":
        response["metadata"]["ownerReferences"][0]["uid"] = ""
    elif changed == "duplicate-execution":
        duplicate = copy.deepcopy(execute)
        duplicate["insertId"] = "duplicate"
        events.insert(3, duplicate)
    elif changed == "override":
        execute["protoPayload"]["request"] = {"overrides": {"containerOverrides": []}}
    elif changed == "request-launcher":
        create["protoPayload"]["request"]["job"]["spec"]["template"]["spec"]["template"]["spec"][
            "containers"
        ][0]["args"] = ["different.py"]
    elif changed == "unknown-image":
        container["image"] = "unknown"
    elif changed == "unbound-build":
        proof["acknowledged_attempts"][0]["build_id"] = "fedcba98-0123-0123-0123-0123456789ab"
    elif changed == "source-conflict":
        proof["acknowledged_attempts"][0]["source"] = "e" * 40
    elif changed == "path":
        container.setdefault("env", []).append({"name": "PATH", "value": "/unreviewed"})
    elif changed == "namespace":
        response["metadata"]["namespace"] = "different-project"
    elif changed == "owner-api":
        response["metadata"]["ownerReferences"][0]["apiVersion"] = "unreviewed/v2"
    elif changed == "resource-job":
        execute["resource"]["labels"]["job_name"] = "other-job"
    elif changed == "resource-name":
        execute["protoPayload"]["resourceName"] = "namespaces/other/executions/other"
    elif changed == "environment":
        container["env"][0]["value"] = "uat"
    elif changed == "env":
        container.setdefault("env", []).append({"name": "PYTHONPATH", "value": "/unreviewed"})
    elif changed == "sidecar":
        response["spec"]["template"]["spec"]["containers"].append(container.copy())
    elif changed == "volume":
        response["spec"]["template"]["spec"]["volumes"] = [{}]
    elif changed == "unfinished":
        response["status"]["conditions"][0]["status"] = "Unknown"
    elif changed == "project":
        create["protoPayload"]["request"]["parent"] = "namespaces/hushh-pda-uat"
    elif changed == "region":
        execute["resource"]["labels"]["location"] = "us-east1"
    elif changed == "unknown-mutation":
        create["protoPayload"]["methodName"] = "google.cloud.run.v1.Jobs.ReplaceJob"
    elif changed == "incomplete":
        events *= module.closed.LIMIT


@pytest.mark.parametrize(
    "changed",
    [
        None,
        "missing-execution",
        "missing-birth-proof",
        "missing-job-delete-proof",
        "missing-execution-delete-proof",
        "birth-launcher",
        "delete-uid",
        "missing-delete",
        "order",
        "recreate",
        "uid",
        "duplicate-execution",
        "override",
        "request-launcher",
        "unknown-image",
        "unbound-build",
        "source-conflict",
        "env",
        "environment",
        "path",
        "namespace",
        "owner-api",
        "resource-job",
        "resource-name",
        "sidecar",
        "volume",
        "unfinished",
        "project",
        "region",
        "unknown-mutation",
        "incomplete",
    ],
)
def test_effective_execution_and_complete_lifecycle_are_required(history, changed):
    module, _producer, events, proof = history
    _change_events(module, events, proof, changed)

    def action():
        return module.review(
            events,
            {},
            {IMAGE: SOURCE},
            "2026-10-26T03:00:00Z",
            submissions=lambda: proof,
            project_number="1006304528804",
        )

    if changed:
        with pytest.raises(ValueError):
            action()
    else:
        result = action()
        assert result["event_count"] == 6
        assert result["closed_jobs"][0]["uid"] == "job-uid"
        assert result["closed_jobs"][0]["executions"][0]["source"] == SOURCE


def test_old_probe_body_is_not_an_exception_for_a_capable_source(history, monkeypatch):
    module, producer, events, proof = history
    monkeypatch.setattr(producer, "source_capable", lambda _sha: True)
    with pytest.raises(ValueError):
        module.review(
            events,
            {},
            {IMAGE: SOURCE},
            "2026-10-26T03:00:00Z",
            submissions=lambda: proof,
            project_number="1006304528804",
        )


@pytest.mark.parametrize("qualified", [True, False])
def test_current_probe_does_not_admit_unqualified_capable_historical_image(
    history, monkeypatch, qualified
):
    module, producer, events, proof = history
    monkeypatch.setattr(producer, "source_capable", lambda _sha: True)
    body = (ROOT / "consent-protocol/scripts/verify_managed_vertex_runtime.py").read_bytes()
    monkeypatch.setattr(producer, "run", lambda _command: body)

    def action():
        return module.review(
            events,
            {},
            {IMAGE: SOURCE} if qualified else {},
            "2026-10-26T03:00:00Z",
            submissions=lambda: proof,
            project_number="1006304528804",
        )

    if qualified:
        assert action()["closed_jobs"][0]["executions"][0]["source"] == SOURCE
    else:
        with pytest.raises(ValueError):
            action()


@pytest.mark.parametrize("changed", [None, "swapped", "unqualified", "wrong-build"])
def test_cold_receipt_separates_primary_probe_from_staged_fallback(
    history, submission, monkeypatch, changed
):
    module, producer, events, proof = history
    origin, attempt, _job, build = submission
    primary = "84b80bcab6b5b7a4de21a5a992d3c969dacba5b9"
    fallback = "4452c7121c80ef73e8e6d43cd7af19b20f679a83"
    primary_image = "gcr.io/hushh-pda/consent-protocol@sha256:" + "f" * 64
    build["substitutions"].update(
        _DEPLOY_SHA=primary, _IMAGE_REFERENCE=primary_image, _PHONE_ROLLBACK_SHA=fallback
    )
    receipt = origin._build_binding(build, attempt, _timestamp)
    assert (receipt["source"], receipt["image"]) == (fallback, IMAGE)
    assert (receipt["probe_source"], receipt["probe_image"]) == (primary, primary_image)
    for event in events:
        payload = event["protoPayload"]
        row = payload.get("response") or payload["request"].get("job")
        if not row:
            continue
        task = row["spec"]["template"]["spec"]
        if "template" in task:
            task = task["template"]["spec"]
        task["containers"][0]["image"] = primary_image
    monkeypatch.setattr(producer, "source_capable", lambda _sha: True)
    proof["acknowledged_attempts"] = [receipt]
    images = {IMAGE: fallback, primary_image: primary}
    if changed == "swapped":
        receipt.update(probe_source=fallback, probe_image=IMAGE)
    elif changed == "unqualified":
        images.pop(primary_image)
    elif changed == "wrong-build":
        receipt["build_id"] = "fedcba98-0123-0123-0123-0123456789ab"

    def action():
        return module.review(
            events,
            {},
            images,
            "2026-10-26T03:00:00Z",
            submissions=lambda: proof,
            project_number="1006304528804",
            probe_images=frozenset({(primary, primary_image), (fallback, IMAGE)}),
        )

    if changed:
        with pytest.raises(ValueError):
            action()
    else:
        assert action()["closed_jobs"][0]["executions"][0]["source"] == primary
        schema = importlib.import_module("schema_qualification")
        monkeypatch.setattr(schema, "source_capable", lambda _sha: True)
        snapshot = {"revisions": {"fallback": {"run_id": "42", "source": fallback, "image": IMAGE}}}
        assert schema._submissions(SimpleNamespace(submissions=lambda: proof), snapshot) == proof


@pytest.mark.parametrize("changed", [None, "unplanned", "other-image", "other-source", "body"])
def test_approved_probe_exception_is_bound_to_exact_selected_source_and_image(
    history, monkeypatch, changed
):
    module, producer, events, proof = history
    source = "4452c7121c80ef73e8e6d43cd7af19b20f679a83"
    body = producer.run(
        ["git", "show", source + ":consent-protocol/scripts/verify_managed_vertex_runtime.py"]
    )
    monkeypatch.setattr(producer, "source_capable", lambda _sha: True)
    monkeypatch.setattr(
        producer, "run", lambda _command: body + (b"\n" if changed == "body" else b"")
    )
    planned = frozenset({(source, IMAGE)})
    if changed == "unplanned":
        planned = frozenset()
    elif changed == "other-image":
        planned = frozenset({(source, "other-image")})
    elif changed == "other-source":
        source = "e" * 40
        planned = frozenset({(source, IMAGE)})
    proof["acknowledged_attempts"][0].update(source=source, probe_source=source)

    def action():
        return module.review(
            events,
            {},
            {IMAGE: source},
            "2026-10-26T03:00:00Z",
            submissions=lambda: proof,
            project_number="1006304528804",
            probe_images=planned,
        )

    if changed:
        with pytest.raises(ValueError):
            action()
    else:
        assert action()["closed_jobs"][0]["executions"][0]["source"] == source


@pytest.mark.parametrize("changed", [None, "uid", "body", "capable", "run"])
def test_manual_document_probe_remains_exact_source_uid_and_body(history, monkeypatch, changed):
    module, producer, _events_unused, proof = history
    name = "one-document-readiness-40286563192"
    uid, _digest = module.DOCUMENT_PROBES[name]
    events = _events(name, uid)
    body = "print('synthetic existing-global-readiness')"
    monkeypatch.setitem(
        module.DOCUMENT_PROBES, name, (uid, hashlib.sha256(body.encode()).hexdigest())
    )
    response = events[2]["protoPayload"]["response"]
    response["spec"]["template"]["spec"]["containers"][0]["args"] = [
        "-c",
        body + ("\n" if changed == "body" else ""),
    ]
    for event in (events[1], events[4]):
        event["protoPayload"]["response"]["spec"]["template"]["spec"]["template"]["spec"][
            "containers"
        ][0]["args"] = copy.deepcopy(response["spec"]["template"]["spec"]["containers"][0]["args"])
    events[5]["protoPayload"]["response"] = copy.deepcopy(response)
    if changed == "uid":
        response["metadata"]["ownerReferences"][0]["uid"] = "other-job"
    elif changed == "capable":
        monkeypatch.setattr(producer, "source_capable", lambda _sha: True)
    elif changed == "run":
        proof["acknowledged_attempts"][0]["run_id"] = "42"
    if changed:
        with pytest.raises(ValueError):
            module.review(
                events,
                {},
                {IMAGE: SOURCE},
                "2026-10-26T03:00:00Z",
                submissions=lambda: proof,
                project_number="1006304528804",
            )
    else:
        assert (
            module.review(
                events,
                {},
                {IMAGE: SOURCE},
                "2026-10-26T03:00:00Z",
                submissions=lambda: proof,
                project_number="1006304528804",
            )["closed_jobs"][0]["uid"]
            == uid
        )
