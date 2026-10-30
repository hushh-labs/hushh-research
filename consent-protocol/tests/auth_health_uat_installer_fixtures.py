# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Shared fixtures for the UAT health installer contract tests."""

import copy
import importlib
import importlib.util
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from auth_health_uat_cloud_fakes import FakeCloudCLI, FakeIAMAPI

PROJECT = "hushh-pda-uat"
OPERATION = "81b4233b2c6840e59b26982ccb0d2db5"
CHECKER_ID = "112891356763771456056"
CLOCK_ID = "111681910958362407355"
PREPARED_SOURCE = "05ea774ef2eba09f0dfb3a1737c966e74b6da4a8"
BUILD_ID = "12345678-1234-4234-8234-123456789abc"
SOURCE = "a" * 40
IMAGE = f"gcr.io/{PROJECT}/auth-health-job@sha256:{'b' * 64}"
BUCKET = f"{PROJECT}-auth-health-ops"
JOB = "protected-configuration-health"
CHECKER = f"auth-health-check@{PROJECT}.iam.gserviceaccount.com"
CLOCK = f"auth-health-clock@{PROJECT}.iam.gserviceaccount.com"
JOB_NAME = f"projects/{PROJECT}/locations/us-central1/jobs/{JOB}"
EXECUTION = f"{JOB_NAME}/executions/{JOB}-abcde"


def prepared_uat_journal():
    """Value-safe shape of the original prepared operation, before this image build."""
    return {
        "phase": "prepared",
        "project": PROJECT,
        "operation": OPERATION,
        "source": PREPARED_SOURCE,
        "bucket": BUCKET,
        "identities": {CHECKER: CHECKER_ID, CLOCK: CLOCK_ID},
    }


def load_installer(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    scripts = root / "deploy/observability"
    monkeypatch.syspath_prepend(str(scripts))
    spec = importlib.util.spec_from_file_location(
        "auth_health_uat_installer", scripts / "auth_health_uat_installer.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_common(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(root / "deploy/observability"))
    return importlib.import_module("auth_health_uat_common")


def load_health(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(root / "deploy/observability"))
    return importlib.import_module("setup_auth_health")


def load_timer_activation(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(root / "deploy/observability"))
    return importlib.import_module("auth_health_uat_timer_activation")


def job_resource(image=IMAGE, *, operation=OPERATION, checker=CHECKER, namespace="123"):
    return {
        "kind": "Job",
        "metadata": {
            "name": JOB,
            "namespace": namespace,
            "uid": "job-uid-1",
            "creationTimestamp": "2026-10-30T18:00:00Z",
            "labels": {
                "managed_by": "repo_observability",
                "purpose": "auth_health",
                "operation": operation,
            },
        },
        "spec": {
            "template": {
                "metadata": {"labels": {"operation": operation}},
                "spec": {
                    "parallelism": 1,
                    "taskCount": 1,
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "image": image,
                                    "env": [
                                        {"name": "AUTH_HEALTH_PROJECT", "value": PROJECT},
                                        {
                                            "name": "AUTH_PHONE_RUNTIME_HEALTH_ENABLED",
                                            "value": "true",
                                        },
                                    ],
                                    "resources": {"limits": {"cpu": "1", "memory": "512Mi"}},
                                }
                            ],
                            "maxRetries": 0,
                            "timeoutSeconds": "600",
                            "serviceAccountName": checker,
                        }
                    },
                },
            }
        },
    }


def scheduler_resource(state="ENABLED"):
    import base64

    return {
        "name": JOB_NAME,
        "description": f"Hussh auth-health operation {OPERATION}",
        "state": state,
        "schedule": "17 * * * *",
        "timeZone": "Etc/UTC",
        "attemptDeadline": "30s",
        "retryConfig": {"retryCount": 0},
        "httpTarget": {
            "uri": f"https://run.googleapis.com/v2/{JOB_NAME}:run",
            "httpMethod": "POST",
            "body": base64.b64encode(b"{}").decode("ascii"),
            "headers": {"Content-Type": "application/json"},
            "oauthToken": {
                "serviceAccountEmail": CLOCK,
                "scope": "https://www.googleapis.com/auth/cloud-platform",
            },
        },
    }


