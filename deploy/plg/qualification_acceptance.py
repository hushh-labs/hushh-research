"""Consume hosted isolated PLG evidence; never shared acceptance or PROD authority.

Only verify() admits evidence, from the latest successful governed attempt and
its digest-bound artifact. A local JSON file is never an admission input. The
reviewed main workflow must produce the exported gate/step contract; this
consumer deliberately refuses ordinary Dev/UAT jobs and receipts.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

import qualification_acceptance_contract as proofs
import qualification_foundation as foundation
import validation
from qualification_target import (
    BASELINE,
    SOURCE,
    Target,
    require,
)

KIND = "plg-isolated-qualification-acceptance-v1"
TARGET = proofs.TARGET
_same, _fields = proofs._same, proofs._fields
GATES = {env: f"PLG Isolated {env.title()} Acceptance Gate" for env in ("dev", "uat")}
STEPS = frozenset(
    {
        "Require governed isolated PLG target",
        "Verify exact PLG source validation",
        "Verify isolated schema and runtime permissions",
        "Verify isolated private IAM and capacity",
        "Deploy isolated PLG candidate",
        "Verify isolated private candidate provenance and health",
        "Record isolated PLG acceptance",
        "Upload isolated PLG acceptance",
    }
)
IMAGE_STEPS = {
    "dev": "Build exact PLG source image",
    "uat": "Promote exact isolated Dev image",
}
AUTHORITY_PATHS = tuple(
    sorted(
        {
            *validation.AUTHORITY_PATHS,
            "deploy/plg/validation.py",
            "deploy/plg/qualification_acceptance.py",
            "deploy/plg/qualification_acceptance_contract.py",
            "deploy/plg/qualification_attachment.py",
            *(
                f"deploy/plg/qualification_{name}.py"
                for name in (
                    "target",
                    "resources",
                    "database",
                    "bootstrap",
                    "base",
                    "foundation",
                    "schema",
                    "image",
                    "producer",
                    "schema_executor",
                    "candidate",
                    "iam",
                    "iam_contract",
                    "runtime",
                    "membership",
                    "candidate_contract",
                )
            ),
            foundation.PATH,
            "deploy/backend-image.cloudbuild.yaml",
            "scripts/ci/verify-predecessor-acceptance.py",
            "scripts/ci/process_group.py",
            "scripts/ci/release_acceptance_provenance.py",
            "scripts/ci/resolve-cloud-run-image.py",
            "scripts/ci/verify-cloudrun-revision-provenance.py",
            "scripts/ci/runtime-capacity-budget.py",
            "scripts/ci/runtime_capacity_inventory.py",
            "scripts/ci/runtime_capacity_cli.py",
            "scripts/ci/runtime_capacity_target_scope.py",
            "scripts/ci/runtime_capacity_volume.py",
            "config/runtime-capacity.json",
        }
    )
)


@dataclass(frozen=True)
class IsolatedAcceptance:
    """An immutable isolated predecessor pin, with no ordinary release authority."""

    environment: str
    run_id: int
    run_attempt: int
    artifact_id: int
    artifact_digest: str
    workflow_sha: str
    image_reference: str

    def pin(self) -> dict:
        return {
            "kind": KIND,
            "environment": self.environment,
            "sourceSha": SOURCE,
            "runId": self.run_id,
            "runAttempt": self.run_attempt,
            "artifactId": self.artifact_id,
            "artifactDigest": self.artifact_digest,
            "workflowSha": self.workflow_sha,
            "imageReference": self.image_reference,
            "sharedEnvironmentAccepted": False,
            "productionTrafficAuthorized": False,
        }


def reviewed_definitions(workflow_sha: str, environment: str) -> dict[str, str]:
    """Bind Git blobs, including the producer itself, to this committed authority."""
    Target(environment)
    require(
        re.fullmatch(r"[0-9a-f]{40}", workflow_sha) is not None,
        "qualification_workflow_sha_invalid",
    )
    git = validation.authority._git
    git("merge-base", "--is-ancestor", workflow_sha, "origin/main")
    paths = (*AUTHORITY_PATHS, f".github/workflows/deploy-{environment}.yml")
    result = {}
    for path in paths:
        committed = git("show", "HEAD:" + path)
        hosted = git("show", workflow_sha + ":" + path)
        # Git's normalized blob is authoritative; checkout CRLF is immaterial.
        working = (validation.ROOT / path).read_text(encoding="utf-8")
        require(
            hosted == committed and working == committed.decode().replace("\r\n", "\n"),
            "qualification_producer_definition_changed",
        )
        result[path] = hashlib.sha256(committed).hexdigest()
    return result


def _run_and_job(client, run_id: int, target: Target, allowed: set[str]) -> tuple[dict, dict]:
    run = client.read(f"runs/{run_id}")
    _fields(
        run,
        "qualification_run_not_successful_main_dispatch",
        id=run_id,
        path=f".github/workflows/deploy-{target.environment}.yml",
        event="workflow_dispatch",
        head_branch="main",
        status="completed",
        conclusion="success",
    )
    require(
        type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")) is not None
        and all(
            run.get(key, {}).get("full_name") == validation.transport.REPOSITORY
            for key in ("repository", "head_repository")
        )
        and all(run.get(key, {}).get("login") in allowed for key in ("actor", "triggering_actor")),
        "qualification_run_identity_unverified",
    )
    inventory = client.read(f"runs/{run_id}/attempts/{run['run_attempt']}/jobs?per_page=100")
    jobs = inventory.get("jobs")
    require(
        isinstance(jobs, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(jobs) <= 100,
        "qualification_job_inventory_incomplete",
    )
    matches = [job for job in jobs if job.get("name") == GATES[target.environment]]
    require(len(matches) == 1, "qualification_isolated_gate_missing_or_ambiguous")
    job = matches[0]
    _fields(
        job,
        "qualification_isolated_gate_did_not_pass",
        run_id=run_id,
        head_sha=run["head_sha"],
        status="completed",
        conclusion="success",
    )
    for name in STEPS | {IMAGE_STEPS[target.environment]}:
        steps = [step for step in job.get("steps", []) if step.get("name") == name]
        require(len(steps) == 1, "qualification_required_step_missing_or_ambiguous")
        _fields(
            steps[0],
            "qualification_required_step_did_not_execute",
            status="completed",
            conclusion="success",
        )
    return run, job


def _artifact(client, run: dict, environment: str) -> tuple[dict, dict]:
    inventory = client.read(f"runs/{run['id']}/artifacts?per_page=100")
    artifacts = inventory.get("artifacts")
    require(
        isinstance(artifacts, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(artifacts) <= 100,
        "qualification_artifact_inventory_incomplete",
    )
    name = f"plg-isolated-acceptance-{environment}-{run['id']}-{run['run_attempt']}"
    matches = [item for item in artifacts if item.get("name") == name]
    require(len(matches) == 1, "qualification_exact_artifact_missing_or_ambiguous")
    artifact = matches[0]
    require(
        artifact.get("expired") is False
        and type(artifact.get("id")) is int
        and artifact["id"] > 0
        and artifact.get("workflow_run", {}).get("id") == run["id"]
        and type(artifact.get("size_in_bytes")) is int
        and 0 < artifact["size_in_bytes"] <= validation.transport.MAX_BYTES
        and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", "")) is not None,
        "qualification_artifact_integrity_unverified",
    )
    receipt = validation.transport.unpack(
        client.read(f"artifacts/{artifact['id']}/zip", binary=True), artifact["digest"]
    )
    return artifact, receipt


def _predecessor(client, receipt: dict, environment: str) -> IsolatedAcceptance | None:
    pin = receipt["predecessor"]
    if environment == "dev":
        _same(pin, None, "qualification_dev_predecessor_invalid")
        return None
    require(isinstance(pin, dict), "qualification_isolated_dev_predecessor_required")
    previous = verify("dev", pin.get("runId"), github=client)
    _same(pin, previous.pin(), "qualification_isolated_dev_predecessor_mismatch")
    return previous


def verify(environment: str, run_id: int, github=None) -> IsolatedAcceptance:
    """Read one exact latest attempt; never search history or accept local proof."""
    target = Target(environment)
    require(type(run_id) is int and run_id > 0, "qualification_exact_run_required")
    client = github or validation.transport.GitHub()
    policy = json.loads((validation.ROOT / "config/ci-governance.json").read_text())
    allowed = set(policy["production"]["manual_dispatch_users"])
    run, job = _run_and_job(client, run_id, target, allowed)
    definitions = reviewed_definitions(run["head_sha"], environment)
    _record, foundation_digest = foundation.load_contract()
    artifact, receipt = _artifact(client, run, environment)
    fixed = {
        "schemaVersion": 1,
        "kind": KIND,
        "status": "accepted-isolated",
        "target": TARGET,
        "environment": environment,
        "sourceSha": SOURCE,
        "baselineSha": BASELINE,
        "repository": validation.transport.REPOSITORY,
        "workflow": run["path"],
        "workflowSha": run["head_sha"],
        "runId": run_id,
        "runAttempt": run["run_attempt"],
        "authorityBlobs": definitions,
        "sharedEnvironmentAccepted": False,
        "productionTrafficAuthorized": False,
    }
    require(
        set(receipt)
        == {
            *fixed,
            "sourceValidation",
            "image",
            "schema",
            "iam",
            "capacity",
            "candidate",
            "health",
            "predecessor",
        },
        "qualification_receipt_type_invalid",
    )
    _fields(receipt, "qualification_receipt_identity_mismatch", **fixed)
    source = receipt["sourceValidation"]
    source_run = source.get("runId") if isinstance(source, dict) else None
    _same(
        source,
        validation.verify(source_run, SOURCE, github=client),
        "qualification_source_validation_not_current",
    )
    previous = _predecessor(client, receipt, environment)
    source_tree = validation.authority._git("rev-parse", SOURCE + "^{tree}").decode().strip()
    image = proofs.image(receipt["image"], target, run, definitions, previous, source_tree)
    proofs.schema(receipt["schema"], target, foundation_digest)
    versions = proofs.iam(receipt["iam"], target)
    proofs.capacity(receipt["capacity"], target)
    proofs.candidate(receipt["candidate"], receipt["health"], target, run, image, versions)
    for key in ("image", "schema", "iam", "capacity", "candidate", "health"):
        proofs._observed(receipt[key], job)
    client.cache.pop(f"runs/{run_id}", None)
    current, _job = _run_and_job(client, run_id, target, allowed)
    require(
        all(current.get(key) == run.get(key) for key in ("run_attempt", "head_sha", "updated_at")),
        "qualification_deployment_changed_during_admission",
    )
    return IsolatedAcceptance(
        environment,
        run_id,
        run["run_attempt"],
        artifact["id"],
        artifact["digest"],
        run["head_sha"],
        image,
    )
