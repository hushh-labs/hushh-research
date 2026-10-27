"""Pure checks for custom roles declared by the production IAM setup owner."""

from __future__ import annotations

import re
from typing import Any

PREREQUISITE_READ_VERBS = frozenset({"list", "getKeyString", "getIamPolicy"})
ACTIVE_CUSTOM_ROLE_STAGES = frozenset({"ALPHA", "BETA", "GA"})


def _record_shape(record, prefix):
    role_id, role, stage, permissions = (
        record[prefix + suffix]
        for suffix in ("_ROLE_ID", "_ROLE", "_ROLE_STAGE", "_PERMISSIONS")
    )
    return (
        isinstance(role_id, str)
        and re.fullmatch(r"[A-Za-z0-9_.]{3,64}", role_id)
        and role == f"projects/{record['PROD_PROJECT_ID']}/roles/{role_id}"
        and record["DEPLOY_PROJECT_ROLES"].count(role) == 1
        and isinstance(stage, str)
        and stage in ACTIVE_CUSTOM_ROLE_STAGES
        and isinstance(permissions, list)
        and bool(permissions)
        and all(isinstance(p, str) for p in permissions)
        and len(permissions) == len(set(permissions))
    )


def audit_prerequisite_record(record: dict[str, Any]) -> list[dict[str, Any]]:
    valid = _record_shape(record, "PREREQUISITE_READ") and all(
        re.fullmatch(r"[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){2,}", permission)
        and permission.rsplit(".", 1)[-1] in PREREQUISITE_READ_VERBS
        for permission in record["PREREQUISITE_READ_PERMISSIONS"]
    )
    return [] if valid else [{"reason": "prerequisite_read_role_record_invalid"}]


def audit_cleanup_scheduler_record(record):
    permissions = record["CLEANUP_SCHEDULER_PERMISSIONS"]
    valid = (
        _record_shape(record, "CLEANUP_SCHEDULER")
        and len(permissions) == 8
        and all(
            re.fullmatch(
                r"cloudscheduler\.jobs\.(create|enable|get|list|pause|run|update)",
                permission,
            )
            or permission == "cloudscheduler.locations.list"
            for permission in permissions
        )
    )
    return [] if valid else [{"reason": "cleanup_scheduler_role_record_invalid"}]


def audit_custom_role(
    record: dict[str, Any],
    role: Any,
    *,
    prefix="PREREQUISITE_READ",
    reason="prerequisite_read_role",
) -> list[dict[str, Any]]:
    if not isinstance(role, dict) or role.get("name") != record[prefix + "_ROLE"]:
        return [{"reason": reason + "_missing_or_mismatched"}]
    if role.get("deleted", False) is not False or role.get("stage") == "DISABLED":
        return [{"reason": reason + "_inactive"}]
    if role.get("stage") != record[prefix + "_ROLE_STAGE"]:
        return [{"reason": reason + "_stage_drift"}]
    permissions = role.get("includedPermissions")
    if not isinstance(permissions, list) or any(
        not isinstance(p, str) for p in permissions
    ):
        return [{"reason": reason + "_permissions_unavailable"}]
    expected, actual = set(record[prefix + "_PERMISSIONS"]), set(permissions)
    if expected != actual:
        return [
            {
                "reason": reason + "_permissions_drift",
                "missing_permissions": sorted(expected - actual),
                "extra_permission_count": len(actual - expected),
            }
        ]
    return []


def audit_cleanup_scheduler_binding(record, policy):
    member = f"serviceAccount:{record['DEPLOY_SERVICE_ACCOUNT_EMAIL']}"
    bindings = [
        binding
        for binding in policy.get("bindings", [])
        if isinstance(binding, dict)
        and binding.get("role") == record["CLEANUP_SCHEDULER_ROLE"]
    ]
    valid = (
        len(bindings) == 1
        and bindings[0].get("members") == [member]
        and not bindings[0].get("condition")
    )
    return [] if valid else [{"reason": "cleanup_scheduler_role_binding_drift"}]


def expected_role(record, prefix):
    return {
        "name": record[prefix + "_ROLE"],
        "stage": record[prefix + "_ROLE_STAGE"],
        "includedPermissions": sorted(record[prefix + "_PERMISSIONS"]),
    }
