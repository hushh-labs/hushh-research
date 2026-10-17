"""Exact owner-project runtime grants; declaration is not creation provenance."""

from __future__ import annotations

from typing import Any

RUNTIME_GRANT_STEPS = {
    "roles/aiplatform.user": "iam_pod_sa_vertex",
    "roles/serviceusage.serviceUsageConsumer": "iam_pod_sa_quota",
}


def runtime_grant_plan(project: str, member: str) -> list[dict[str, Any]]:
    notes = (
        "PROJECT-LEVEL Vertex calls as your own agent, on your quota and bill; no AI key supplied to Hussh",
        "PROJECT-LEVEL quota consumption; does not enable APIs or change billing",
    )
    return [
        {
            "member": member,
            "role": role,
            "on": f"project:{project}",
            "project_level": True,
            "note": note,
        }
        for role, note in zip(RUNTIME_GRANT_STEPS, notes, strict=True)
    ]


def runtime_grant_calls(project: str, member: str) -> list[dict[str, Any]]:
    resource = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}"
    return [
        {
            "step": step,
            "kind": "merge_binding",
            "read_url": resource + ":getIamPolicy",
            "read_method": "POST",
            "write_url": resource + ":setIamPolicy",
            "policy_envelope": "policy",
            "bindings": [{"role": role, "members": [f"serviceAccount:{member}"]}],
            "tolerate": [],
            "project_level": True,
        }
        for role, step in RUNTIME_GRANT_STEPS.items()
    ]


def runtime_grant_target_matches(action: dict, binding: dict, identity: dict, project: str) -> bool:
    return (
        RUNTIME_GRANT_STEPS.get(action.get("role")) == binding["step"]
        and action.get("role") in RUNTIME_GRANT_STEPS
        and binding["disposition"] == "added"
        and binding["member"] == f"serviceAccount:{identity['email']}"
        and action.get("member")
        == f"deleted:serviceAccount:{identity['email']}?uid={identity['uniqueId']}"
        and binding["policyResource"]
        == f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:getIamPolicy"
    )
