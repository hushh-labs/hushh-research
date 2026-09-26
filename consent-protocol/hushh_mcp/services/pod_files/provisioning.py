"""Files additions to the existing owner-approved BYOC substrate plan.

These functions only render resources. They never obtain credentials or apply IAM.
The existing bootstrap remains the sole execution and receipt owner.
"""

from __future__ import annotations

import hashlib
from copy import deepcopy
from typing import Any


def coordinates(owner: str, project: str, region: str) -> dict[str, str]:
    suffix = hashlib.sha256(owner.encode()).hexdigest()[:20]
    worker_id = f"one-files-{suffix}"
    return {
        "queueId": worker_id,
        "workerId": worker_id,
        "queue": f"projects/{project}/locations/{region}/queues/{worker_id}",
        "worker": f"{worker_id}@{project}.iam.gserviceaccount.com",
    }


def configure_new_service(
    config: dict[str, Any], *, owner: str, project: str, region: str, env: list[dict[str, Any]]
) -> None:
    names = coordinates(owner, project, region)
    env.extend(
        [
            {"name": "POD_FILES_ENABLED", "value": "true"},
            {"name": "POD_FILES_TASK_QUEUE", "value": names["queue"]},
            {"name": "POD_FILES_WORKER_SERVICE_ACCOUNT", "value": names["worker"]},
        ]
    )
    template = config["spec"]["template"]
    annotations = template["metadata"]["annotations"]
    # Respect a deliberately warm configuration. Only the new economy profile changes.
    if annotations.get("autoscaling.knative.dev/minScale", "0") == "0":
        env.append({"name": "POD_IDLE_GRACE_SECONDS", "value": "600"})
        annotations["autoscaling.knative.dev/maxScale"] = "1"
        template["spec"]["containerConcurrency"] = 8
        template["spec"]["containers"][0]["resources"]["limits"] = {"cpu": "1", "memory": "1Gi"}


def preserve_existing_configuration(existing: dict[str, Any], desired: dict[str, Any]) -> None:
    """An image upgrade/heal cannot opt an existing owner into Files or new sizing."""
    old = existing["spec"]["template"]
    new = desired["spec"]["template"]
    old_container = old["spec"]["containers"][0]
    new_container = new["spec"]["containers"][0]
    new_container["env"] = [
        item for item in new_container["env"] if not item["name"].startswith("POD_FILES_")
    ]
    new_container["env"].extend(
        deepcopy(
            [item for item in old_container.get("env", []) if item["name"].startswith("POD_FILES_")]
        )
    )
    if "resources" in old_container:
        new_container["resources"] = deepcopy(old_container["resources"])
    if "containerConcurrency" in old["spec"]:
        new["spec"]["containerConcurrency"] = old["spec"]["containerConcurrency"]
    else:
        new["spec"].pop("containerConcurrency", None)
    old_annotations = old.get("metadata", {}).get("annotations", {})
    # Existing resource_tier continues to own minScale and CPU allocation. Do
    # not defeat an explicit owner-requested warm/economy transition here.
    for name in ("autoscaling.knative.dev/maxScale",):
        if name in old_annotations:
            new["metadata"]["annotations"][name] = old_annotations[name]


def extend_plan(
    plan: dict[str, Any],
    *,
    owner: str,
    project: str,
    region: str,
    runtime: str,
    service: str,
    bucket: str,
) -> None:
    names = coordinates(owner, project, region)
    plan["filesLibrary"] = {
        "format": 1,
        "prefix": f"pods/{owner}/files/v1",
        "queue": names["queue"],
        "worker": names["worker"],
        "backgroundProvider": "owner-project Vertex AI",
        "analysisRequiresOptIn": True,
        "trash": "retained until explicit deletion; provider retention applies",
    }
    plan["resources"].extend(
        [
            {
                "type": "cloud_tasks_queue",
                "id": names["queueId"],
                "purpose": "bounded Files organization with identifier-only tasks",
            },
            {
                "type": "service_account",
                "id": names["worker"],
                "purpose": "Files worker OIDC identity; no storage or model access",
            },
        ]
    )
    plan["iam"].extend(
        [
            {"member": runtime, "role": "roles/cloudtasks.enqueuer", "on": names["queue"]},
            {"member": runtime, "role": "roles/iam.serviceAccountUser", "on": names["worker"]},
            {
                "member": names["worker"],
                "role": "roles/run.invoker",
                "on": service,
                "applied_at": "provision",
            },
            {
                "member": runtime,
                "role": "roles/storage.legacyBucketReader",
                "on": bucket,
                "note": "read bucket security and effective retention metadata; object access already exists",
            },
            {
                "member": "the project's Cloud Tasks service agent",
                "role": "roles/cloudtasks.serviceAgent",
                "on": f"project:{project}",
                "project_level": True,
                "note": "Google-managed task delivery identity; never granted to runtime or worker",
            },
        ]
    )


