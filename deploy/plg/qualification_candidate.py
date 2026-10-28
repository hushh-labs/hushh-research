"""Deploy and observe one private isolated candidate; never grant release authority.

Image and numeric secret versions come from the workflow's admitted producers.
All runtime, routing and health proof is collected live. No cloud calls on import.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import qualification_acceptance as acceptance
import qualification_acceptance_contract as acceptance_contract
import qualification_candidate_contract as checks
import qualification_image as image
from qualification_candidate_contract import (
    environment,
    expected_traffic,
    origin,
    require,
    runtime,
    traffic,
    traffic_spec,
    urls,
)
from qualification_target import PREFIX, RUNTIME_SECRETS, SERVICE, SOURCE, Target

MODULE = "deploy/plg/qualification_candidate.py"
REGION = "us-central1"
REPORT_KEYS = set(
    "service candidate_url mode project region status ok classifications expected checked_revisions failures".split()
)
PROVENANCE_LABELS = set(
    "managed-by serving.knative.dev/service deploy-env deploy-source deploy-sha github-run-id".split()
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def identity(target: Target, attempt: image.Attempt) -> tuple[str, str]:
    require(
        type(target) is Target and type(attempt) is image.Attempt,
        "context_invalid",
    )
    tag = "q" + hashlib.sha256(f"{attempt.run_id}:{attempt.run_attempt}".encode()).hexdigest()[:12]
    definitions = acceptance.reviewed_definitions(attempt.workflow_sha, target.environment)
    require(
        MODULE in definitions and "deploy/plg/qualification_candidate_contract.py" in definitions,
        "authority_unregistered",
    )
    return tag, SERVICE + "-" + tag


class Http:
    def get(self, url: str, token: str | None = None) -> tuple[int, bytes]:
        headers = {"X-Serverless-Authorization": "Bearer " + token} if token else {}
        origin(url.removesuffix("/health"))
        request = urllib.request.Request(url, headers=headers)  # noqa: S310 -- fixed native HTTPS origins only.
        try:
            response = urllib.request.build_opener(image.NoRedirect()).open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        except Exception:
            raise ValueError("health_unavailable") from None
        with response:
            raw = response.read(65537)
            require(len(raw) <= 65536, "health_oversized")
            return response.code, raw


def read(cloud, target: Target, kind: str, name: str) -> dict:
    return cloud.read(
        "run", kind, "describe", name, "--project=" + target.project, "--region=" + REGION
    )


def private_service(cloud, target: Target, service: dict) -> None:
    policy = cloud.read(
        "run",
        "services",
        "get-iam-policy",
        SERVICE,
        "--project=" + target.project,
        "--region=" + REGION,
    )
    checks.service(target, service, policy)


def existing_service(cloud, target: Target) -> dict | None:
    values = json.loads(
        cloud.command(
            "run",
            "services",
            "list",
            "--project=" + target.project,
            "--region=" + REGION,
            "--filter=metadata.name=" + SERVICE,
            "--format=json",
        )
    )
    require(
        isinstance(values, list) and len(values) <= 1,
        "service_inventory_invalid",
    )
    if not values:
        return None
    require(
        values[0].get("metadata", {}).get("name") == SERVICE,
        "service_identity_changed",
    )
    return read(cloud, target, "services", SERVICE)


def observe(cloud, target: Target, descriptor: dict) -> tuple[dict, dict]:
    service = read(cloud, target, "services", SERVICE)
    private_service(cloud, target, service)
    require(traffic(service) == expected_traffic(descriptor), "traffic_changed")
    revision = read(cloud, target, "revisions", descriptor["revision"])
    document = target.service_document(
        descriptor["imageReference"], descriptor["secretVersions"], descriptor["runId"]
    )
    runtime(revision, document, descriptor["revision"])
    require(
        urls(service, descriptor["tag"], descriptor["revision"])
        == (descriptor["serviceUrl"], descriptor["candidateUrl"]),
        "url_changed",
    )
    return service, revision


def provenance(
    service: dict, revision: dict, target: Target, descriptor: dict, *, tagged=True
) -> dict:
    spec = importlib.util.spec_from_file_location(
        "isolated_revision_provenance",
        image.ROOT / "scripts/ci/verify-cloudrun-revision-provenance.py",
    )
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    projected = {
        "metadata": {
            "name": revision["metadata"]["name"],
            "labels": {
                k: v for k, v in revision["metadata"]["labels"].items() if k in PROVENANCE_LABELS
            },
        },
        "spec": {"containers": [{"env": revision["spec"]["containers"][0]["env"]}]},
        "status": {
            "imageDigest": revision.get("status", {}).get("imageDigest"),
            "conditions": [
                {"type": c.get("type"), "status": c.get("status")}
                for c in revision.get("status", {}).get("conditions", [])
            ],
        },
    }
    with tempfile.TemporaryDirectory(prefix="plg-provenance-") as folder:
        service_path, revision_path = Path(folder) / "service.json", Path(folder) / "revision.json"
        service_path.write_text(
            json.dumps(
                {
                    "status": {
                        "traffic": [
                            {k: row[k] for k in ("tag", "revisionName", "url") if k in row}
                            for row in service.get("status", {}).get("traffic", [])
                            if row.get("tag") == descriptor["tag"]
                        ]
                    }
                }
            ),
            encoding="utf-8",
        )
        revision_path.write_text(json.dumps(projected), encoding="utf-8")
        report = verifier.verify(
            SimpleNamespace(
                service_json=str(service_path),
                revision_json=[str(revision_path)],
                project=target.project,
                region=REGION,
                service=SERVICE,
                expected_env=target.environment,
                expected_source="plg-isolated-qualification",
                expected_sha=SOURCE,
                expected_run_id=descriptor["runId"],
                candidate_revision=descriptor["revision"],
                candidate_tag=descriptor["tag"] if tagged else "",
                expected_image_reference=descriptor["imageReference"],
            )
        )
    require(
        set(report) == REPORT_KEYS
        and report["ok"] is True
        and report["status"] == "healthy"
        and not report["failures"],
        "canonical_provenance_failed",
    )
    return report


def replace_service(cloud, target: Target, document: dict) -> None:
    with tempfile.TemporaryDirectory(prefix="plg-candidate-") as folder:
        path = Path(folder) / "service.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        cloud.command(
            "run",
            "services",
            "replace",
            str(path),
            "--project=" + target.project,
            "--region=" + REGION,
            "--quiet",
            "--format=json",
            timeout=360,
        )


def deploy_candidate(
    target: Target,
    attempt: image.Attempt,
    image_reference: str,
    versions: dict,
    *,
    cloud=None,
    http=None,
    checkpoint=lambda _value: None,
) -> dict:
    tag, revision = identity(target, attempt)
    document = target.service_document(image_reference, versions, attempt.run_id)
    cloud, http = cloud or image.Cloud(), http or Http()
    previous = existing_service(cloud, target)
    baseline = {"weights": {}, "tags": {}}
    if previous is not None:
        private_service(cloud, target, previous)
        require(
            http.get(origin(previous["status"]["url"]) + "/health")[0] in {401, 403},
            "existing_service_public",
        )
        baseline = traffic(previous)
        require(tag not in baseline["tags"], "attempt_already_present")
        document["metadata"]["resourceVersion"] = previous["metadata"]["resourceVersion"]
        document["metadata"]["annotations"] = (
            previous["metadata"].get("annotations", {}) | document["metadata"]["annotations"]
        )
        document["spec"]["traffic"] = traffic_spec(baseline)
    document["spec"]["template"]["metadata"]["name"] = revision
    descriptor = {
        "environment": target.environment,
        "workflowSha": attempt.workflow_sha,
        "runId": attempt.run_id,
        "runAttempt": attempt.run_attempt,
        "imageReference": image_reference,
        "secretVersions": dict(versions),
        "revision": revision,
        "tag": tag,
        "baselineTraffic": baseline,
        "freshService": previous is None,
    }
    checkpoint(descriptor | {"status": "deploy-needs-reconciliation"})
    replace_service(cloud, target, document)
    service = read(cloud, target, "services", SERVICE)
    private_service(cloud, target, service)
    created = read(cloud, target, "revisions", revision)
    runtime(created, document, revision)
    provenance(service, created, target, descriptor, tagged=False)
    before_tag = traffic(service)
    expected = {"weights": {revision: 100}, "tags": {}} if previous is None else baseline
    require(before_tag == expected, "deploy_changed_traffic")
    checkpoint(descriptor | {"status": "tag-needs-reconciliation"})
    cloud.command(
        "run",
        "services",
        "update-traffic",
        SERVICE,
        "--update-tags=" + tag + "=" + revision,
        "--project=" + target.project,
        "--region=" + REGION,
        "--quiet",
        "--format=json",
        timeout=120,
    )
    service = read(cloud, target, "services", SERVICE)
    descriptor["serviceUrl"], descriptor["candidateUrl"] = urls(service, tag, revision)
    service, created = observe(cloud, target, descriptor)
    provenance(service, created, target, descriptor)
    descriptor["actualTraffic"] = traffic(service)
    return descriptor


def token_audience(token: str, audience: str) -> None:
    require(
        isinstance(token, str) and 0 < len(token) <= 16384 and len(token.split(".")) == 3,
        "identity_token_invalid",
    )
    payload = token.split(".")[1]
    try:
        claims = json.loads(
            base64.b64decode(payload + "=" * (-len(payload) % 4), altchars=b"-_", validate=True)
        )
    except (ValueError, TypeError):
        claims = {}
    require(
        isinstance(claims, dict)
        and claims.get("aud") == audience
        and type(claims.get("exp")) is int
        and claims["exp"] > time.time()
        and claims.get("iss") in {"https://accounts.google.com", "accounts.google.com"},
        "token_audience_or_expiry_invalid",
    )


def verify_and_probe(descriptor: dict, id_token: str, *, cloud=None, http=None) -> dict:
    target = Target(descriptor["environment"])
    attempt = image.Attempt(
        descriptor["workflowSha"], descriptor["runId"], descriptor["runAttempt"]
    )
    require(
        identity(target, attempt) == (descriptor["tag"], descriptor["revision"]),
        "attempt_binding_changed",
    )
    cloud, http = cloud or image.Cloud(), http or Http()
    service, revision = observe(cloud, target, descriptor)
    before = provenance(service, revision, target, descriptor)
    token_audience(id_token, descriptor["serviceUrl"])
    endpoint = descriptor["candidateUrl"] + "/health"
    anonymous = http.get(endpoint)[0]
    require(anonymous in {401, 403}, "public_health")
    passes = []
    for _index in range(2):
        status, body = http.get(endpoint, id_token)
        require(
            status == 200 and json.loads(body).get("status") == "healthy",
            "private_health_failed",
        )
        passes.append({"httpStatus": status, "bodyStatus": "healthy"})
    service, revision = observe(cloud, target, descriptor)
    after = provenance(service, revision, target, descriptor)
    require(before == after, "provenance_changed_during_probe")
    observed = revision["spec"]["containers"][0]
    env = environment(observed)
    candidate = {
        "revision": descriptor["revision"],
        "serviceUrl": descriptor["serviceUrl"],
        "runtimePrincipal": revision["spec"]["serviceAccountName"],
        "runtimeSecretVersions": {
            PREFIX + name: env[name]["valueFrom"]["secretKeyRef"]["key"] for name in RUNTIME_SECRETS
        },
        "cloudSqlInstance": revision["metadata"]["annotations"][
            "run.googleapis.com/cloudsql-instances"
        ],
        "database": env["DB_NAME"]["value"],
        "runtimeCommand": revision["spec"]["containers"][0]["command"],
        "runtimeArgs": revision["spec"]["containers"][0]["args"],
        "runtimeEnvironment": {
            "KAI_MARKET_BACKGROUND_REFRESH": env["KAI_MARKET_BACKGROUND_REFRESH"]["value"]
        },
        "provenance": after,
        "actualTraffic": traffic(service),
        "observedAt": now(),
    }
    health = {
        "candidateUrl": descriptor["candidateUrl"],
        "audience": descriptor["serviceUrl"],
        "revision": descriptor["revision"],
        "imageReference": descriptor["imageReference"],
        "authenticated": True,
        "redirects": 0,
        "provenanceRechecked": True,
        "passes": passes,
        "unauthenticatedStatus": anonymous,
        "observedAt": now(),
    }
    acceptance_contract.candidate(
        candidate,
        health,
        target,
        {"id": int(attempt.run_id)},
        descriptor["imageReference"],
        candidate["runtimeSecretVersions"],
    )
    return {"candidate": candidate, "health": health}