def _health_observation(healthy):
    now = datetime.now(timezone.utc)
    started = (now - timedelta(seconds=20)).isoformat().replace("+00:00", "Z")
    finished = (now - timedelta(seconds=5)).isoformat().replace("+00:00", "Z")
    created = (now - timedelta(seconds=25)).isoformat().replace("+00:00", "Z")
    job = job_resource()
    job["metadata"]["creationTimestamp"] = (
        (now - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    )
    execution = {
        "kind": "Execution",
        "metadata": {
            "name": f"{JOB}-abcde",
            "uid": "execution-uid-1",
            "namespace": "123",
            "creationTimestamp": created,
            "ownerReferences": [
                {
                    "kind": "Job",
                    "name": JOB,
                    "uid": "job-uid-1",
                    "apiVersion": "serving.knative.dev/v1",
                    "controller": True,
                    "blockOwnerDeletion": True,
                }
            ],
        },
        "spec": copy.deepcopy(job["spec"]["template"]["spec"]),
        "status": {
            "conditions": [{"type": "Completed", "status": "True"}],
            "succeededCount": 1,
            "failedCount": 0,
            "startTime": started,
            "completionTime": finished,
        },
    }
    events = (
        [
            {
                "logName": f"projects/{PROJECT}/logs/obs-auth-health",
                "resource": {"type": "global", "labels": {"project_id": PROJECT}},
                "jsonPayload": {
                    "message": "auth.test_allowlist.health",
                    "status": "healthy",
                    "checked_lists": 1,
                    "runtime_status": "healthy",
                },
                "severity": "INFO",
                "timestamp": finished,
            }
        ]
        if healthy
        else []
    )
    return job, execution, events


def _timeout_error():
    return subprocess.TimeoutExpired(
        ["bounded-timeout-command-marker"],
        90,
        output=b"bounded-timeout-stdout-marker",
        stderr=b"bounded-timeout-stderr-marker",
    )


def _build_and_bucket(*, wrong_build, wrong_bucket):
    build = {
        "id": BUILD_ID,
        "projectId": PROJECT,
        "status": "SUCCESS",
        "tags": [f"auth-health-{OPERATION}", f"auth-health-source-{SOURCE}"],
        "images": [f"gcr.io/{PROJECT}/auth-health-job:{SOURCE}"],
        "steps": [
            {
                "name": "gcr.io/cloud-builders/docker",
                "args": ["build", "--tag", f"gcr.io/{PROJECT}/auth-health-job:{SOURCE}", "."],
            }
        ],
        "sourceProvenance": {
            "resolvedStorageSource": {
                "bucket": BUCKET,
                "object": "sources/source.tgz",
                "generation": "9",
            }
        },
        "results": {
            "images": [
                {
                    "name": f"gcr.io/{PROJECT}/auth-health-job:{SOURCE}",
                    "digest": "sha256:" + "b" * 64,
                }
            ]
        },
    }
    if wrong_build:
        build["tags"] = ["auth-health-other-operation", f"auth-health-source-{SOURCE}"]
    bucket = {
        "name": BUCKET,
        "projectNumber": "123",
        "labels": {"operation": OPERATION},
        "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": True},
            "publicAccessPrevention": "enforced",
        },
    }
    if wrong_bucket:
        bucket["projectNumber"] = "999"
    return build, bucket


def _policies(*, invoker, conditional_invoker, foreign_invoker):
    role_policy = {
        "bindings": [{"role": "roles/storage.objectUser", "members": [f"serviceAccount:{CHECKER}"]}]
    }
    project_policy = {
        "bindings": [{"role": "roles/logging.logWriter", "members": [f"serviceAccount:{CHECKER}"]}]
    }
    if foreign_invoker:
        job_policy = {
            "etag": "policy-etag-1",
            "bindings": [{"role": "roles/run.invoker", "members": ["user:unexpected@example.com"]}],
        }
    elif not invoker:
        job_policy = {
            "etag": "policy-etag-1",
            "bindings": [
                {"role": "roles/logging.viewer", "members": ["user:preserved@example.com"]}
            ],
        }
    elif conditional_invoker:
        job_policy = {
            "etag": "policy-etag-1",
            "bindings": [
                {
                    "role": "roles/run.invoker",
                    "members": [f"serviceAccount:{CLOCK}"],
                    "condition": {"title": "temporary", "expression": "true"},
                }
            ],
        }
    else:
        job_policy = {
            "etag": "policy-etag-1",
            "bindings": [{"role": "roles/run.invoker", "members": [f"serviceAccount:{CLOCK}"]}],
        }
    return role_policy, project_policy, job_policy


