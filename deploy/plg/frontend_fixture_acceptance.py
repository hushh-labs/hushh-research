"""Consume genuine hosted private frontend fixture evidence, never production.

Historical acceptance proves the explicitly scoped negative-owner proxy checks.
Callers needing current service state must request/repeat native observation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import yaml
from dataclasses import dataclass

import frontend_fixture_github as hosted
import frontend_fixture_candidate as candidate
import frontend_fixture_runtime as runtime
import frontend_fixture_producer as producer
import frontend_release as release
import frontend_validation as validation

JOB = "PLG Private Frontend Fixture"
BUILD_STEP = "Build exact isolated frontend fixture image"
STAGE_STEP = "Stage private frontend fixture"
RECOVER_STEP = "Recover private frontend fixture route"
BUILD_UPLOAD = "Publish immutable fixture build intent"
STAGE_UPLOAD = "Publish immutable fixture stage intent"
RECOVER_UPLOAD = "Publish immutable fixture recovery intent"
ACCEPT_UPLOAD = "Publish scoped private fixture acceptance"
RECOVER_OUTPUT = "Publish private fixture recovery result"
KIND = "plg-private-frontend-fixture-acceptance-v1"


def client_or(client):
    return client or validation.transport.GitHub()


def fresh(client, path, **kwargs):
    return hosted._fresh(client, path, **kwargs)


def workflow(environment):
    release.require(
        environment in release.TARGETS, "Fixture hosted environment invalid"
    )
    return release.WORKFLOWS[environment]


def writer_lock(environment):
    """Prove the fixture shares the actual current environment writer group."""
    own = yaml.safe_load((release.ROOT / workflow(environment)).read_bytes())[
        "concurrency"
    ]
    release.require(
        own.get("group") == "deploy-" + environment
        and own.get("cancel-in-progress") is False,
        "Fixture shared writer group invalid",
    )
    shared = yaml.safe_load(
        (release.ROOT / f".github/workflows/deploy-{environment}.yml").read_bytes()
    )
    if environment == "dev":
        expected = "deploy-dev${{ inputs.target == 'scope-commerce-sandbox' && '-scope-commerce-sandbox' || '' }}"
        release.require(
            shared["concurrency"].get("group") == expected
            and shared["concurrency"].get("cancel-in-progress") is False,
            "Fixture canonical Dev writer group changed",
        )
    else:
        release.require(
            all(
                shared["jobs"][key].get("concurrency", {}).get("group") == "deploy-uat"
                and shared["jobs"][key]["concurrency"].get("cancel-in-progress")
                is False
                for key in ("deploy", "plg-isolated")
            ),
            "Fixture canonical UAT writer group changed",
        )


def completed(client, environment, run_id, attempt, required, *, success):
    return hosted._run(
        client, run_id, attempt, JOB, set(required), environment, success=success
    )


def artifact(client, run, job, environment, kind, upload, filename):
    return hosted._artifact(
        client, run, job, f"plg-fixture-{kind}-{environment}", upload, filename
    )


def current(environment, active_step, required, *, github=None):
    client = client_or(github)
    release.require(
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("GITHUB_JOB") == "fixture"
        and os.environ.get("GITHUB_WORKFLOW_REF")
        == "hushh-labs/hushh-research/" + workflow(environment) + "@refs/heads/main",
        "Fixture hosted context required",
    )
    run_id, attempt = (
        int(os.environ["GITHUB_RUN_ID"]),
        int(os.environ["GITHUB_RUN_ATTEMPT"]),
    )
    run = fresh(client, f"runs/{run_id}")
    allowed = json.loads((release.ROOT / "config/ci-governance.json").read_bytes())[
        environment
    ]["manual_dispatch_users"]
    release.require(
        run.get("id") == run_id
        and run.get("run_attempt") == attempt
        and run.get("head_sha") == os.environ.get("GITHUB_SHA")
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and run.get("path") == workflow(environment)
        and run.get("status") == "in_progress"
        and all(
            run.get(key, {}).get("full_name") == validation.transport.REPOSITORY
            and run.get(key, {}).get("id") == hosted.REPOSITORY_ID
            for key in ("repository", "head_repository")
        )
        and all(
            run.get(key, {}).get("login") in allowed
            for key in ("actor", "triggering_actor")
        ),
        "Fixture current run unverified",
    )
    hosted._reviewed_authority(run["head_sha"], workflow(environment))
    writer_lock(environment)
    definition = fresh(client, "workflows/" + workflow(environment).rsplit("/", 1)[1])
    release.require(
        run.get("workflow_id") == definition.get("id")
        and definition.get("path") == workflow(environment),
        "Fixture current workflow changed",
    )
    inventory = fresh(client, f"runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    jobs = inventory.get("jobs", [])
    release.require(
        inventory.get("total_count") == len(jobs) == 1 and jobs[0].get("name") == JOB,
        "Fixture current jobs ambiguous",
    )
    job = jobs[0]
    release.require(
        job.get("run_id") == run_id
        and job.get("run_attempt") == attempt
        and job.get("head_sha") == run["head_sha"]
        and job.get("status") == "in_progress",
        "Fixture current job unbound",
    )
    for name in required:
        rows = [row for row in job.get("steps", []) if row.get("name") == name]
        release.require(
            len(rows) == 1
            and rows[0].get("status") == "completed"
            and rows[0].get("conclusion") == "success",
            "Fixture required publication missing",
        )
    active = [row for row in job.get("steps", []) if row.get("status") == "in_progress"]
    release.require(
        len(active) == 1
        and active[0].get("name") == active_step
        and active[0].get("started_at"),
        "Fixture current step unbound",
    )
    return client, run, job


def stage_intent(environment, run_id, attempt, *, github=None):
    client = client_or(github)
    run, job = completed(
        client, environment, run_id, attempt, [STAGE_UPLOAD], success=False
    )
    item, document = artifact(
        client, run, job, environment, "stage-intent", STAGE_UPLOAD, "stage-intent.json"
    )
    validate_intent(document, run, environment)
    return {
        "artifactId": item["id"],
        "artifactDigest": item["digest"],
        "document": document,
    }


def validate_intent(document, run, environment, *, recorded_authority=None):
    attempt = release.Attempt(
        environment, run["head_sha"], str(run["id"]), str(run["run_attempt"])
    )
    release.require(
        isinstance(document, dict)
        and document.get("kind") == "plg-private-fixture-stage-intent-v1"
        and document.get("producer")
        == {
            "runId": run["id"],
            "attempt": run["run_attempt"],
            "workflowSha": run["head_sha"],
        }
        and document.get("environment") == environment
        and document.get("sourceSha") == release.SOURCE
        and document.get("productionTrafficAuthorized") is False,
        "Fixture stage intent invalid",
    )
    prepared, snapshot = document.get("prepared"), document.get("snapshot")
    release.require(
        isinstance(prepared, dict)
        and isinstance(snapshot, dict)
        and "fixtureRuntime" in prepared,
        "Fixture stage inputs missing",
    )
    from frontend_hosted_caller import proposed_build_intent
    import base64

    recipe = base64.b64decode(document["recipeBase64"], validate=True)
    original_recipe, overlays = producer.originals(attempt)
    proposed = proposed_build_intent(
        attempt,
        prepared,
        snapshot,
        recipe,
        original_recipe,
        overlays,
        authority_paths=recorded_authority,
    )
    release.require(
        proposed == document.get("buildIntent"), "Fixture stage build inputs changed"
    )
    image = document.get("buildEvidence", {}).get("imageReference")
    expected = runtime.service_document(
        attempt, image, snapshot["inventory"], prepared["fixtureRuntime"]
    )
    release.require(
        document.get("serviceDocument") == expected, "Fixture stage service changed"
    )
    return attempt, recipe, original_recipe, overlays


def verify_build(document, environment, *, cloud=None, recorded_authority=None):
    """Independently reread provider build, manifests and final runtime layer."""
    run = {
        "head_sha": document["producer"]["workflowSha"],
        "id": document["producer"]["runId"],
        "run_attempt": document["producer"]["attempt"],
    }
    attempt, recipe, original, overlays = validate_intent(
        document, run, environment, recorded_authority=recorded_authority
    )
    cloud = cloud or producer.images.Cloud()
    stored = document["buildEvidence"]
    build = cloud.read(
        "builds", "describe", stored["buildId"], "--project=" + attempt.project
    )
    index = producer.manifest(cloud, attempt, stored["indexDigest"])
    child_digest = stored["imageReference"].rsplit("@", 1)[1]
    child = producer.manifest(cloud, attempt, child_digest)
    rebuilt = producer.evidence.build_document(
        attempt,
        document["prepared"],
        recipe,
        build,
        stored["buildId"],
        stored["storage"],
        stored["serviceAccount"],
        index,
        child,
        original,
        overlays,
        authority_paths=recorded_authority,
    )
    release.require(rebuilt == stored, "Fixture native build evidence changed")
    raw = json.loads(child)
    proof = runtime.verify_runtime_layer(
        child,
        producer.blob(cloud, attempt, raw["layers"][-1]["digest"]),
        document["prepared"]["fixtureRuntime"],
    )
    release.require(
        proof == document["runtimeImageReadback"]
        and proof["executableManifestDigest"] == child_digest,
        "Fixture runtime image readback changed",
    )
    return attempt


def observation(value, document):
    """Check a hosted observation's identity before giving it a typed pin."""
    desired = document["serviceDocument"]
    target = desired["spec"]["traffic"][0]
    release.require(
        isinstance(value, dict)
        and value.get("revision") == target["revisionName"]
        and value.get("imageReference") == document["buildEvidence"]["imageReference"]
        and all(
            isinstance(value.get(key), str)
            and re.fullmatch(r"[A-Za-z0-9._-]{1,256}", value[key])
            for key in ("serviceUid", "revisionUid", "resourceVersion")
        ),
        "Fixture observation identity invalid",
    )
    previous = document.get("previous")
    release.require(
        previous is None or value["serviceUid"] == previous.get("uid"),
        "Fixture reused service UID changed",
    )
    from urllib.parse import urlsplit

    for key in ("serviceUrl", "candidateUrl"):
        text = value.get(key)
        parsed = urlsplit(text if isinstance(text, str) else "")
        release.require(
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.hostname.endswith(".run.app")
            and parsed.netloc == parsed.hostname
            and not (parsed.path or parsed.query or parsed.fragment),
            "Fixture observation origin invalid",
        )
    release.require(
        urlsplit(value["serviceUrl"]).hostname.startswith(runtime.SERVICE + "-")
        and urlsplit(value["candidateUrl"]).hostname.startswith(
            target["tag"] + "---" + runtime.SERVICE + "-"
        ),
        "Fixture observation route unbound",
    )
    return value


