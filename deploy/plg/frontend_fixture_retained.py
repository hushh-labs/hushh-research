"""Historical F provenance for zero direct-SQL accounting, never admission.

Only recorded historical Main blobs are read. No historical code is executed,
and no old S live route, health or release acceptance is required. Current F
build/image/runtime rules are independently applied to the retained revision.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

import frontend_fixture_acceptance as accepted
import frontend_fixture_candidate as candidate
import frontend_release as release


CAPACITY_ONLY_PATHS = frozenset(
    {
        "deploy/plg/frontend_fixture_retained.py",
        "config/runtime-capacity.json",
        "scripts/ci/runtime-capacity-budget.py",
        "scripts/ci/runtime_capacity_cli.py",
        "scripts/ci/runtime_capacity_inventory.py",
        "scripts/ci/runtime_capacity_target_scope.py",
        "consent-protocol/scripts/test-ci.manifest.txt",
    }
)


def critical_paths(environment):
    """Only this finite capacity-only closure may drift after a genuine build."""
    return (
        set(release.AUTHORITY_PATHS) | {release.WORKFLOWS[environment]}
    ) - CAPACITY_ONLY_PATHS


def historical_run(client, environment, run_id, attempt):
    release.require(
        environment in release.TARGETS
        and type(run_id) is int
        and run_id > 0
        and type(attempt) is int
        and attempt > 0,
        "Retained fixture identity invalid",
    )
    run = accepted.fresh(client, f"runs/{run_id}/attempts/{attempt}")
    sha = run.get("head_sha", "")
    release.require(
        re.fullmatch(r"[0-9a-f]{40}", sha), "Retained fixture Main SHA invalid"
    )
    git = release.source.backend._git
    git("merge-base", "--is-ancestor", sha, "origin/main")
    policy = json.loads(git("show", sha + ":config/ci-governance.json"))[environment][
        "manual_dispatch_users"
    ]
    release.require(
        run.get("id") == run_id
        and run.get("run_attempt") == attempt
        and run.get("status") == "completed"
        and run.get("head_branch") == "main"
        and run.get("path") == accepted.workflow(environment)
        and run.get("event") == "workflow_dispatch"
        and all(
            run.get(key, {}).get("full_name")
            == accepted.validation.transport.REPOSITORY
            and run.get(key, {}).get("id") == accepted.hosted.REPOSITORY_ID
            for key in ("repository", "head_repository")
        )
        and all(
            run.get(key, {}).get("login") in policy
            for key in ("actor", "triggering_actor")
        ),
        "Retained fixture historical run unverified",
    )
    definition = accepted.fresh(
        client, "workflows/" + accepted.workflow(environment).rsplit("/", 1)[1]
    )
    release.require(
        run.get("workflow_id") == definition.get("id")
        and definition.get("path") == run["path"],
        "Retained fixture workflow identity changed",
    )
    listing = accepted.fresh(
        client, f"runs/{run_id}/attempts/{attempt}/jobs?per_page=100"
    )
    jobs = listing.get("jobs", [])
    release.require(
        listing.get("total_count") == len(jobs) == 1
        and jobs[0].get("name") == accepted.JOB,
        "Retained fixture job inventory invalid",
    )
    job = jobs[0]
    release.require(
        job.get("run_id") == run_id
        and job.get("run_attempt") == attempt
        and job.get("head_sha") == sha
        and job.get("status") == "completed",
        "Retained fixture job unbound",
    )
    steps = [
        row for row in job.get("steps", []) if row.get("name") == accepted.STAGE_UPLOAD
    ]
    release.require(
        len(steps) == 1
        and steps[0].get("status") == "completed"
        and steps[0].get("conclusion") == "success",
        "Retained fixture intent was not published",
    )
    return run, job


def recorded_closure(document, run, environment):
    files = document.get("prepared", {}).get("authorityFiles")
    required = critical_paths(environment)
    release.require(
        isinstance(files, dict) and len(files) <= 400 and required <= set(files),
        "Retained fixture closure incomplete",
    )
    git = release.source.backend._git
    for path, expected in files.items():
        release.require(
            isinstance(path, str)
            and 0 < len(path) <= 512
            and not PurePosixPath(path).is_absolute()
            and ".." not in PurePosixPath(path).parts
            and isinstance(expected, str)
            and re.fullmatch(r"[0-9a-f]{64}", expected),
            "Retained fixture closure invalid",
        )
        historical = git("show", run["head_sha"] + ":" + path)
        release.require(
            0 < len(historical) <= 2 * 1024 * 1024
            and hashlib.sha256(historical).hexdigest() == expected,
            "Retained fixture historical blob changed",
        )
        if path in required:
            current = git("show", "origin/main:" + path)
            release.require(
                historical
                == current
                == (release.ROOT / path).read_bytes().replace(b"\r\n", b"\n"),
                "Retained fixture critical source changed; reviewed version extension required",
            )


@dataclass(frozen=True)
class RetainedFrontendBinding:
    environment: str
    run_id: int
    attempt: int
    artifact_id: int
    artifact_digest: str
    image: str
    secret_version: str
    service_uid: str
    revision_uid: str
    document_json: bytes

    @property
    def service_document(self):
        return json.loads(self.document_json)

    def pin(self):
        return {
            "kind": "plg-retained-frontend-capacity-identity-v1",
            "environment": self.environment,
            "runId": self.run_id,
            "attempt": self.attempt,
            "artifactId": self.artifact_id,
            "artifactDigest": self.artifact_digest,
            "imageReference": self.image,
            "backendSecretVersion": self.secret_version,
            "serviceUid": self.service_uid,
            "revisionUid": self.revision_uid,
            "producerProvenanceVerified": True,
            "nativeRevisionVerified": True,
            "directCloudSqlConnections": 0,
            "releaseAccepted": False,
            "productionTrafficAuthorized": False,
        }


def read(environment, run_id, attempt, *, github=None, cloud=None):
    """Read one recorded producer and its native retained F revision only."""
    client = accepted.client_or(github)
    run, job = historical_run(client, environment, run_id, attempt)
    item, document = accepted.artifact(
        client,
        run,
        job,
        environment,
        "stage-intent",
        accepted.STAGE_UPLOAD,
        "stage-intent.json",
    )
    recorded_closure(document, run, environment)
    recorded = frozenset(document["prepared"]["authorityFiles"])
    accepted.validate_intent(document, run, environment, recorded_authority=recorded)
    source = document["prepared"]["sourceValidation"]
    release.require(
        release.frontend_validation.verify(
            source["runId"], release.SOURCE, github=client
        )
        == source,
        "Retained fixture application source unverified",
    )
    native = cloud or candidate.Cloud(environment)
    accepted.verify_build(
        document, environment, cloud=native.gcloud, recorded_authority=recorded
    )
    service = native.service()
    candidate.private(service, native.policy(), release.TARGETS[environment])
    candidate.continuity(service, document)
    desired = document["serviceDocument"]
    revision = native.revision(desired["spec"]["template"]["metadata"]["name"])
    revision_uid = candidate.revision_matches(revision, desired)
    release.require(
        native.service() == service
        and native.revision(revision["metadata"]["name"]) == revision,
        "Retained fixture native identity changed",
    )
    again = accepted.fresh(client, f"runs/{run_id}/attempts/{attempt}")
    release.require(
        all(
            again.get(key) == run.get(key)
            for key in (
                "id",
                "run_attempt",
                "head_sha",
                "status",
                "conclusion",
                "updated_at",
            )
        ),
        "Retained fixture producer changed",
    )
    container = desired["spec"]["template"]["spec"]["containers"][0]
    ref = next(row for row in container["env"] if row["name"] == "BACKEND_URL")[
        "valueFrom"
    ]["secretKeyRef"]
    return RetainedFrontendBinding(
        environment,
        run_id,
        attempt,
        item["id"],
        item["digest"],
        container["image"],
        ref["key"],
        service["metadata"]["uid"],
        revision_uid,
        json.dumps(desired, sort_keys=True).encode(),
    )
