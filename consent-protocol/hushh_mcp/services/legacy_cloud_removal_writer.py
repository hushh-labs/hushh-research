"""Revoke the exact legacy writer and reconcile a temporary probe grant."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

from hushh_mcp.services.legacy_cloud_removal import _require, resource_key, sha256
from hushh_mcp.services.legacy_cloud_removal_native import native_identity, resource_url


def cached_writer_probe(worker, *, actor: str) -> str:
    """Mint one probe token with a temporary, etag-preserving SA-only grant.

    The temporary grant is removed before writer revocation. It grants no
    project role, creates no key, and never crosses this approved SA identity.
    """
    from copy import deepcopy

    resource = worker._resource("service_account", worker.plan["runtime"]["principal"]["email"])
    worker.session.resource = resource
    worker._intent(resource, writer=True)
    base = resource_url(worker.project, worker.region, resource)
    policy_url = base + ":getIamPolicy"
    checkpoints = worker._checkpoints(resource)
    grant = checkpoints.get("temporaryGrant")
    updated = None
    if grant is None or checkpoints.get("temporaryGrantRemoved", {}).get("grantSha256") == sha256(
        grant
    ):
        policy = worker.session.post(policy_url, params={"options.requestedPolicyVersion": 3})
        _require(policy.status_code == 200 and bool(policy.json().get("etag")))
        expiration = (datetime.now(timezone.utc) + timedelta(minutes=20)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        grant = {
            "role": "roles/iam.serviceAccountTokenCreator",
            "member": "user:" + actor,
            "condition": {
                "title": "hussh-delete-" + worker.plan["attemptId"],
                "description": "Temporary removal credential probe",
                "expression": f'request.time < timestamp("{expiration}")',
            },
            "beforeEtag": policy.json()["etag"],
        }
        worker._checkpoint(resource, "temporaryGrant", grant)
        updated = deepcopy(policy.json())
        updated["version"] = 3
        updated.setdefault("bindings", []).append(
            {"role": grant["role"], "members": [grant["member"]], "condition": grant["condition"]}
        )
    try:
        if updated is not None:
            result = worker.session.post(base + ":setIamPolicy", json={"policy": updated})
            _require(result.status_code == 200)
        result = worker.session.post(
            "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"
            + quote(resource["identity"]["uniqueId"], safe="")
            + ":generateAccessToken",
            json={"scope": ["https://www.googleapis.com/auth/cloud-platform"], "lifetime": "1200s"},
        )
        _require(result.status_code == 200, "CLOUD_REMOVAL_WRITER_PROBE_UNAVAILABLE")
        token = result.json()["accessToken"]
    finally:
        remove_probe_grant(worker, resource, grant)
    with requests.Session() as probe:
        result = probe.get(
            resource_url(worker.project, worker.region, worker._resource("gcs_bucket")),
            headers={"Authorization": "Bearer " + token},
            timeout=30,
            allow_redirects=False,
        )
    _require(result.status_code == 200, "CLOUD_REMOVAL_WRITER_PROBE_UNAVAILABLE")
    return token


def remove_probe_grant(worker, resource: dict, grant: dict) -> None:
    from copy import deepcopy

    base = resource_url(worker.project, worker.region, resource)
    policy_url = base + ":getIamPolicy"
    # Re-read rather than replaying the captured policy: concurrent grants
    # survive. A lost PUT acknowledgement is reconciled by this readback.
    policy = worker.session.post(policy_url, params={"options.requestedPolicyVersion": 3})
    _require(policy.status_code == 200 and bool(policy.json().get("etag")))
    updated = deepcopy(policy.json())
    for binding in updated.get("bindings", []):
        if binding.get("role") == grant["role"] and binding.get("condition") == grant["condition"]:
            binding["members"] = [
                member for member in binding.get("members", []) if member != grant["member"]
            ]
    updated["bindings"] = [
        binding for binding in updated.get("bindings", []) if binding.get("members")
    ]
    if updated != policy.json():
        removed = worker.session.post(base + ":setIamPolicy", json={"policy": updated})
        _require(removed.status_code == 200, "CLOUD_REMOVAL_TEMPORARY_GRANT_PENDING")
    observed = worker.session.post(policy_url, params={"options.requestedPolicyVersion": 3})
    _require(
        observed.status_code == 200
        and not any(
            (binding.get("condition") or {}).get("title") == grant["condition"]["title"]
            and grant["member"] in binding.get("members", [])
            for binding in observed.json().get("bindings", [])
        ),
        "CLOUD_REMOVAL_TEMPORARY_GRANT_PENDING",
    )
    worker._checkpoint(
        resource,
        "temporaryGrantRemoved",
        {
            "grantSha256": sha256(grant),
            "nativeReadbackSha256": hashlib.sha256(observed.content).hexdigest(),
        },
    )


def disable_writer(worker, *, cached_token: str) -> None:
    resource = worker._resource("service_account", worker.plan["runtime"]["principal"]["email"])
    worker.session.resource = resource
    url = resource_url(worker.project, worker.region, resource)
    before = worker.session.get(url)
    _require(
        before.status_code == 200
        and native_identity("service_account", before.json()) == resource["identity"]
    )
    state = worker._intent(resource, writer=True)
    if not before.json().get("disabled", False):
        response = worker.session.post(url + ":disable", json={})
        _require(response.status_code == 200)
        worker.journal.append(
            resource_key(resource),
            "writer_acknowledgement",
            {
                "identitySha256": worker.journal.identity_sha256(resource),
                "requestId": state["writer_intent"]["requestId"],
                "httpStatus": 200,
                "operationName": None,
            },
        )
    observed = worker.session.get(url)
    _require(observed.status_code == 200 and observed.json().get("disabled") is True)
    # Probe an existing token against a resource it demonstrably accessed before
    # revocation. A newly minted-token refusal would not establish revocation.
    with requests.Session() as probe:
        response = probe.get(
            resource_url(worker.project, worker.region, worker._resource("gcs_bucket")),
            headers={"Authorization": "Bearer " + cached_token},
            timeout=30,
            allow_redirects=False,
        )
    _require(response.status_code in {401, 403}, "CLOUD_REMOVAL_WRITER_REVOCATION_PENDING")
    worker.journal.append(
        resource_key(resource),
        "writer_disabled",
        {
            "identitySha256": worker.journal.identity_sha256(resource),
            "status": "disabled",
            "nativeReadbackSha256": hashlib.sha256(observed.content).hexdigest(),
            "credentialDenied": True,
        },
    )