@dataclass(frozen=True)
class Acceptance:
    environment: str
    run_id: int
    attempt: int
    artifact_id: int
    artifact_digest: str
    image: str

    def pin(self):
        return {
            "kind": KIND,
            "environment": self.environment,
            "runId": self.run_id,
            "attempt": self.attempt,
            "artifactId": self.artifact_id,
            "artifactDigest": self.artifact_digest,
            "imageReference": self.image,
            "positiveOwnerPreferenceVerified": False,
            "productionTrafficAuthorized": False,
        }


def verify(environment, run_id, attempt=None, *, github=None, live=False, native=None):
    release.require(
        environment in release.TARGETS
        and type(run_id) is int
        and run_id > 0
        and (attempt is None or (type(attempt) is int and attempt > 0)),
        "Fixture acceptance identity invalid",
    )
    client = client_or(github)
    latest = fresh(client, f"runs/{run_id}")
    attempt = latest["run_attempt"] if attempt is None else attempt
    run, job = completed(
        client,
        environment,
        run_id,
        attempt,
        [
            BUILD_STEP,
            STAGE_UPLOAD,
            STAGE_STEP,
            "Verify private fixture proxy scope",
            ACCEPT_UPLOAD,
        ],
        success=True,
    )
    item, receipt = artifact(
        client, run, job, environment, "acceptance", ACCEPT_UPLOAD, "acceptance.json"
    )
    intent = stage_intent(environment, run_id, attempt, github=client)
    release.require(
        receipt.get("kind") == KIND
        and receipt.get("stageIntent")
        == {key: intent[key] for key in ("artifactId", "artifactDigest")}
        and receipt.get("productionTrafficAuthorized") is False
        and receipt.get("customerSendingVerified") is False,
        "Fixture acceptance scope invalid",
    )
    document = intent["document"]
    observation(receipt.get("candidate"), document)
    _source_and_scope(document, receipt, environment, client)
    verify_build(document, environment)
    if environment == "uat":
        predecessor = receipt.get("predecessor")
        release.require(
            isinstance(predecessor, dict)
            and predecessor
            == verify(
                "dev", predecessor["runId"], predecessor["attempt"], github=client
            ).pin(),
            "Fixture Dev predecessor unverified",
        )
    else:
        release.require(
            receipt.get("predecessor") is None, "Fixture Dev predecessor invalid"
        )
    if live:
        observed = candidate.observe(
            native or candidate.Cloud(environment), document["serviceDocument"]
        )
        release.require(
            observed == receipt.get("candidate"), "Fixture live service changed"
        )
    release.require(
        fresh(client, f"runs/{run_id}/attempts/{attempt}").get("updated_at")
        == run.get("updated_at"),
        "Fixture run changed during admission",
    )
    return Acceptance(
        environment,
        run_id,
        attempt,
        item["id"],
        item["digest"],
        document["buildEvidence"]["imageReference"],
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=("dev", "uat"), required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--historical", action="store_true")
    args = parser.parse_args()
    result = verify(
        args.environment, args.run_id, args.attempt, live=not args.historical
    )
    print(
        json.dumps(
            result.pin() | {"currentServingVerified": not args.historical},
            sort_keys=True,
        )
    )
    return 0


def _source_and_scope(document, receipt, environment, client):
    source = document["prepared"]["sourceValidation"]
    release.require(
        release.frontend_validation.verify(
            source["runId"], release.SOURCE, github=client
        )
        == source,
        "Fixture frontend source admission changed",
    )
    from qualification_acceptance import verify as verify_backend

    backend_pin = document["prepared"]["backendPair"]["acceptance"]
    release.require(
        verify_backend(environment, backend_pin["runId"], github=client).pin()
        == backend_pin,
        "Fixture backend acceptance changed",
    )
    checks = receipt.get("checks", {})
    release.require(
        checks.get("kind") == "plg-fixture-negative-owner-proxy-checks-v1"
        and checks.get("privateIngress") is True
        and checks.get("positiveOwnerPreferenceVerified") is False
        and checks.get("customerSendingVerified") is False
        and checks.get("preferences")
        == {
            method: {
                "status": 401,
                "responseMatchesPrivateBackend": True,
                "noStore": True,
            }
            for method in ("GET", "PUT")
        },
        "Fixture functional scope unverified",
    )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Private frontend fixture acceptance unverified", file=sys.stderr)
        sys.exit(1)
