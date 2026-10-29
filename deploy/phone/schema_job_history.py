# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Join redacted job requests to effective, UID-bound system execution evidence."""

from __future__ import annotations

import hashlib
import re

import workos_rollout as closed
from revision_qualification import PROJECT, REGION

OLD_PROBE = "f68c510a24e12828d577598e15aa482746130a549a6df34f4c05f3c4999e1d09"
RESTORATION_PROBE = "4d621b775a9386287d34222d1350ba0e86c84108797e9b7fa7d7845518eabf60"
APPROVED_PROBE = "0ea35fcf85d68e0e1bdcb1310b5d38d3cd607d60b4b6584ba2c0dd4893643164"
APPROVED_SOURCES = frozenset(
    {
        "4452c7121c80ef73e8e6d43cd7af19b20f679a83",
        "84b80bcab6b5b7a4de21a5a992d3c969dacba5b9",
    }
)
# These exact existing-global-readiness probes invoke no owner or phone operation.
DOCUMENT_PROBES = {
    "one-document-readiness-40286563192": (
        "3fb087c6-391b-44e6-8819-7f32bc275ddb",
        "5ec0b7816b352d9387964d0c3592de7e8b0e10ef39b0de847d8548d4c9c33ead",
    ),
    "one-document-readiness-diag-40286563192": (
        "c7760aff-a5b2-48cf-8aab-2ad1b024e812",
        "daaad33071efdc95f5ef699cbe3a8e1f2296eabb6298bbec3b1e3dacad22fb4f",
    ),
    "one-document-readiness-qualified-40286563192": (
        "ab4570cc-88d8-40be-ad60-bd00dece2787",
        "5e224ad3d42c2bce31e06c2373d1be53aad6a52ad8291e544123a0267b056340",
    ),
}


def require(value):
    if not value:
        raise ValueError("phone_schema_job_history_unqualified")


def _scope(event, start, until):
    payload = event.get("protoPayload", {})
    lane = event.get("logName", "").rsplit("/", 1)[-1]
    require(
        event.get("logName") == f"projects/{PROJECT}/logs/{lane}"
        and lane
        in {"cloudaudit.googleapis.com%2Factivity", "cloudaudit.googleapis.com%2Fsystem_event"}
        and payload.get("serviceName") == "run.googleapis.com"
        and event.get("resource", {}).get("labels", {}).get("location") == REGION
        and event.get("resource", {}).get("labels", {}).get("project_id") == PROJECT
        and closed._instant(start) <= closed._instant(event["timestamp"]) <= closed._instant(until)
    )
    return payload, lane, closed._instant(event["timestamp"])


def _launcher(name, uid, container, source, bindings, probe_images, qualified_images):
    from schema_producers import ROOT, run, source_capable

    if source_capable(source):
        require(qualified_images.get(container["image"]) == source)
    args = container.get("args", [])
    if re.fullmatch(r"genai-ready-[0-9a-f-]{36}", name):
        matches = [
            r
            for r in bindings
            if name == "genai-ready-" + r["build_id"]
            and r["image"] == container["image"]
            and r["source"] == source
        ]
        require(len(matches) == 1 and args == ["scripts/verify_managed_vertex_runtime.py"])
        body = run(
            ["git", "show", f"{source}:consent-protocol/scripts/verify_managed_vertex_runtime.py"]
        )
        current = (ROOT / "consent-protocol/scripts/verify_managed_vertex_runtime.py").read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        require(
            body == current
            or (digest in {OLD_PROBE, RESTORATION_PROBE} and source_capable(source) is False)
            # This reviewed production-equivalent probe predates only the
            # current UAT branch. Keep its exception inside this exact plan.
            or (
                digest == APPROVED_PROBE
                and source in APPROVED_SOURCES
                and (source, container["image"]) in probe_images
            )
        )
    else:
        require(
            name in DOCUMENT_PROBES
            and uid == DOCUMENT_PROBES[name][0]
            and source == "7d5546e471f2e168a898cd21c9abd7f1e8aaa9cc"
            and source_capable(source) is False
            and len(args) == 2
            and args[0] == "-c"
            and hashlib.sha256(args[1].encode()).hexdigest() == DOCUMENT_PROBES[name][1]
            and any(
                r["run_id"] == "40286563192"
                and r["source"] == source
                and r["image"] == container["image"]
                for r in bindings
            )
        )


