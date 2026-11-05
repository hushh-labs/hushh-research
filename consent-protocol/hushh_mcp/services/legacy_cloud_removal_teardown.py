"""Resume native cleanup through the existing bucket and KMS adapters."""

from __future__ import annotations

from hushh_mcp.services.legacy_cloud_removal import _require, resource_key, resource_state, sha256
from hushh_mcp.services.legacy_cloud_removal_native import native_identity, resource_url


def remove_project_bindings(worker, resource: dict) -> None:
    from copy import deepcopy

    base = resource_url(worker.project, worker.region, resource)
    options = (
        {"params": {"options.requestedPolicyVersion": 3}}
        if resource["type"] == "bootstrap_access"
        else {"json": {"options": {"requestedPolicyVersion": 3}}}
    )
    response = worker.session.post(base + ":getIamPolicy", **options)
    _require(response.status_code == 200)
    policy = response.json()
    targets = resource["identity"]["bindings"]
    updated = deepcopy(policy)
    for binding in updated.get("bindings", []):
        binding["members"] = [
            member
            for member in binding.get("members", [])
            if not any(
                target["role"] == binding["role"]
                and target["member"] == member
                and target.get("condition") == binding.get("condition")
                for target in targets
            )
        ]
    updated["bindings"] = [binding for binding in updated.get("bindings", []) if binding["members"]]
    worker._intent(resource)
    if updated != policy:
        _require(bool(policy.get("etag")))
        response = worker.session.post(base + ":setIamPolicy", json={"policy": updated})
        _require(response.status_code == 200)
    final = worker.session.post(base + ":getIamPolicy", **options)
    _require(final.status_code == 200)
    _require(
        not any(
            target["member"] in binding.get("members", [])
            and target["role"] == binding["role"]
            and target.get("condition") == binding.get("condition")
            for target in targets
            for binding in final.json().get("bindings", [])
        )
    )
    worker._observe(resource, final, "deleted", coverage={"bindingsAbsent": True})


def observe_retention(worker, resource: dict) -> dict:
    """A denied/invalid cleanup is not evidence of provider retention."""
    url = resource_url(worker.project, worker.region, resource)
    if resource["type"] == "gcs_bucket":
        retained = worker.session.get(
            url, params={"softDeleted": True, "generation": resource["identity"]["generation"]}
        )
        _require(retained.status_code in {200, 404}, "CLOUD_REMOVAL_NATIVE_READ_UNAVAILABLE")
        if retained.status_code == 200:
            _require(
                native_identity("gcs_bucket", retained.json()) == resource["identity"],
                "CLOUD_REMOVAL_RESOURCE_REPLACED",
            )
            return {
                "providerRetention": True,
                "observedGenerations": 1,
                "inventoryComplete": True,
                "nextEligibleAt": retained.json().get("hardDeleteTime"),
            }
        response = worker.session.get(
            url + "/o",
            params={
                "softDeleted": True,
                "maxResults": 1000,
                "fields": "items(generation,hardDeleteTime),nextPageToken",
            },
        )
        _require(response.status_code == 200, "CLOUD_REMOVAL_NATIVE_READ_UNAVAILABLE")
        body = response.json()
        items = body.get("items", [])
        _require(
            isinstance(items, list)
            and bool(items)
            and all(item.get("generation") and item.get("hardDeleteTime") for item in items),
            "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN",
        )
        return {
            "providerRetention": True,
            "observedGenerations": len(items),
            "inventoryComplete": not bool(body.get("nextPageToken")),
            "nextEligibleAt": max(item["hardDeleteTime"] for item in items)
            if not body.get("nextPageToken")
            else None,
        }
    _require(resource["type"] == "kms_key")
    items = worker._pages(url + "/cryptoKeyVersions", "cryptoKeyVersions")
    _require(
        items and all(item.get("state") in {"DESTROYED", "DESTROY_SCHEDULED"} for item in items),
        "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN",
    )
    scheduled = [item for item in items if item["state"] == "DESTROY_SCHEDULED"]
    _require(
        scheduled and all(item.get("destroyTime") for item in scheduled),
        "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN",
    )
    return {
        "providerRetention": True,
        "observedGenerations": len(scheduled),
        "inventoryComplete": True,
        "nextEligibleAt": max(item["destroyTime"] for item in scheduled),
    }


def recover_bucket_acknowledgement(worker, resource: dict) -> None:
    """Recover only a retained authenticated response to the exact bucket DELETE."""
    checkpoints = worker._checkpoints(resource)
    admission = checkpoints.get("bucketAdmission")
    state = resource_state(worker.journal.read(), resource_key(resource))
    if admission is None or (
        checkpoints.get("bucketAcknowledgement") is not None and "acknowledgement" in state
    ):
        return
    target = sha256(
        {
            "method": "DELETE",
            "url": resource_url(worker.project, worker.region, resource),
            "params": {"ifMetagenerationMatch": admission["metageneration"]},
            "json": None,
        }
    )
    events = [
        event
        for event in worker.journal.read()["events"]
        if event["resource"] == resource_key(resource)
    ]
    requests = {
        event["receipt"]["requestId"]
        for event in events
        if event["stage"] == "provider_dispatch" and event["receipt"].get("targetSha256") == target
    }
    acknowledgement = next(
        (
            event["receipt"]
            for event in events
            if event["stage"] == "provider_ack"
            and event["receipt"].get("requestId") in requests
            and event["receipt"].get("targetSha256") == target
            and event["receipt"].get("httpStatus") in {200, 204}
        ),
        None,
    )
    _require(
        acknowledgement is not None and acknowledgement.get("operationName") is None,
        "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN",
    )
    if "acknowledgement" not in state:
        worker.journal.append(
            resource_key(resource),
            "acknowledgement",
            {
                "identitySha256": worker.journal.identity_sha256(resource),
                "requestId": state["intent"]["requestId"],
                "httpStatus": acknowledgement["httpStatus"],
                "operationName": None,
            },
        )
    if checkpoints.get("bucketAcknowledgement") is None:
        worker._checkpoint(
            resource, "bucketAcknowledgement", {**admission, "status": "acknowledged"}
        )


