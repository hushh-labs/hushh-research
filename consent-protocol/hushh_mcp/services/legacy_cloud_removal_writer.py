"""Revoke the exact legacy writer and reconcile a temporary probe grant."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

from hushh_mcp.services.legacy_cloud_removal import _require, resource_key, resource_state, sha256
from hushh_mcp.services.legacy_cloud_removal_native import native_identity, resource_url


def verify_disabled_writer(worker) -> None:
    """A completed identity deletion resumes from its retained drain proofs."""
    resource = worker._resource("service_account", worker.plan["runtime"]["principal"]["email"])
    state = resource_state(worker.journal.read(), resource_key(resource))
    _require("writer_disabled" in state or "native_writer_disabled_after_compute" in state)
    current = worker.session.get(resource_url(worker.project, worker.region, resource))
    if current.status_code == 200:
        _require(
            current.json().get("disabled") is True
            and native_identity("service_account", current.json()) == resource["identity"]
        )
        return
    _require(
        current.status_code == 404
        and state.get("observation", {}).get("status") == "deleted"
        and state["observation"].get("identitySha256") == worker.journal.identity_sha256(resource)
    )
    for kind in ("cloud_run_service", "reasoning_engine"):
        compute = worker._resource(kind)
        evidence = resource_state(worker.journal.read(), resource_key(compute)).get(
            "observation", {}
        )
        _require(
            evidence.get("status") == "deleted"
            and evidence.get("operationDone") is True
            and evidence.get("identitySha256") == worker.journal.identity_sha256(compute)
            and worker.session.get(resource_url(worker.project, worker.region, compute)).status_code
            == 404
        )


def admit_disabled_writer_compute(worker) -> None:
    """An acknowledged disable plus fresh native identity admits compute only.

    This cannot stand in for cached-token denial. The database keeps Memory and
    storage fenced until compute settlement and independent bootstrap readback.
    """
    resource = worker._resource("service_account", worker.plan["runtime"]["principal"]["email"])
    state = resource_state(worker.journal.read(), resource_key(resource))
    _require(state.get("writer_acknowledgement", {}).get("httpStatus") == 200)
    current = worker.session.get(resource_url(worker.project, worker.region, resource))
    _require(
        current.status_code == 200
        and current.json().get("disabled") is True
        and native_identity("service_account", current.json()) == resource["identity"]
    )
    worker._checkpoint(
        resource,
        "disabledWriterComputeAdmission",
        {
            "runtimeIdentity": worker.plan["runtime"]["principal"],
            "status": "disabled",
            "nativeReadbackSha256": hashlib.sha256(current.content).hexdigest(),
        },
    )


def qualify_writer_after_compute(worker, *, token: str) -> None:
    """Reuse the BYOC port after terminal compute; make no token-denial claim."""
    from hushh_mcp.services.byoc_substrate_teardown import revoke_runtime_writer

    resource = worker._resource("service_account", worker.plan["runtime"]["principal"]["email"])
    compute = worker._resource("cloud_run_service")
    observation = resource_state(worker.journal.read(), resource_key(compute)).get(
        "observation", {}
    )
    _require(
        observation.get("status") == "deleted"
        and observation.get("operationDone") is True
        and observation.get("identitySha256") == worker.journal.identity_sha256(compute)
        and worker.session.get(resource_url(worker.project, worker.region, compute)).status_code
        == 404
    )
    bootstrap = worker._resource("bootstrap_access")
    receipt = revoke_runtime_writer(
        token=token,
        project=worker.project,
        bootstrap_ref=bootstrap["id"],
        identity=worker.plan["runtime"]["principal"],
        admitted=True,
        before_disable=lambda _: False,
        session=worker.session,
    )
    _require(receipt["bootstrapIdentity"] == bootstrap["identity"]["account"])
    worker.journal.append(
        resource_key(resource),
        "native_writer_disabled_after_compute",
        {
            **receipt,
            "identitySha256": worker.journal.identity_sha256(resource),
            "computeReceiptSha256": worker.journal.identity_sha256({"identity": observation}),
        },
    )


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
