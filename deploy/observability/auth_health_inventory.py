# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bounded non-database classification of the reviewed Production health job.

Build 0f80cc7e-2265-4639-9a1a-199359b20600 produced the pinned image below.
Its generation-bound source archive SHA256 is
a19fcdb0dc591c5138f6b831668ca64d0b2e87d0f791ea8ac05e4fa8c922d07f.
All five image inputs were checked against reviewed repository source. The fixed
entrypoint reads protected lists/readiness and writes only its lease and health
log. This is an immutable source/spec exception, never a job-name exemption.
An image, configuration, UID or historical mutation requires renewed review.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime

NAME = "protected-configuration-health"
PROJECT = "hushh-pda"
NUMBER = "1006304528804"
UID = "2fe6b836-fc5a-4186-b8b3-19611ffb3dff"
CREATED = "2026-10-29T16:21:33.378523Z"
SOURCE = "05ea774ef2eba09f0dfb3a1737c966e74b6da4a8"
SPEC = "ff36ba631204673e5ac4f408b00cb4d6aa5012527631d3972b5ea1e44e3bdb6a"
TASK = "94af68e20eca9ae843e70debdd59ccdef242c3f3d655cdbfd2be7e74bcd26735"
BIRTH = (
    "5d56e9698a513fb9709c97eff23840ee793a956465cda545fbf5f3c391fd474c",
    "7eb903e88d1a06eab9236c91a619500928a45d2e98140f6f28fa139b2c890391",
)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def require(value):
    if not value:
        raise ValueError("auth_health_inventory_unqualified")


def qualify_job(job):
    metadata = job.get("metadata", {})
    require(
        metadata.get("name") == NAME
        and metadata.get("namespace") == NUMBER
        and metadata.get("uid") == UID
        and metadata.get("creationTimestamp") == CREATED
        and metadata.get("generation") == 1
        and fingerprint(job.get("spec")) == SPEC
    )
    return {
        "name": NAME,
        "uid": UID,
        "source": SOURCE,
        "spec": SPEC,
        "capacity_classification": "reviewed-auth-health-observer",
        "connections": 0,
    }


def qualify_execution(execution):
    metadata = execution.get("metadata", {})
    name = metadata.get("name", "")
    require(
        execution.get("kind") == "Execution"
        and metadata.get("namespace") == NUMBER
        and isinstance(name, str)
        and name.startswith(NAME + "-")
        and metadata.get("uid")
        and datetime.fromisoformat(metadata["creationTimestamp"].replace("Z", "+00:00"))
        >= datetime.fromisoformat(CREATED.replace("Z", "+00:00"))
        and metadata.get("ownerReferences")
        == [
            {
                "kind": "Job",
                "name": NAME,
                "uid": UID,
                "apiVersion": "serving.knative.dev/v1",
                "controller": True,
                "blockOwnerDeletion": True,
            }
        ]
        and fingerprint(execution.get("spec")) == TASK
    )
    return {"name": name, "uid": metadata["uid"], "spec": TASK}


def collect(job, read, opts):
    row = qualify_job(job)
    executions = read("run", "jobs", "executions", "list", "--job=" + NAME, *opts)
    require(isinstance(executions, list) and len(executions) < 10_000)
    seen, active = set(), []
    for execution in executions:
        metadata = execution.get("metadata", {})
        name = metadata.get("name")
        require(
            isinstance(name, str) and name.startswith(NAME + "-") and name not in seen
        )
        seen.add(name)
        if execution.get("status", {}).get("completionTime"):
            continue
        observed = read("run", "jobs", "executions", "describe", name, *opts)
        require(observed.get("metadata", {}).get("name") == name)
        active.append(qualify_execution(observed))
    return {
        **row,
        "checked_active_executions": sorted(active, key=lambda item: item["name"]),
    }


def review_history(events, job):
    """Close the exact birth and every completed effective execution/override."""
    qualify_job(job)
    require(
        len(events) >= 2 and tuple(fingerprint(event) for event in events[:2]) == BIRTH
    )
    executions, seen = [], set()
    for event in events[2:]:
        payload = event.get("protoPayload", {})
        require(
            event.get("logName")
            == f"projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event"
            and payload.get("methodName") == "/Jobs.RunJob"
            and not payload.get("request")
        )
        execution = payload.get("response", {})
        row = qualify_execution(execution)
        require(
            payload.get("resourceName")
            == f"namespaces/{PROJECT}/executions/{row['name']}"
            and row["uid"] not in seen
            and not any(previous["name"] == row["name"] for previous in executions)
        )
        completed = [
            condition
            for condition in execution.get("status", {}).get("conditions", [])
            if condition.get("type") == "Completed"
        ]
        require(len(completed) == 1 and completed[0].get("status") in {"True", "False"})
        seen.add(row["uid"])
        executions.append(row)
    return {
        "source": SOURCE,
        "uid": UID,
        "birth": list(BIRTH),
        "executions": executions,
    }