def _effective_container(spec, birth, images):
    task = spec.get("template", {}).get("spec", {})
    require(not set(task) - {"containers", "serviceAccountName", "maxRetries", "timeoutSeconds"})
    containers = task.get("containers", [])
    require(len(containers) == 1 and containers[0].get("command") == ["python3"])
    container = containers[0]
    environment = container.get("env", [])
    names = [row.get("name") for row in environment]
    production = [row for row in environment if row.get("name") == "ENVIRONMENT"]
    require(
        len(names) == len(set(names))
        and None not in names
        and len(production) == 1
        and production[0].get("value") == "production"
        and "valueFrom" not in production[0]
    )
    require(
        not set(container) - {"image", "command", "args", "env", "resources"}
        and not any(
            row.get("name") == "PATH" or row.get("name", "").startswith(("PYTHON", "LD_"))
            for row in container.get("env", [])
        )
    )
    source = images.get(container.get("image"))
    require(source is not None)
    requested = birth.get("full_request", birth["request"])["spec"]["template"]["spec"]["template"][
        "spec"
    ]
    require(
        len(requested.get("containers", [])) == 1
        and not set(requested)
        - {"containers", "serviceAccountName", "maxRetries", "timeoutSeconds"}
        and requested["containers"][0].get("image") == container.get("image")
        and not set(requested["containers"][0])
        - {"image", "name", "resources", "command", "args", "env"}
        and all(
            value == container.get(key)
            for key, value in requested["containers"][0].items()
            if key != "name"
        )
        and all(
            requested.get(k) == task.get(k)
            for k in ("serviceAccountName", "maxRetries", "timeoutSeconds")
        )
    )
    return container, source


def _execution(event, births, images, bindings, project_number, probe_images, qualified_images):
    from schema_producers import fingerprint

    payload, execution = event["protoPayload"], event["protoPayload"].get("response", {})
    metadata, spec = execution.get("metadata", {}), execution.get("spec", {})
    owners = metadata.get("ownerReferences", [])
    require(
        payload.get("methodName") == "/Jobs.RunJob"
        and not payload.get("request")
        and execution.get("kind") == "Execution"
        and len(owners) == 1
    )
    owner = owners[0]
    name, uid = owner.get("name"), owner.get("uid")
    require(
        owner.get("kind") == "Job"
        and owner.get("apiVersion") == "serving.knative.dev/v1"
        and owner.get("controller") is True
        and owner.get("blockOwnerDeletion") is True
        and name in births
        and uid
    )
    birth = births[name]
    require(
        not birth.get("deleted")
        and birth.get("uid") == uid
        and metadata.get("uid")
        and metadata.get("name", "").startswith(name + "-")
        and metadata.get("namespace") == project_number
        and event["resource"]["labels"].get("job_name") == name
        and payload.get("resourceName") == f"namespaces/{PROJECT}/executions/{metadata.get('name')}"
    )
    started = closed._instant(metadata["creationTimestamp"])
    require(birth["stamp"] <= started <= closed._instant(event["timestamp"]))
    container, source = _effective_container(spec, birth, images)
    _launcher(name, uid, container, source, bindings, probe_images, qualified_images)
    terminal = [
        c for c in execution.get("status", {}).get("conditions", []) if c.get("type") == "Completed"
    ]
    require(len(terminal) == 1 and terminal[0].get("status") in {"True", "False"})
    require(
        not any(
            row["uid"] == metadata["uid"] or row["name"] == metadata["name"]
            for value in births.values()
            for row in value["executions"]
        )
    )
    birth["uid"] = uid
    birth["executions"].append(
        {
            "uid": metadata["uid"],
            "name": metadata["name"],
            "source": source,
            "image": container["image"],
            "spec": fingerprint(spec),
            "owner": fingerprint(owner),
        }
    )


def _completion(event, births, images, bindings, project_number, probe_images, qualified_images):
    from schema_producers import fingerprint

    payload, row = event["protoPayload"], event["protoPayload"].get("response", {})
    metadata = row.get("metadata", {})
    name = event["resource"]["labels"].get("job_name")
    require(
        name in births
        and not payload.get("request")
        and metadata.get("namespace") == project_number
        and metadata.get("uid")
        and (payload.get("status") or {}).get("code", 0) == 0
    )
    birth = births[name]
    if payload.get("methodName") == "/Jobs.CreateJob":
        require(
            row.get("kind") == "Job"
            and metadata.get("name") == name
            and payload.get("resourceName") == f"namespaces/{PROJECT}/jobs/{name}"
            and "uid" not in birth
            and not birth.get("deleted")
            and birth["stamp"]
            <= closed._instant(metadata["creationTimestamp"])
            <= closed._instant(event["timestamp"])
        )
        spec = {"template": row["spec"]["template"]["spec"]["template"]}
        container, source = _effective_container(spec, birth, images)
        _launcher(
            name, metadata["uid"], container, source, bindings, probe_images, qualified_images
        )
        birth.update(
            uid=metadata["uid"],
            full_request=row,
            job_spec=fingerprint(row["spec"]),
            deleted_executions=set(),
        )
        return
    require(payload.get("methodName") == "/Jobs.DeleteJob" and birth.get("deleted") is True)
    if row.get("kind") == "Job":
        require(
            metadata.get("name") == name
            and metadata["uid"] == birth.get("uid")
            and payload.get("resourceName") == f"namespaces/{PROJECT}/jobs/{name}"
            and fingerprint(row.get("spec")) == birth["job_spec"]
            and not birth.get("job_deleted")
        )
        birth["job_deleted"] = True
    else:
        require(
            row.get("kind") == "Execution"
            and payload.get("resourceName")
            == f"namespaces/{PROJECT}/executions/{metadata.get('name')}"
        )
        matching = [
            e
            for e in birth["executions"]
            if e["uid"] == metadata["uid"]
            and e["name"] == metadata.get("name")
            and e["spec"] == fingerprint(row.get("spec"))
        ]
        owners = metadata.get("ownerReferences", [])
        require(
            len(matching) == len(owners) == 1
            and owners[0].get("uid") == birth["uid"]
            and owners[0].get("name") == name
            and owners[0].get("kind") == "Job"
            and fingerprint(owners[0]) == matching[0]["owner"]
            and metadata["uid"] not in birth["deleted_executions"]
        )
        birth["deleted_executions"].add(metadata["uid"])


