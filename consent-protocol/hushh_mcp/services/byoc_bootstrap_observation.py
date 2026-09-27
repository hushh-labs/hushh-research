"""Qualify bootstrap acknowledgements without retaining provider response bodies.

The substrate validators remain the authority for creation identities. These
adapters bind an acknowledgement to the exact request and independently resolved
project before it can be retained in an operation receipt.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.byoc_substrate import (
    _bucket_creation_identity,
    _kms_key_creation_identity,
    _mail_creation_identity,
    _secret_creation_identity,
    _service_account_creation_identity,
)


def _created(kind: str, name: str, identity: dict | None) -> dict[str, Any]:
    if not identity:
        return {}
    return {
        "resourceObservation": {
            "type": kind,
            "id": name,
            "disposition": "created",
            "identity": identity,
        }
    }


def _bucket(call: dict, body: dict) -> dict:
    name = (call.get("body") or {}).get("name")
    if not isinstance(name, str) or not name:
        return {}
    if "name" in body and body["name"] != name:
        return {"ok": False, "detail": "bucket creation identity mismatch"}
    return _created("gcs_bucket", name, _bucket_creation_identity(body, name))


def _account(call: dict, body: dict, project: str) -> dict:
    account_id = (call.get("body") or {}).get("accountId")
    email = f"{account_id}@{project}.iam.gserviceaccount.com"
    if ("email" in body and body["email"] != email) or (
        "projectId" in body and body["projectId"] != project
    ):
        return {"ok": False, "detail": "service account creation identity mismatch"}
    return _created("service_account", email, _service_account_creation_identity(body, email))


def _key(call: dict, body: dict) -> dict:
    key_id = call["params"]["cryptoKeyId"]
    name = f"{call['url'].removeprefix('https://cloudkms.googleapis.com/v1/')}/{key_id}"
    if ("name" in body and body["name"] != name) or (
        "purpose" in body and body["purpose"] != "ENCRYPT_DECRYPT"
    ):
        return {"ok": False, "detail": "KMS key creation identity mismatch"}
    return _created("kms_key", key_id, _kms_key_creation_identity(body, name))


def _mail(call: dict, body: dict, kind: str) -> dict:
    requested = call.get("body") or {}
    name = (
        requested.get("name") if kind == "cloud_scheduler_job" else call["url"].partition("/v1/")[2]
    )
    identity = _mail_creation_identity(body, kind, name)
    if not identity:
        return {}
    if kind == "pubsub_subscription" and identity["topic"] != requested.get("topic"):
        return {}
    if kind == "cloud_scheduler_job" and (
        any(identity[key] != requested.get(key) for key in ("schedule", "timeZone"))
        or identity["pubsubTarget"]["topicName"]
        != requested.get("pubsubTarget", {}).get("topicName")
    ):
        return {}
    return _created(kind, name.rsplit("/", 1)[-1], identity)


def qualify_created_resource(
    call: dict, body: dict, *, project: str, project_number: str | None
) -> dict[str, Any]:
    """Return bounded result fields for an already successful creation response.

    Missing creation evidence does not make adoption into creation. It retains
    bootstrap compatibility while leaving later automatic cleanup unqualified.
    """
    step = call["step"]
    if step == "cmek_bucket":
        return _bucket(call, body)
    if step in {"pod_service_account", "files_worker_account"}:
        return _account(call, body, project)
    if step == "kms_key":
        return _key(call, body)
    if step == "pod_signing_secret":
        secret_id = call["params"]["secretId"]
        # Project-number aliases come from Resource Manager, never the response.
        candidate = {
            "name": body.get("name"),
            "createTime": body.get("createTime"),
            "projectId": project,
            **({"projectNumber": project_number} if project_number else {}),
        }
        return _created(
            "secret", secret_id, _secret_creation_identity(candidate, secret_id, project)
        )
    kind = {
        "mail_topic": "pubsub_topic",
        "mail_subscription": "pubsub_subscription",
        "watch_renew_job": "cloud_scheduler_job",
    }.get(step)
    return _mail(call, body, kind) if kind else {}
