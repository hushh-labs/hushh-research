"""Verify main-owned hosted validation of the exact recorded recovery candidate.

This receipt proves source checks, not UAT acceptance or production deployment.
Reuse the release authority's bounded GitHub transport and artifact verification.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ".github/workflows/main-post-merge-smoke.yml"
RECORD_PATH = "deploy/account-deletion/production-restoration.json"
GATE = "Production Recovery Validation Gate"
CHECKS = ["source-secret-scan", "smoke", "account-lifecycle", "frontend-continuity"]
STEPS = {
    "Admit exact validation source",
    "Scan exact recovery changes for secrets",
    "Run compact post-merge smoke bundle",
    "Verify recovery lifecycle and frontend contracts",
    "Record exact recovery validation",
    "Upload exact recovery validation",
}


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


authority = load(
    "restoration_source", Path(__file__).with_name("compatibility_restoration.py")
)
acceptance = load(
    "restoration_transport", ROOT / "scripts/ci/verify-predecessor-acceptance.py"
)
require = authority.require


def qualify_run(run: dict, *, run_id: int, allowed: set[str]) -> None:
    require(
        run.get("id") == run_id
        and run.get("path") == WORKFLOW
        and run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == "main"
        and run.get("repository", {}).get("full_name") == acceptance.REPOSITORY
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")) is not None
        and run.get("actor", {}).get("login") in allowed
        and run.get("triggering_actor", {}).get("login") in allowed,
        "The current recovery validation attempt is not authorized and successful",
    )


def qualify_jobs(inventory: dict, run: dict) -> None:
    jobs = inventory.get("jobs")
    require(
        inventory.get("total_count") == 1 and isinstance(jobs, list) and len(jobs) == 1,
        "Recovery validation job inventory is incomplete or ambiguous",
    )
    job = jobs[0]
    require(
        job.get("run_id") == run["id"]
        and job.get("head_sha") == run["head_sha"]
        and job.get("name") == GATE
        and job.get("status") == "completed"
        and job.get("conclusion") == "success",
        "The recovery-specific validation gate did not pass",
    )
    steps = job.get("steps") or []
    for name in STEPS:
        matched = [step for step in steps if step.get("name") == name]
        require(
            len(matched) == 1
            and matched[0].get("status") == "completed"
            and matched[0].get("conclusion") == "success",
            "A required recovery validation step did not pass",
        )


def qualify_receipt(receipt: dict, record: dict, run: dict, record_digest: str) -> None:
    expected = {
        "schemaVersion": 1,
        "status": "passed",
        "candidateSha": record["sourceSha"],
        "baselineSha": record["baselineSha"],
        "workflowSha": run["head_sha"],
        "recordSha256": record_digest,
        "repository": acceptance.REPOSITORY,
        "runId": run["id"],
        "runAttempt": run["run_attempt"],
        "checks": CHECKS,
    }
    require(
        receipt == expected,
        "Recovery receipt does not match the source and current attempt",
    )


def select_artifact(inventory: dict, run: dict) -> dict:
    artifacts = inventory.get("artifacts")
    require(
        isinstance(artifacts, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(artifacts)
        and len(artifacts) <= 100,
        "Recovery artifact inventory is incomplete",
    )
    name = f"production-restoration-validation-{run['id']}-{run['run_attempt']}"
    matches = [item for item in artifacts if item.get("name") == name]
    require(
        len(matches) == 1, "Exact-attempt recovery artifact is missing or ambiguous"
    )
    artifact = matches[0]
    require(
        artifact.get("expired") is False
        and type(artifact.get("id")) is int
        and artifact["id"] > 0
        and artifact.get("workflow_run", {}).get("id") == run["id"]
        and 0 < artifact.get("size_in_bytes", 0) <= acceptance.MAX_BYTES
        and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", ""))
        is not None,
        "Recovery artifact identity or retention is invalid",
    )
    return artifact


def verify(run_id: int, sha: str, github=None) -> dict:
    require(
        type(run_id) is int and run_id > 0, "An exact hosted validation run is required"
    )
    record = authority.qualify_source(sha)
    record_digest = hashlib.sha256(authority.RECORD.read_bytes()).hexdigest()
    policy = json.loads((ROOT / "config/ci-governance.json").read_text())
    allowed = set(policy["production"]["manual_dispatch_users"])
    client = github or acceptance.GitHub()
    path = f"runs/{run_id}"
    run = client.read(path)
    qualify_run(run, run_id=run_id, allowed=allowed)
    authority.git("merge-base", "--is-ancestor", run["head_sha"], "origin/main")
    validated_record = authority.git("show", f"{run['head_sha']}:{RECORD_PATH}")
    require(
        hashlib.sha256(validated_record.encode()).hexdigest() == record_digest,
        "Hosted validation used a different recovery authority",
    )
    qualify_jobs(
        client.read(f"{path}/attempts/{run['run_attempt']}/jobs?per_page=100"), run
    )
    artifact = select_artifact(client.read(f"{path}/artifacts?per_page=100"), run)
    receipt = acceptance.unpack(
        client.read(f"artifacts/{artifact['id']}/zip", binary=True), artifact["digest"]
    )
    qualify_receipt(receipt, record, run, record_digest)
    # A later failed or running rerun invalidates an earlier successful result.
    client.cache.pop(path, None)
    current = client.read(path)
    qualify_run(current, run_id=run_id, allowed=allowed)
    require(
        all(
            current.get(key) == run.get(key)
            for key in ("run_attempt", "head_sha", "updated_at")
        ),
        "Recovery validation changed during admission",
    )
    return {
        "status": "validated",
        "scope": "production-restoration-only",
        "sourceSha": sha,
        "workflowSha": run["head_sha"],
        "runId": run_id,
        "runAttempt": run["run_attempt"],
        "artifactId": artifact["id"],
        "artifactDigest": artifact["digest"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify(args.run_id, args.sha)
    except Exception:
        parser.exit(1, "Exact recovery validation could not be proved\n")
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(
        "Exact production recovery source validation verified; no deployment performed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