def _activity(event, births, jobs, stamp):
    from schema_producers import fingerprint

    payload = event["protoPayload"]
    method, request = payload.get("methodName"), payload.get("request", {})
    require((payload.get("status") or {}).get("code", 0) == 0)
    if method == "google.cloud.run.v1.Jobs.CreateJob":
        job = request.get("job", {})
        metadata = job.get("metadata", {})
        name = metadata.get("name")
        require(
            set(request) == {"@type", "parent", "job"}
            and request["@type"] == "type.googleapis.com/google.cloud.run.v1.CreateJobRequest"
            and request["parent"] == f"namespaces/{PROJECT}"
            and metadata.get("namespace") == PROJECT
            and event["resource"]["labels"].get("job_name") == name
            and isinstance(name, str)
            and name not in births
            and name not in jobs
            and isinstance(job.get("spec", {}).get("template"), dict)
        )
        births[name] = {
            "stamp": stamp,
            "request": job,
            "executions": [],
            "create_event": fingerprint(event),
        }
    elif method == "google.cloud.run.v1.Jobs.DeleteJob":
        require(
            set(request) == {"@type", "name"}
            and request["@type"] == "type.googleapis.com/google.cloud.run.v1.DeleteJobRequest"
        )
        name = request.get("name", "").rsplit("/", 1)[-1]
        require(
            request["name"] == f"namespaces/{PROJECT}/jobs/{name}"
            and event["resource"]["labels"].get("job_name") == name
            and name in births
            and not births[name].get("deleted")
            and births[name]["executions"]
            and name not in jobs
        )
        births[name].update(deleted=True, delete_event=fingerprint(event))
    else:
        # Unreviewed mutation or request-time execution overrides stay fenced.
        raise ValueError("phone_schema_job_mutation_unknown")


def review(events, jobs, images, until, *, submissions, project_number, probe_images=frozenset()):
    from schema_producers import HISTORY_START

    require(
        isinstance(events, list)
        and len(events) < closed.LIMIT
        and isinstance(project_number, str)
        and project_number.isdigit()
    )
    proof = submissions()
    require(proof.get("qualification") == "passed")
    bindings = proof.get("acknowledged_attempts", [])
    qualified_images = dict(images)
    images = dict(images)
    for row in bindings:
        require(images.get(row["image"], row["source"]) == row["source"])
        images[row["image"]] = row["source"]
    births, seen, previous = {}, set(), closed._instant(HISTORY_START)
    for event in events:
        payload, lane, stamp = _scope(event, HISTORY_START, until)
        require(stamp >= previous and event.get("insertId") and event["insertId"] not in seen)
        seen.add(event["insertId"])
        previous = stamp
        if lane.endswith("system_event"):
            if payload.get("methodName") == "/Jobs.RunJob":
                _execution(
                    event, births, images, bindings, project_number, probe_images, qualified_images
                )
            else:
                _completion(
                    event, births, images, bindings, project_number, probe_images, qualified_images
                )
            continue
        _activity(event, births, jobs, stamp)
    require(
        all(
            row.get("deleted") is True
            and row.get("job_deleted") is True
            and row["deleted_executions"] == {e["uid"] for e in row["executions"]}
            for row in births.values()
        )
    )
    return {
        "event_count": len(events),
        "closed_jobs": [
            {
                "job": name,
                "uid": row["uid"],
                "create_event": row["create_event"],
                "delete_event": row["delete_event"],
                "executions": row["executions"],
            }
            for name, row in sorted(births.items())
        ],
    }


def qualify(jobs, images, until, *, submissions, probe_images):
    from schema_producers import HISTORY_START

    query = (
        f'(logName="projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Factivity" OR '
        f'logName="projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event") '
        'protoPayload.serviceName="run.googleapis.com" '
        'protoPayload.methodName=~"(CreateJob|ReplaceJob|UpdateJob|RunJob|DeleteJob)$" '
        f'timestamp>="{HISTORY_START}" timestamp<="{until}"'
    )
    events = closed._document(
        [
            "gcloud",
            "logging",
            "read",
            query,
            f"--project={PROJECT}",
            f"--limit={closed.LIMIT}",
            "--order=asc",
            "--format=json",
        ]
    )
    project = closed._document(
        ["gcloud", "projects", "describe", PROJECT, "--format=json(projectId,projectNumber)"]
    )
    require(project.get("projectId") == PROJECT)
    return review(
        events,
        jobs,
        images,
        until,
        submissions=submissions,
        project_number=str(project.get("projectNumber", "")),
        probe_images=probe_images,
    )
