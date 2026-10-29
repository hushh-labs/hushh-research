# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Qualify the reviewed monitoring incarnation's absence of a direct SQL pool.

These are recorded deployment facts, not a name-based allowance. Its immutable
source archive was independently read and compared with the five Git bodies.
Cloud Build retains the archive SHA-256 after the temporary GCS source expires.
The job writes its lease and health logs; its optional backend request uses the
backend's already reserved pool. No claim of globally read-only behavior is made.
"""

import base64
import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = "protected-configuration-health"
PROJECT = "hushh-pda"
REGION = "us-central1"
NAMESPACE = "1006304528804"
UID = "2fe6b836-fc5a-4186-b8b3-19611ffb3dff"
CREATED = "2026-10-29T16:21:33.378523Z"
SOURCE = "05ea774ef2eba09f0dfb3a1737c966e74b6da4a8"
BUILD = "0f80cc7e-2265-4639-9a1a-199359b20600"
OPERATION = "a2ffdd150a3a41b7bb076700b5631939"
IMAGE = "gcr.io/hushh-pda/auth-health-job@sha256:290966a59c21221ecec03ad14fbcb6a42e609fa4836d6ffde243e05fe1ff5a38"
ARCHIVE = "a19fcdb0dc591c5138f6b831668ca64d0b2e87d0f791ea8ac05e4fa8c922d07f"
STORAGE = {
    "bucket": "hushh-pda-auth-health-ops",
    "object": "sources/1793290138.604372-c59702af78c04b2a919eb2ec6d910a5a.tgz",
    "generation": "1793290138950611",
}
SPEC = "ff36ba631204673e5ac4f408b00cb4d6aa5012527631d3972b5ea1e44e3bdb6a"
EXECUTION_SPEC = "94af68e20eca9ae843e70debdd59ccdef242c3f3d655cdbfd2be7e74bcd26735"
BIRTH = "0a7b3bed7787157071059aa276a38d0895cbbcc2c08a9d285ee1d0331c1078fb"
BODIES = [
    (
        "deploy/observability/auth-health.Dockerfile",
        "11c4c36c6e7eef4ff0ae50a21fa8e7a82155d3f3a727899148de323fdf26de0f",
    ),
    (
        "config/protected-lists.json",
        "94383d39eb984480e6dce5feefa5dc360b51ba9f90e0699af00abc4d8d1d6ea6",
    ),
    (
        "deploy/observability/auth_health_job.py",
        "7e8516224a479ad3f85d70c8b956032441ebd29e2358186d99caffc8269f9a82",
    ),
    (
        "scripts/ci/process_group.py",
        "1c545d1cdd0f74b27030d228258a9a2c03e8210957c39c5f27dd157dd321e1ca",
    ),
    (
        "scripts/ops/verify_secret_list_invariants.py",
        "4b2b4c68190a6c8b37f364115c3886e12a603828d235a5baadc8249c2b32633e",
    ),
]


def require(value):
    if not value:
        raise ValueError("protected_configuration_job_unqualified")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@lru_cache(maxsize=1)
def reviewed_source():
    subprocess.run(
        ["git", "merge-base", "--is-ancestor", SOURCE, "origin/main"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        timeout=30,
    )
    for path, expected in BODIES:
        body = subprocess.check_output(
            ["git", "show", f"{SOURCE}:{path}"], cwd=ROOT, timeout=30
        )
        require(hashlib.sha256(body).hexdigest() == expected)


@lru_cache(maxsize=8)
def reviewed_build(read):
    """Only terminal, immutable build facts may be reused within this process."""
    reviewed_source()
    build = read("builds", "describe", BUILD, f"--project={PROJECT}")
    tag = f"gcr.io/{PROJECT}/auth-health-job:{SOURCE}"
    provenance = build.get("sourceProvenance", {})
    uri = f"gs://{STORAGE['bucket']}/{STORAGE['object']}#{STORAGE['generation']}"
    hashes = provenance.get("fileHashes", {})
    values = [
        row.get("value")
        for row in hashes.get(uri, {}).get("fileHash", [])
        if row.get("type") == "SHA256"
    ]
    steps = build.get("steps", [])
    require(
        build.get("id") == BUILD
        and build.get("projectId") == PROJECT
        and build.get("status") == "SUCCESS"
        and build.get("source") == {"storageSource": STORAGE}
        and provenance.get("resolvedStorageSource") == STORAGE
        and set(hashes) == {uri}
        and len(values) == 1
        and isinstance(values[0], str)
        and base64.b64decode(values[0], altchars=b"-_", validate=True).hex() == ARCHIVE
        and build.get("images") == [tag]
        and len(steps) == 1
        and set(steps[0]) == {"name", "args", "status", "timing", "pullTiming"}
        and steps[0]["name"] == "gcr.io/cloud-builders/docker"
        and steps[0]["args"] == ["build", "--tag", tag, "."]
        and steps[0]["status"] == "SUCCESS"
        and build.get("options")
        == {"logging": "GCS_ONLY", "pool": {}, "workerRelease": "legacy"}
        and build.get("tags")
        == [f"auth-health-{OPERATION}", f"auth-health-source-{SOURCE}"]
    )
    images = build.get("results", {}).get("images", [])
    require(
        len(images) == 1
        and images[0].get("name") == tag
        and images[0].get("digest") == IMAGE.rsplit("@", 1)[1]
        and build["results"].get("buildStepImages")
        == ["sha256:f772ab459889c67835bd959c2b9e9351f2c0752c4f989710ecda20c229f0733e"]
    )


def job_identity(job):
    metadata = job.get("metadata", {})
    require(
        metadata.get("name") == NAME
        and metadata.get("uid") == UID
        and metadata.get("namespace") == NAMESPACE
        and metadata.get("creationTimestamp") == CREATED
        and str(metadata.get("generation")) == "1"
        and digest(job.get("spec")) == SPEC
    )


def execution(row):
    metadata = row.get("metadata", {})
    require(
        isinstance(metadata.get("name"), str)
        and metadata["name"].startswith(NAME + "-")
        and metadata.get("uid")
        and metadata.get("namespace") == NAMESPACE
        and instant(metadata["creationTimestamp"]) >= instant(CREATED)
        and metadata.get("ownerReferences")
        == [
            {
                "apiVersion": "serving.knative.dev/v1",
                "blockOwnerDeletion": True,
                "controller": True,
                "kind": "Job",
                "name": NAME,
                "uid": UID,
            }
        ]
        and digest(row.get("spec")) == EXECUTION_SPEC
    )
    return metadata["name"], metadata["uid"]


@dataclass(frozen=True)
class VerifiedJob:
    """An in-process collector result; serialized dictionaries grant no authority."""

    active_executions: tuple

    def receipt(self):
        return {
            "name": NAME,
            "uid": UID,
            "image": IMAGE,
            "source": SOURCE,
            "spec_sha256": SPEC,
            "build_id": BUILD,
            "source_archive_sha256": ARCHIVE,
            "connections": 0,
            "capacity_classification": "verified-no-direct-sql",
            "checked_active_executions": list(self.active_executions),
        }

    def matches(self, event):
        return event.get("resource", {}).get("labels", {}).get("job_name") == NAME

    def review_history(self, events):
        """Retain the exact birth and every effective execution; refuse mutation."""
        requested = created = False
        identities, outcomes = [], []
        for event in events:
            payload = event["protoPayload"]
            method = payload.get("methodName")
            lane = event["logName"].rsplit("/", 1)[-1]
            if method == "google.cloud.run.v1.Jobs.CreateJob":
                require(not requested and not created)
                _birth_request(payload, lane)
                requested = True
            elif method == "/Jobs.CreateJob":
                require(requested and not created)
                _birth_result(payload, lane)
                created = True
            else:
                require(created)
                identity, outcome = _execution_result(payload, lane, event["timestamp"])
                require(
                    all(
                        name != identity[0] and uid != identity[1]
                        for name, uid in identities
                    )
                )
                identities.append(identity)
                outcomes.append(outcome)
        require(
            requested and created and set(self.active_executions) <= set(identities)
        )
        return {
            **self.receipt(),
            "event_count": len(events),
            "executions": outcomes,
            "failed_execution_count": sum(
                row["completed"] == "False" for row in outcomes
            ),
        }


def _birth_request(payload, lane):
    require(
        (payload.get("status") or {}).get("code", 0) == 0
        and lane == "cloudaudit.googleapis.com%2Factivity"
        and payload.get("resourceName") == f"namespaces/{PROJECT}/jobs/{NAME}"
        and digest(payload.get("request")) == BIRTH
    )


def _birth_result(payload, lane):
    row = payload.get("response", {})
    metadata = row.get("metadata", {})
    ready = [
        condition.get("status")
        for condition in row.get("status", {}).get("conditions", [])
        if condition.get("type") == "Ready"
    ]
    require(
        (payload.get("status") or {}).get("code", 0) == 0
        and lane == "cloudaudit.googleapis.com%2Fsystem_event"
        and not payload.get("request")
        and ready == ["True"]
        and payload.get("resourceName") == f"namespaces/{PROJECT}/jobs/{NAME}"
        and row.get("kind") == "Job"
        and metadata.get("name") == NAME
        and metadata.get("uid") == UID
        and metadata.get("namespace") == NAMESPACE
        and metadata.get("creationTimestamp") == CREATED
        and digest(row.get("spec")) == SPEC
    )


def _execution_result(payload, lane, stamp):
    row = payload.get("response", {})
    require(
        lane == "cloudaudit.googleapis.com%2Fsystem_event"
        and payload.get("methodName") == "/Jobs.RunJob"
        and not payload.get("request")
        and row.get("kind") == "Execution"
    )
    identity = execution(row)
    completed = [
        condition.get("status")
        for condition in row.get("status", {}).get("conditions", [])
        if condition.get("type") == "Completed"
    ]
    code = (payload.get("status") or {}).get("code", 0)
    # A failed monitor is still this exact non-SQL program. Record its failure
    # without presenting the monitoring rollout as healthy.
    require((code, completed) in ((0, ["True"]), (10, ["False"])))
    require(
        payload.get("resourceName") == f"namespaces/{PROJECT}/executions/{identity[0]}"
        and instant(row["metadata"]["creationTimestamp"]) <= instant(stamp)
    )
    return identity, {
        "name": identity[0],
        "uid": identity[1],
        "audit_status": code,
        "completed": completed[0],
    }


def qualify(job, read):
    job_identity(job)
    reviewed_build(read)
    rows = read(
        "run",
        "jobs",
        "executions",
        "list",
        f"--job={NAME}",
        f"--project={PROJECT}",
        f"--region={REGION}",
        "--filter=NOT status.completionTime>=1970-01-01T00:00:00Z",
        "--limit=501",
    )
    require(isinstance(rows, list) and len(rows) < 501)
    active = []
    for row in rows:
        require(not row.get("status", {}).get("completionTime"))
        identity = execution(row)
        require(all(name != identity[0] and uid != identity[1] for name, uid in active))
        active.append(identity)
    fresh = read(
        "run", "jobs", "describe", NAME, f"--project={PROJECT}", f"--region={REGION}"
    )
    job_identity(fresh)
    return VerifiedJob(tuple(sorted(active)))


def capacity_rows(proof, jobs, environment):
    if proof is None:
        return []
    require(environment == "production" and type(proof) is VerifiedJob and NAME in jobs)
    job_identity(jobs[NAME])
    return [proof.receipt()]