def bootstrap_calls(
    plan: dict[str, Any], *, project: str, region: str, runtime: str
) -> list[dict[str, Any]]:
    files = plan.get("filesLibrary")
    if not files:
        return []
    worker, queue = files["worker"], files["queue"]
    worker_id = worker.partition("@")[0]
    if not worker.endswith(f"@{project}.iam.gserviceaccount.com") or not queue.startswith(
        f"projects/{project}/locations/{region}/queues/"
    ):
        raise ValueError("Files worker must belong to the owner project and region")
    worker_base = f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{worker}"
    queue_base = f"https://cloudtasks.googleapis.com/v2/{queue}"
    bucket = next(
        resource["id"] for resource in plan["resources"] if resource["type"] == "gcs_bucket"
    )
    return [
        {
            "step": "generate_files_task_identity",
            "method": "POST",
            "url": f"https://serviceusage.googleapis.com/v1beta1/projects/{project}/services/cloudtasks.googleapis.com:generateServiceIdentity",
            "body": {},
            "tolerate": [],
            "await_operation": True,
            "operation_url": "https://serviceusage.googleapis.com/v1beta1/",
        },
        {
            "step": "iam_files_task_identity",
            "kind": "merge_binding",
            "depends_on": "generate_files_task_identity",
            "read_method": "POST",
            "read_url": f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:getIamPolicy",
            "write_url": f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:setIamPolicy",
            "policy_envelope": "policy",
            "member_lookup": {
                "url": f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}",
                "field": "projectNumber",
                "member_template": "serviceAccount:service-{value}@gcp-sa-cloudtasks.iam.gserviceaccount.com",
            },
            "bindings": [{"role": "roles/cloudtasks.serviceAgent", "members": []}],
        },
        {
            "step": "files_worker_account",
            "method": "POST",
            "url": f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts",
            "body": {"accountId": worker_id, "serviceAccount": {"displayName": "One Files worker"}},
            "tolerate": [409],
        },
        {
            "step": "files_queue",
            "method": "POST",
            "url": f"https://cloudtasks.googleapis.com/v2/projects/{project}/locations/{region}/queues",
            "body": {
                "name": queue,
                "rateLimits": {"maxDispatchesPerSecond": 1, "maxConcurrentDispatches": 1},
                "retryConfig": {
                    "maxAttempts": 3,
                    "maxRetryDuration": "0s",
                    "minBackoff": "10s",
                    "maxBackoff": "60s",
                    "maxDoublings": 2,
                },
            },
            "tolerate": [],
        },  # Existing queues need readback, never blind 409 adoption.
        {
            "step": "iam_files_enqueuer",
            "kind": "merge_binding",
            "depends_on": "files_queue",
            "read_method": "POST",
            "read_url": queue_base + ":getIamPolicy",
            "write_url": queue_base + ":setIamPolicy",
            "policy_envelope": "policy",
            "bindings": [
                {"role": "roles/cloudtasks.enqueuer", "members": [f"serviceAccount:{runtime}"]}
            ],
        },
        {
            "step": "iam_files_worker_actas",
            "kind": "merge_binding",
            "depends_on": "files_worker_account",
            "read_method": "POST",
            "read_url": worker_base + ":getIamPolicy",
            "write_url": worker_base + ":setIamPolicy",
            "policy_envelope": "policy",
            "bindings": [
                {"role": "roles/iam.serviceAccountUser", "members": [f"serviceAccount:{runtime}"]}
            ],
        },
        {
            "step": "iam_files_bucket_metadata",
            "kind": "merge_binding",
            "depends_on": "cmek_bucket",
            "read_method": "GET",
            "read_url": f"https://storage.googleapis.com/storage/v1/b/{bucket}/iam",
            "write_url": f"https://storage.googleapis.com/storage/v1/b/{bucket}/iam",
            "write_method": "PUT",
            "policy_envelope": None,
            "bindings": [
                {
                    "role": "roles/storage.legacyBucketReader",
                    "members": [f"serviceAccount:{runtime}"],
                }
            ],
        },
    ]


def queue_matches(observed: dict[str, Any], requested: dict[str, Any]) -> bool:
    """A same-name queue with wider limits is not the approved worker configuration."""
    if observed.get("name") != requested["name"] or observed.get("state") != "RUNNING":
        return False
    for field in ("rateLimits", "retryConfig"):
        values = dict(observed.get(field) or {})
        if field == "retryConfig":
            # Protobuf JSON may omit a zero-valued duration.
            values.setdefault("maxRetryDuration", "0s")
        if any(values.get(key) != value for key, value in requested[field].items()):
            return False
    # Queue-level overrides could redirect an otherwise correctly bound task.
    return not observed.get("httpTarget") and not observed.get("appEngineRoutingOverride")


def queue_creation_observation(value: Any, expected_name: str) -> dict[str, Any] | None:
    """Bounded creation/configuration evidence, not an immutable queue incarnation."""
    import re

    if not isinstance(value, dict) or not re.fullmatch(
        r"projects/[a-z][a-z0-9-]{4,61}[a-z0-9]/locations/[a-z0-9-]+/queues/one-files-[a-f0-9]{20}",
        expected_name,
    ):
        return None
    wanted = {
        "name": expected_name,
        "rateLimits": {"maxDispatchesPerSecond": 1, "maxConcurrentDispatches": 1},
        "retryConfig": {
            "maxAttempts": 3,
            "maxRetryDuration": "0s",
            "minBackoff": "10s",
            "maxBackoff": "60s",
            "maxDoublings": 2,
        },
    }
    if not queue_matches({**value, "state": "RUNNING"}, wanted):
        return None
    return wanted


def bucket_matches(value: dict[str, Any], *, bucket: str, kms_key: str) -> bool:
    iam = value.get("iamConfiguration") or {}
    return bool(
        kms_key
        and value.get("name") == bucket
        and (value.get("encryption") or {}).get("defaultKmsKeyName") == kms_key
        and iam.get("publicAccessPrevention") == "enforced"
        and (iam.get("uniformBucketLevelAccess") or {}).get("enabled")
    )
