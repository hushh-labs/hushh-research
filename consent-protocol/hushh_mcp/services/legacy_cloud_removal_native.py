"""Native GCP observations and execution for the existing legacy removal journal.

Cloud Run, bucket and KMS mutations reuse the existing incarnation-aware adapters.
This module never opens encrypted owner records, creates hosting, or broadens a
recorded resource into project-wide deletion authority.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit
from uuid import uuid4

import requests

from hushh_mcp.services.legacy_cloud_removal import (
    PROTECTED_PROJECTS,
    LegacyRemovalJournal,
    _require,
    resource_key,
    resource_state,
    sha256,
)


class RecoverySession(requests.Session):
    """Keep every provider write bound to the original, live operator DB session."""

    def __init__(
        self,
        *,
        token: str,
        project: str,
        journal: LegacyRemovalJournal | None = None,
        dispatch_guard=None,
    ):
        super().__init__()
        self.headers.update({"Authorization": "Bearer " + token, "x-goog-user-project": project})
        self.journal = journal
        self.dispatch_guard = dispatch_guard
        self.resource: dict | None = None

    def request(self, method: str, url: str, **kwargs):
        method = method.upper()
        kwargs["allow_redirects"] = False
        kwargs.setdefault("timeout", 30)
        readonly = (
            method == "GET"
            or method == "POST"
            and url.endswith((":testIamPermissions", ":getIamPolicy"))
        )
        request_id = None
        if not readonly:
            if self.dispatch_guard is not None:
                self.dispatch_guard()
            _require(self.journal is not None and self.resource is not None)
            _require(
                self.resource["authority"] == "owner_reviewed", "CLOUD_REMOVAL_PROTECTED_RESOURCE"
            )
            plan = self.journal.read()["plan"]
            base = resource_url(
                plan["project"]["projectId"],
                plan["runtime"]["serviceName"].split("/")[3],
                self.resource,
            )
            parsed = urlsplit(url)
            _require(parsed.scheme == "https" and not parsed.query and not parsed.fragment)
            allowed = (
                url == base
                or url.startswith(base + "/")
                or url in {base + ":disable", base + ":setIamPolicy"}
            )
            if self.resource["type"] == "service_account":
                allowed = (
                    allowed
                    or url
                    == "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"
                    + quote(self.resource["identity"]["uniqueId"], safe="")
                    + ":generateAccessToken"
                )
            if self.resource["type"] == "gcs_bucket":
                allowed = allowed or url.startswith(
                    "https://storage.googleapis.com/upload/storage/v1/b/"
                    + quote(self.resource["id"], safe="")
                    + "/"
                )
            if self.resource["type"] in {"project_iam_policy", "bootstrap_access"}:
                allowed = method == "POST" and url == base + ":setIamPolicy"
            _require(allowed, "CLOUD_REMOVAL_PROTECTED_RESOURCE")
            identity = self.journal.identity_sha256(self.resource)
            request_id = uuid4().hex
            target = sha256(
                {
                    "method": method,
                    "url": url,
                    "params": kwargs.get("params"),
                    "json": kwargs.get("json"),
                }
            )
            self.journal.append(
                resource_key(self.resource),
                "provider_dispatch",
                {
                    "identitySha256": identity,
                    "requestId": request_id,
                    "targetSha256": target,
                    "method": method,
                    "purpose": "credential_probe"
                    if parsed.hostname == "iamcredentials.googleapis.com"
                    else "mutation",
                },
            )
            kwargs["headers"] = {
                **kwargs.get("headers", {}),
                "User-Agent": "hussh-legacy-removal/" + plan["attemptId"] + "/" + request_id,
            }
        if not readonly and self.dispatch_guard is not None:
            self.dispatch_guard()
        response = super().request(method, url, **kwargs)
        if request_id is not None:
            # Only an authenticated response from our fixed endpoint is an ACK.
            operation = None
            if response.content:
                try:
                    name = response.json().get("name")
                    if isinstance(name, str) and "/operations/" in name:
                        operation = name
                except (ValueError, AttributeError):
                    pass  # Empty/non-JSON responses still have an exact status/body digest.
            self.journal.append(
                resource_key(self.resource),
                "provider_ack",
                {
                    "identitySha256": identity,
                    "requestId": request_id,
                    "targetSha256": target,
                    "httpStatus": response.status_code,
                    "bodySha256": hashlib.sha256(response.content).hexdigest(),
                    "operationName": operation,
                },
            )
            state = resource_state(self.journal.read(), resource_key(self.resource))
            if (
                method == "DELETE"
                and url == base
                and 200 <= response.status_code < 300
                and "acknowledgement" not in state
            ):
                self.journal.append(
                    resource_key(self.resource),
                    "acknowledgement",
                    {
                        "identitySha256": identity,
                        "requestId": state["intent"]["requestId"],
                        "httpStatus": response.status_code,
                        "operationName": operation,
                    },
                )
        return response


def resource_url(project: str, region: str, resource: dict) -> str:
    """Fixed provider hosts; a retained label never becomes an arbitrary URL."""
    kind, name = resource["type"], resource["id"]
    escaped = quote(name, safe="")
    if kind == "cloud_run_service":
        return f"https://run.googleapis.com/v2/projects/{project}/locations/{region}/services/{escaped}"
    if kind == "service_account":
        account = resource.get("identity", {}).get("uniqueId") or name
        return f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{quote(account, safe='')}"
    if kind == "bootstrap_access":
        account = resource.get("identity", {}).get("account", {}).get("uniqueId") or name
        return f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{quote(account, safe='')}"
    if kind == "gcs_bucket":
        return f"https://storage.googleapis.com/storage/v1/b/{escaped}"
    if kind == "kms_key":
        return f"https://cloudkms.googleapis.com/v1/projects/{project}/locations/{region}/keyRings/hushh-one/cryptoKeys/{escaped}"
    if kind == "secret":
        return f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{escaped}"
    if kind == "artifact_repository":
        return f"https://artifactregistry.googleapis.com/v1/projects/{project}/locations/{region}/repositories/{escaped}"
    if kind in {"pubsub_topic", "pubsub_subscription"}:
        collection = "topics" if kind == "pubsub_topic" else "subscriptions"
        full = name if name.startswith("projects/") else f"projects/{project}/{collection}/{name}"
        _require(
            re.fullmatch(rf"projects/[a-z0-9-]+/{collection}/[A-Za-z0-9_.~-]+", full) is not None
        )
        return "https://pubsub.googleapis.com/v1/" + full
    if kind == "cloud_scheduler_job":
        return f"https://cloudscheduler.googleapis.com/v1/projects/{project}/locations/{region}/jobs/{escaped}"
    if kind == "cloud_tasks_queue":
        return f"https://cloudtasks.googleapis.com/v2/projects/{project}/locations/{region}/queues/{escaped}"
    if kind == "reasoning_engine":
        _require(
            re.fullmatch(
                rf"projects/{re.escape(project)}/locations/[a-z0-9-]+/reasoningEngines/[A-Za-z0-9_-]+",
                name,
            )
            is not None
        )
        location = name.split("/")[3]
        return f"https://{location}-aiplatform.googleapis.com/v1beta1/{name}"
    if kind == "project_iam_policy":
        _require(name == project)
        return f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}"
    raise ValueError("Unsupported retained resource")


def native_identity(kind: str, body: dict) -> dict:
    """Only public lifecycle metadata crosses the observation boundary."""
    fields = {
        "cloud_run_service": ("name", "uid", "createTime"),
        "service_account": ("name", "uniqueId", "email", "projectId"),
        "gcs_bucket": ("name", "generation", "projectNumber", "timeCreated"),
        "kms_key": ("name", "purpose", "createTime"),
        "secret": ("name", "createTime"),
        "artifact_repository": ("name", "createTime"),
        "pubsub_topic": ("name", "kmsKeyName", "messageStoragePolicy"),
        "pubsub_subscription": ("name", "topic"),
        "cloud_scheduler_job": ("name", "schedule", "timeZone"),
        "cloud_tasks_queue": ("name", "purgeTime"),
        "reasoning_engine": ("name", "createTime"),
    }[kind]
    return {key: body[key] for key in fields if key in body}


def observe_plan(
    session: RecoverySession,
    *,
    reservation: dict,
    inventory: dict,
    snapshot_hash: str,
    source_revision: str,
    actor: str,
) -> dict:
    row = reservation["registrySnapshot"]
    project, region = row["user_cloud_project"], row["user_cloud_region"]
    _require(project not in PROTECTED_PROJECTS)
    p = session.get(f"https://cloudresourcemanager.googleapis.com/v3/projects/{project}")
    _require(p.status_code == 200)
    project_body = p.json()
    _require(project_body.get("projectId") == project and project_body.get("state") == "ACTIVE")
    service = {"type": "cloud_run_service", "id": row["external_agent_id"]}
    response = session.get(resource_url(project, region, service))
    _require(response.status_code == 200)
    runtime = response.json()
    metadata = row["backend_metadata"]
    _require(runtime.get("uid") == metadata["serviceUid"] and runtime.get("latestReadyRevision"))
    containers = runtime["template"]["containers"]
    _require(len(containers) == 1 and containers[0]["image"] == metadata["image"])
    env = {entry["name"]: entry.get("value") for entry in containers[0].get("env", [])}
    _require(
        env.get("HUSHH_DEPLOY_ENV") == "dev"
        and runtime.get("labels", {}).get("hussh-env") == "dev"
        and env.get("ENVIRONMENT", "dev") == "dev",
        "CLOUD_REMOVAL_PROTECTED_RESOURCE",
    )
    bucket = env.get("POD_STORAGE_GCS_BUCKET")
    _require(
        isinstance(bucket, str)
        and any(
            item["type"] == "gcs_bucket" and item["id"] == bucket
            for item in inventory["plannedResources"]
        )
    )
    prefix = env.get("POD_STORAGE_GCS_PREFIX", "").strip("/")
    object_name = "/".join(filter(None, (prefix, "memory_bank.json")))
    object_url = f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}/o/{quote(object_name, safe='')}"
    info = session.get(object_url)
    _require(info.status_code == 200)
    generation = info.json()["generation"]
    raw = session.get(
        object_url,
        params={"alt": "media", "generation": generation, "ifGenerationMatch": generation},
    )
    _require(raw.status_code == 200 and len(raw.content) <= 65536)
    record = raw.json()
    _require(
        record.get("project") == project
        and record.get("displayName") == "one-pod-memory-" + row["hushh_id"]
    )
    _require(record.get("erasure", {}).get("attemptId") == reservation["attemptId"])
    _require(
        re.fullmatch(r"[a-z0-9-]+", str(record.get("location"))) is not None
        and re.fullmatch(r"[0-9]+", str(record.get("engineId"))) is not None
    )
    engine_name = (
        f"projects/{project}/locations/{record['location']}/reasoningEngines/{record['engineId']}"
    )
    resources = []
    for original in [
        *inventory["plannedResources"],
        {"type": "reasoning_engine", "id": engine_name},
    ]:
        value = session.get(resource_url(project, region, original))
        _require(value.status_code in {200, 404}, "CLOUD_REMOVAL_NATIVE_READ_UNAVAILABLE")
        identity = (
            native_identity(original["type"], value.json())
            if value.status_code == 200
            else {"name": original["id"], "initiallyAbsent": True}
        )
        authority = (
            "retain_shared" if original["type"] == "artifact_repository" else "owner_reviewed"
        )
        if original["id"].startswith("projects/") and original["id"].split("/")[1] != project:
            _require(value.status_code == 404, "CLOUD_REMOVAL_PROTECTED_RESOURCE")
            authority = "observe_only"
        _require(
            not any(
                item["type"] == original["type"] and item["id"] == original["id"]
                for item in resources
            )
        )
        if original["type"] == "gcs_bucket" and value.status_code == 200:
            _require(identity.get("projectNumber") == project_body["name"].split("/")[-1])
        resources.append(
            {
                "type": original["type"],
                "id": original["id"],
                "identity": identity,
                "authority": authority,
            }
        )
    project_policy = session.post(
        f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:getIamPolicy",
        json={"options": {"requestedPolicyVersion": 3}},
    )
    _require(project_policy.status_code == 200)
    accounts = {
        "serviceAccount:" + item["id"] for item in resources if item["type"] == "service_account"
    }
    added = {
        (item["role"], item["member"])
        for item in metadata["substrateReceipt"].get("bindingObservations", [])
        if item.get("disposition") == "added"
        and item.get("policyResource")
        == f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:getIamPolicy"
    }
    bindings = [
        {
            "role": binding["role"],
            "member": member,
            **({"condition": binding["condition"]} if "condition" in binding else {}),
        }
        for binding in project_policy.json().get("bindings", [])
        for member in binding.get("members", [])
        if member in accounts or (binding["role"], member) in added and "condition" not in binding
    ]
    resources.append(
        {
            "type": "project_iam_policy",
            "id": project,
            "authority": "owner_reviewed",
            "identity": {"bindings": bindings},
        }
    )
    resources.append(
        observe_bootstrap_access(
            session, project=project, region=region, bootstrap=row["user_cloud_bootstrap_sa"]
        )
    )
    engine = next(item for item in resources if item["type"] == "reasoning_engine")
    _require(
        bool(engine["identity"].get("createTime")), "CLOUD_REMOVAL_ENGINE_IDENTITY_UNAVAILABLE"
    )
    principal = next(
        item["identity"]
        for item in resources
        if item["type"] == "service_account" and item["id"] == metadata["runtime_service_account"]
    )
    return {
        "version": 1,
        "controlProject": "hushh-pda-dev",
        "ownerId": reservation["ownerId"],
        "accountGeneration": 0,
        "attemptId": reservation["attemptId"],
        "placementEpoch": row.get("placement_epoch", 0),
        "snapshotSha256": snapshot_hash,
        "project": {
            "projectId": project,
            "projectNumber": project_body["name"].split("/")[-1],
            "createTime": project_body["createTime"],
        },
        "runtime": {
            "serviceName": runtime["name"],
            "serviceUid": runtime["uid"],
            "revision": runtime["latestReadyRevision"].split("/")[-1],
            "image": containers[0]["image"],
            "generation": int(runtime["generation"]),
            "etag": runtime["etag"],
            "principal": principal,
        },
        "memory": {
            "bucket": bucket,
            "object": object_name,
            "generation": generation,
            "sha256": hashlib.sha256(raw.content).hexdigest(),
            "engineName": engine_name,
            "engineCreateTime": engine["identity"]["createTime"],
        },
        "resources": resources,
        "sourceRevision": source_revision,
        "actor": actor,
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "termsVersion": "gcp-legacy-native-removal-v1",
    }


def observe_bootstrap_access(session, *, project: str, region: str, bootstrap: str) -> dict:
    resource = {"type": "bootstrap_access", "id": bootstrap}
    base = resource_url(project, region, resource)
    account = session.get(base)
    _require(account.status_code == 200, "CLOUD_REMOVAL_BOOTSTRAP_IDENTITY_UNAVAILABLE")
    policy = session.post(base + ":getIamPolicy", params={"options.requestedPolicyVersion": 3})
    _require(policy.status_code == 200)
    member = "serviceAccount:consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com"
    bindings = [
        {
            "role": item["role"],
            "member": member,
            **({"condition": item["condition"]} if "condition" in item else {}),
        }
        for item in policy.json().get("bindings", [])
        if member in item.get("members", [])
    ]
    _require(all(item["role"] == "roles/iam.serviceAccountTokenCreator" for item in bindings))
    return {
        **resource,
        "authority": "owner_reviewed",
        "identity": {
            "account": native_identity("service_account", account.json()),
            "bindings": bindings,
        },
    }


def verify_retired_plan(session: RecoverySession, *, reservation: dict, recovery: dict) -> None:
    """Fresh incarnation checks after compute is gone; never invent a new plan."""
    from hushh_mcp.services.legacy_cloud_removal import resource_key, resource_state, validate_plan

    plan = recovery["plan"]
    validate_plan(reservation, plan)
    project = plan["project"]["projectId"]
    _require(project not in PROTECTED_PROJECTS)
    observed = session.get(f"https://cloudresourcemanager.googleapis.com/v3/projects/{project}")
    _require(observed.status_code == 200)
    body = observed.json()
    _require(
        body.get("state") == "ACTIVE"
        and body.get("projectId") == project
        and body.get("name") == "projects/" + plan["project"]["projectNumber"]
        and body.get("createTime") == plan["project"]["createTime"],
        "CLOUD_REMOVAL_PLACEMENT_CHANGED",
    )
    region = plan["runtime"]["serviceName"].split("/")[3]
    for resource in plan["resources"]:
        kind = resource["type"]
        state = resource_state(recovery, resource_key(resource))
        if kind == "project_iam_policy":
            continue  # Existing etag merge and exclusivity checks own IAM writes.
        if kind == "bootstrap_access":
            current = observe_bootstrap_access(
                session, project=project, region=region, bootstrap=resource["id"]
            )
            terminal = state.get("observation", {}).get("status") in {"deleted", "observed_absent"}
            _require(
                current["identity"]["account"] == resource["identity"]["account"]
                and (not current["identity"]["bindings"] if terminal else current == resource),
                "CLOUD_REMOVAL_BOOTSTRAP_IDENTITY_UNAVAILABLE",
            )
            continue
        response = session.get(resource_url(project, region, resource))
        _require(response.status_code in {200, 404}, "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN")
        terminal = state.get("observation", {}).get("status") in {"deleted", "observed_absent"}
        if terminal and kind == "kms_key" and response.status_code == 200:
            _require(
                native_identity(kind, response.json()) == resource["identity"],
                "CLOUD_REMOVAL_PLACEMENT_CHANGED",
            )
            token, seen, versions = "", set(), []
            for _ in range(128):
                observed = session.get(
                    resource_url(project, region, resource) + "/cryptoKeyVersions",
                    params={"pageSize": 1000, **({"pageToken": token} if token else {})},
                )
                _require(observed.status_code == 200)
                payload = observed.json()
                _require(
                    not payload.get("error")
                    and not payload.get("unreachable")
                    and isinstance(payload.get("cryptoKeyVersions", []), list)
                )
                versions.extend(payload.get("cryptoKeyVersions", []))
                token = payload.get("nextPageToken", "")
                _require(isinstance(token, str) and token not in seen)
                if not token:
                    break
                seen.add(token)
            _require(
                not token
                and bool(versions)
                and all(v.get("state") == "DESTROYED" for v in versions),
                "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN",
            )
        elif terminal:
            _require(response.status_code == 404, "CLOUD_REMOVAL_PLACEMENT_CHANGED")
        elif response.status_code == 200:
            _require(
                kind != "service_account"
                or resource["id"] != plan["runtime"]["principal"]["email"]
                or response.json().get("disabled") is True,
                "CLOUD_REMOVAL_WRITER_NOT_FENCED",
            )
            _require(
                native_identity(kind, response.json()) == resource["identity"],
                "CLOUD_REMOVAL_PLACEMENT_CHANGED",
            )
        else:
            _require(
                kind not in {"cloud_run_service", "reasoning_engine"}
                and ("intent" not in state or "acknowledgement" in state),
                "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN",
            )