def _fake_cloud_cli(
    state, calls, resources, *, role, denied_secret_binding, deploy_error, resume_error
):
    return FakeCloudCLI(
        state,
        calls,
        resources,
        project=PROJECT,
        operation=OPERATION,
        checker_email=CHECKER,
        checker_id=CHECKER_ID,
        clock_id=CLOCK_ID,
        job_name=JOB,
        role=role,
        denied_secret_binding=denied_secret_binding,
        deploy_error=deploy_error,
        resume_error=resume_error,
        timeout_error=_timeout_error,
        scheduler_resource=scheduler_resource,
    )


def _fake_resource_reader(bucket, state):
    bucket_url = f"https://storage.googleapis.com/storage/v1/b/{BUCKET}"

    def existing_resource(api, url, name):
        assert name in {BUCKET, JOB_NAME}
        if url == bucket_url:
            return bucket
        assert url == f"https://cloudscheduler.googleapis.com/v1/{JOB_NAME}"
        state["timer_readbacks"] += 1
        if state["timer_readbacks"] == 2 and state["timer_readback_error"]:
            raise state.pop("timer_readback_error")
        if state.pop("timer_readback_timeout_once", False):
            raise _timeout_error()
        return state["timer"]

    return existing_resource


def runtime_fakes(
    monkeypatch,
    *,
    current_job=None,
    timer=None,
    healthy=True,
    invoker=True,
    deploy_error=False,
    create_error=None,
    resume_error=False,
    wrong_build=False,
    denied_secret_binding=False,
    wrong_bucket=False,
    conditional_invoker=False,
    invoker_error=None,
    invoker_readback_error=False,
    foreign_invoker=False,
    timer_readback_error=None,
):
    module = load_installer(monkeypatch)
    state = {
        "job": current_job,
        "timer": timer,
        "create_error": create_error,
        "timer_readbacks": 0,
        "timer_readback_error": timer_readback_error,
    }
    calls = []
    job, execution, events = _health_observation(healthy)
    build, bucket = _build_and_bucket(wrong_build=wrong_build, wrong_bucket=wrong_bucket)
    role_policy, project_policy, job_policy = _policies(
        invoker=invoker,
        conditional_invoker=conditional_invoker,
        foreign_invoker=foreign_invoker,
    )
    state.update(
        job_policy=job_policy,
        invoker_readback_error=invoker_readback_error,
        invoker_set_attempted=False,
    )
    resources = {
        "job": job,
        "execution": execution,
        "events": events,
        "build": build,
        "bucket": bucket,
        "role_policy": role_policy,
        "project_policy": project_policy,
    }
    run = _fake_cloud_cli(
        state,
        calls,
        resources,
        role=load_common(monkeypatch).ROLE,
        denied_secret_binding=denied_secret_binding,
        deploy_error=deploy_error,
        resume_error=resume_error,
    )
    api = FakeIAMAPI(
        state,
        calls,
        invoker_error,
        project=PROJECT,
        region="us-central1",
        job=JOB,
    )
    health = load_health(monkeypatch)
    monkeypatch.setattr(health, "_reviewed_source", lambda: SOURCE)
    monkeypatch.setattr(health, "_transport", lambda *a, **k: (run, api))
    monkeypatch.setattr(health, "_existing_resource", _fake_resource_reader(bucket, state))
    monkeypatch.setattr(health, "_source_blob", lambda _source, _name: b"exact")
    monkeypatch.setattr(health, "_verify_image_source", lambda *a: None)
    return module, state, calls, job, execution, events