def delete_remaining(worker, *, token: str, reservation: dict) -> list[str]:
    import asyncio

    from hushh_mcp.services.byoc_substrate_teardown import (
        SubstrateDeleteError,
        build_gcp_deleter,
    )

    original = reservation["registrySnapshot"]["backend_metadata"]["substrateReceipt"]
    observed = {
        (item["type"], item["id"]): item for item in original.get("resourceObservations", [])
    }
    pending = []
    # Keep independent cleanup progressing while retaining IAM, secrets and
    # runtime identities whenever protected storage or KMS remains pending.
    priority = {
        "cloud_scheduler_job": 0,
        "cloud_tasks_queue": 1,
        "pubsub_subscription": 2,
        "pubsub_topic": 3,
        "artifact_repository": 4,
        "gcs_bucket": 5,
        "kms_key": 6,
        "secret": 7,
        "project_iam_policy": 8,
        "service_account": 9,
        "bootstrap_access": 10,
    }
    for resource in sorted(
        worker.plan["resources"], key=lambda item: priority.get(item["type"], -1)
    ):
        kind = resource["type"]
        if kind in {"cloud_run_service", "reasoning_engine"}:
            continue
        worker.session.resource = resource
        state = resource_state(worker.journal.read(), resource_key(resource))
        if state.get("observation", {}).get("status") in {
            "deleted",
            "observed_absent",
            "retained_shared",
        }:
            continue
        if pending and kind in {
            "kms_key",
            "secret",
            "project_iam_policy",
            "service_account",
            "bootstrap_access",
        }:
            continue
        if kind in {"project_iam_policy", "bootstrap_access"}:
            remove_project_bindings(worker, resource)
            continue
        url = resource_url(worker.project, worker.region, resource)
        current = worker.session.get(url)
        _require(current.status_code in {200, 404})
        if resource["authority"] == "observe_only":
            _require(current.status_code == 404 and "intent" not in state)
            worker._observe(resource, current, "observed_absent")
            continue
        if resource["authority"] == "retain_shared":
            _require(current.status_code == 200)
            worker._observe(resource, current, "retained_shared")
            continue
        if current.status_code == 404 and kind != "gcs_bucket":
            if "intent" not in state:
                worker._observe(resource, current, "observed_absent")
            else:
                _require("acknowledgement" in state, "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN")
                worker._observe(resource, current, "deleted")
            continue
        _require(
            current.status_code == 404
            and kind == "gcs_bucket"
            or native_identity(kind, current.json()) == resource["identity"],
            "CLOUD_REMOVAL_RESOURCE_REPLACED",
        )
        worker._intent(resource)
        try:
            if kind in {"gcs_bucket", "kms_key"}:
                proof = observed.get((kind, resource["id"]))
                _require(
                    proof is not None and proof["identity"] == resource["identity"],
                    "CLOUD_REMOVAL_CREATION_EVIDENCE_REQUIRED",
                )
                if kind == "gcs_bucket":
                    recover_bucket_acknowledgement(worker, resource)
                kwargs = {
                    "bucket_erasure_state"
                    if kind == "gcs_bucket"
                    else "kms_erasure_state": worker._checkpoints(resource),
                    "retain_bucket_receipt"
                    if kind == "gcs_bucket"
                    else "retain_kms_receipt": lambda stage, value, resource=resource: (
                        worker._checkpoint(resource, stage, value)
                    ),
                }
                deleter = build_gcp_deleter(
                    token=token,
                    project=worker.project,
                    region=worker.region,
                    session=worker.session,
                    **kwargs,
                )
                asyncio.run(
                    deleter({"type": kind, "id": resource["id"], "resourceObservation": proof})
                )
                final = worker.session.get(url)
                worker._observe(
                    resource,
                    final,
                    "deleted",
                    coverage={"allVersionsDestroyed": True} if kind == "kms_key" else {},
                )
            else:
                params = {"etag": current.json()["etag"]} if kind == "secret" else None
                response = worker.session.delete(url, params=params)
                _require(200 <= response.status_code < 300)
                final = worker.session.get(url)
                _require(final.status_code == 404)
                worker._observe(resource, final, "deleted")
        except SubstrateDeleteError:
            # The existing adapters retain the exact protected generations and
            # scheduled KMS versions. No timer or accepted DELETE completes them.
            worker._observe(
                resource,
                current,
                "waiting_for_provider",
                coverage=observe_retention(worker, resource),
            )
            pending.append(resource_key(resource))
    return pending
