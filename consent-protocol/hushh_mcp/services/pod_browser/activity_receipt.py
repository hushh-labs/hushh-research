"""Content-free, bounded terminal Browser activity for encrypted owner history."""

import json
import re


def parse_activity_receipt(value):
    if (
        not isinstance(value, dict)
        or set(value) != {"v", "kind", "state", "task_id", "operation_id"}
        or type(value.get("v")) is not int
        or value["v"] != 1
        or value.get("kind") not in {"browser_sign_in", "browser_review"}
        or value.get("state") not in {"allowed", "completed", "cancelled", "superseded"}
        or not isinstance(value.get("task_id"), str)
        or not re.fullmatch(r"browser_[a-f0-9]{32}", value["task_id"])
        or not isinstance(value.get("operation_id"), str)
        or not re.fullmatch(r"[A-Za-z0-9_.:-]{8,64}", value["operation_id"])
    ):
        return None
    if len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()) > 256:
        return None
    return dict(value)


def activity_receipt(*, kind, state, task_id, operation_id):
    return parse_activity_receipt(
        {"v": 1, "kind": kind, "state": state, "task_id": task_id, "operation_id": operation_id}
    )
