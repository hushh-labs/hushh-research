"""Read proposed private S backend pairing evidence; never authorize deployment.

The hosted caller must authenticate this source, bind the pair to its attempt,
independently verify effective and inherited IAM and re-probe private health,
then recheck under the shared durable fence. This module makes no provider writes
and does not enable the fixture preload.
"""

from __future__ import annotations

import copy
import json
import re

import qualification_acceptance as acceptance
import qualification_candidate as candidate
import qualification_image as images
import qualification_iam
import qualification_acceptance_contract as acceptance_contract
import validation
from qualification_target import PREFIX, RUNTIME_SECRETS, SOURCE, Target, require


def inspect(
    environment,
    run_id,
    *,
    github=None,
    cloud=None,
    id_token=None,
    iam_cloud=None,
    http=None,
):
    """Re-read exact hosted S receipt and private service; return no authority."""
    target = Target(environment)
    client = github or validation.transport.GitHub()
    require(
        isinstance(getattr(client, "cache", None), dict),
        "frontend_pair_github_cache_unavailable",
    )
    client.cache.clear()
    admitted, proof, health, tag, revision_name, versions = _receipt(
        client, target, environment, run_id
    )
    cloud = cloud or images.Cloud()
    service, revision, service_url, candidate_url, service_uid, revision_uid = _native(
        cloud, target, admitted, proof, health, tag, revision_name, versions, run_id
    )
    observed_iam = _health(
        target, id_token, iam_cloud, http, service_url, candidate_url, versions
    )
    before = copy.deepcopy((service, revision))
    candidate.private_service(cloud, target, service)
    client.cache.clear()
    require(
        candidate.read(cloud, target, "services", candidate.SERVICE) == before[0]
        and candidate.read(cloud, target, "revisions", revision_name) == before[1]
        and acceptance.verify(environment, run_id, github=client) == admitted,
        "frontend_pair_backend_changed",
    )
    return {
        "kind": "proposed-private-plg-backend-pair-v1",
        "environment": environment,
        "project": target.project,
        "sourceSha": SOURCE,
        "acceptance": admitted.pin(),
        "serviceUid": service_uid,
        "revision": revision_name,
        "revisionUid": revision_uid,
        "serviceUrl": service_url,
        "candidateUrl": candidate_url,
        "freshHealthProbeAttempted": id_token is not None,
        "freshAllowPolicyReadAttempted": observed_iam is not None,
        "freshTargetVerified": False,
        "uidContinuityVerified": False,
        "healthRechecked": False,
        "inheritedIAMVerified": False,
        "providerVerified": False,
        "durableFenceVerified": False,
        "frontendPairAccepted": False,
        "productionTrafficAuthorized": False,
    }


def _receipt(client, target, environment, run_id):
    admitted = acceptance.verify(environment, run_id, github=client)
    require(
        type(admitted) is acceptance.IsolatedAcceptance,
        "frontend_pair_backend_acceptance_invalid",
    )
    run = client.read(f"runs/{run_id}")
    require(
        run.get("id") == admitted.run_id
        and run.get("run_attempt") == admitted.run_attempt
        and run.get("head_sha") == admitted.workflow_sha
        and run.get("status") == "completed"
        and run.get("conclusion") == "success",
        "frontend_pair_backend_run_changed",
    )
    artifact, receipt = acceptance._artifact(client, run, environment)
    require(
        artifact.get("id") == admitted.artifact_id
        and artifact.get("digest") == admitted.artifact_digest
        and isinstance(receipt, dict)
        and isinstance(receipt.get("candidate"), dict)
        and isinstance(receipt.get("health"), dict),
        "frontend_pair_backend_artifact_changed",
    )
    proof, health = receipt["candidate"], receipt["health"]
    attempt = images.Attempt(
        admitted.workflow_sha, str(admitted.run_id), str(admitted.run_attempt)
    )
    tag, revision_name = candidate.identity(target, attempt)
    versions = proof.get("runtimeSecretVersions")
    require(
        isinstance(versions, dict)
        and set(versions) == {PREFIX + name for name in RUNTIME_SECRETS}
        and all(
            isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value)
            for value in versions.values()
        )
        and proof.get("revision") == revision_name
        and health.get("revision") == revision_name
        and health.get("imageReference") == admitted.image_reference,
        "frontend_pair_backend_receipt_invalid",
    )
    return admitted, proof, health, tag, revision_name, versions


def _health(target, id_token, iam_cloud, http, service_url, candidate_url, versions):
    observed_iam = None
    if id_token is not None:
        require(
            isinstance(id_token, str) and bool(id_token),
            "frontend_pair_health_token_invalid",
        )
        observed_iam = qualification_iam.verify(target, cloud=iam_cloud)
        require(
            acceptance_contract.iam(observed_iam, target) == versions,
            "frontend_pair_backend_iam_changed",
        )
        candidate.token_audience(id_token, service_url)
        probe = http or candidate.Http()
        endpoint = candidate_url + "/health"
        require(probe.get(endpoint)[0] in {401, 403}, "frontend_pair_backend_public")
        for _ in range(2):
            status, body = probe.get(endpoint, id_token)
            try:
                health_body = (
                    json.loads(body)
                    if isinstance(body, bytes) and len(body) <= 65536
                    else None
                )
            except (ValueError, UnicodeError):
                health_body = None
            require(
                status == 200
                and isinstance(health_body, dict)
                and health_body.get("status") == "healthy",
                "frontend_pair_backend_health_failed",
            )
        after_iam = qualification_iam.verify(target, cloud=iam_cloud)
        # Compare summaries only. These do not prove raw IAM policies stayed
        # identical; that requires independently authenticated policy digests
        # and a shared fence before this proposal can authorize anything.
        require(
            {key: value for key, value in observed_iam.items() if key != "observedAt"}
            == {key: value for key, value in after_iam.items() if key != "observedAt"},
            "frontend_pair_backend_iam_summary_changed",
        )
    return observed_iam


def _native(
    cloud, target, admitted, proof, health, tag, revision_name, versions, run_id
):
    service = candidate.read(cloud, target, "services", candidate.SERVICE)
    candidate.private_service(cloud, target, service)
    revision = candidate.read(cloud, target, "revisions", revision_name)
    service_url, candidate_url = candidate.urls(service, tag, revision_name)
    require(
        service_url == proof.get("serviceUrl") == health.get("audience")
        and candidate_url == health.get("candidateUrl")
        and candidate.traffic(service) == proof.get("actualTraffic"),
        "frontend_pair_backend_routing_changed",
    )
    version_map = {name: versions[PREFIX + name] for name in RUNTIME_SECRETS}
    document = target.service_document(
        admitted.image_reference, version_map, str(run_id)
    )
    candidate.runtime(revision, document, revision_name)
    descriptor = {
        "revision": revision_name,
        "tag": tag,
        "runId": str(run_id),
        "imageReference": admitted.image_reference,
    }
    provenance = candidate.provenance(service, revision, target, descriptor)
    require(
        provenance == proof.get("provenance"),
        "frontend_pair_backend_provenance_changed",
    )
    service_uid = service.get("metadata", {}).get("uid")
    revision_uid = revision.get("metadata", {}).get("uid")
    require(
        all(
            isinstance(value, str) and re.fullmatch(r"[a-z0-9-]{1,128}", value)
            for value in (service_uid, revision_uid)
        ),
        "frontend_pair_backend_uid_invalid",
    )
    return service, revision, service_url, candidate_url, service_uid, revision_uid
