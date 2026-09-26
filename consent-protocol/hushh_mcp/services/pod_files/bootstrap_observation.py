"""Read back Files resources; an adopted queue is never recorded as created."""

from typing import Any

from hushh_mcp.services.pod_files.provisioning import (
    bucket_matches,
    queue_creation_observation,
    queue_matches,
)


def verify_files_step(
    session: Any, call: dict, headers: dict, *, code: int, ok: bool, enabled: bool
) -> tuple[bool, dict | None]:
    from hushh_mcp.services.user_gcp_bootstrap import _json_or_empty

    if call["step"] == "files_queue" and code in (200, 201, 409):
        name = call["body"]["name"]
        response = session.get(
            f"https://cloudtasks.googleapis.com/v2/{name}",
            headers=headers,
            timeout=30,
            allow_redirects=False,
        )
        body = _json_or_empty(response)
        valid = response.status_code == 200 and queue_matches(body, call["body"])
        identity = queue_creation_observation(body, name) if valid and code in (200, 201) else None
        return valid, (
            {
                "type": "cloud_tasks_queue",
                "id": name.rsplit("/", 1)[-1],
                "disposition": "created",
                "identity": identity,
            }
            if identity
            else None
        )
    if ok and call["step"] == "cmek_bucket" and enabled:
        name = call["body"]["name"]
        response = session.get(
            f"https://storage.googleapis.com/storage/v1/b/{name}",
            headers=headers,
            timeout=30,
            allow_redirects=False,
        )
        ok = response.status_code == 200 and bucket_matches(
            _json_or_empty(response),
            bucket=name,
            kms_key=call["body"]["encryption"]["defaultKmsKeyName"],
        )
    return ok, None
