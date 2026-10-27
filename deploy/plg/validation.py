"""Verify immutable hosted checks for the recorded PLG source, never traffic."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parents[2]
authority = _load(
    "plg_validation_source", Path(__file__).with_name("release_source.py")
)
transport = _load(
    "plg_validation_transport", ROOT / "scripts/ci/verify-predecessor-acceptance.py"
)
require = authority.require
WORKFLOW = ".github/workflows/validate-plg-source.yml"
RECORD_PATH = "deploy/plg/production-source.json"
AUTHORITY_PATHS = (
    RECORD_PATH,
    WORKFLOW,
    "deploy/plg/release_source.py",
    "scripts/ci/assert-governed-actor.py",
    "config/ci-governance.json",
    "scripts/ci/check-dco-signoff.sh",
    ".gitleaks.toml",
    "consent-protocol/.github/actions/setup-python-uv/action.yml",
)
GATE = "PLG Source Validation Gate"
CHECKS = [
    "source-identity",
    "source-secret-scan",
    "source-dco",
    "full-backend",
    "postgres-memory-regression",
    "frontend-native-continuity",
    "source-recheck",
]
STEPS = {
    "Require main workflow dispatch",
    "Require governed production actor",
    "Admit exact PLG source before checkout",
    "Checkout admitted source",
    "Scan exact source changes for secrets",
    "Verify exact source DCO signoffs",
    "Install locked source Python environment",
    "Prepare native PostgreSQL prerequisites",
    "Run full canonical source backend manifest",
    "Verify executed PostgreSQL case and backend reports",
    "Recheck exact source and record validation receipt",
    "Upload exact source validation receipt",
}


def qualify_run(run: dict, *, run_id: int, allowed: set[str]) -> None:
    require(
        type(run.get("id")) is int
        and run["id"] == run_id
        and run.get("path") == WORKFLOW
        and run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == "main"
        and run.get("repository", {}).get("full_name") == transport.REPOSITORY
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and type(run.get("run_attempt")) is int
        and run["run_attempt"] > 0
        and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")) is not None
        and run.get("actor", {}).get("login") in allowed
        and run.get("triggering_actor", {}).get("login") in allowed,
        "PLG source validation is not an authorized successful main dispatch",
    )


def qualify_jobs(inventory: dict, run: dict) -> None:
    jobs = inventory.get("jobs")
    require(
        type(inventory.get("total_count")) is int
        and inventory["total_count"] == 1
        and isinstance(jobs, list)
        and len(jobs) == 1,
        "PLG validation job inventory is incomplete or ambiguous",
    )
    job = jobs[0]
    require(
        job.get("run_id") == run["id"]
        and job.get("head_sha") == run["head_sha"]
        and job.get("name") == GATE
        and job.get("status") == "completed"
        and job.get("conclusion") == "success",
        "The exact PLG source validation gate did not pass",
    )
    steps = job.get("steps") or []
    for name in STEPS:
        matches = [step for step in steps if step.get("name") == name]
        require(
            len(matches) == 1
            and matches[0].get("status") == "completed"
            and matches[0].get("conclusion") == "success",
            "A required PLG validation step did not execute successfully",
        )


def qualify_receipt(receipt: dict, record: dict, run: dict, digest: str) -> None:
    fixed = {
        "schemaVersion": 1,
        "status": "passed",
        "candidateSha": record["sourceSha"],
        "baselineSha": record["baselineSha"],
        "workflowSha": run["head_sha"],
        "recordSha256": digest,
        "repository": transport.REPOSITORY,
        "runId": run["id"],
        "runAttempt": run["run_attempt"],
        "checks": CHECKS,
        "postgresRegression": {
            "path": authority.SOURCE_TEST,
            "passed": 1,
            "failed": 0,
            "skipped": 0,
        },
    }
    require(
        isinstance(receipt, dict)
        and set(receipt) == {*fixed, "backendTests"}
        and all(
            type(receipt[key]) is type(value) and receipt[key] == value
            for key, value in fixed.items()
        ),
        "PLG receipt does not bind the recorded source and exact attempt",
    )
    # bool is not an integer count. A skipped DB case cannot qualify this source.
    pg = receipt["postgresRegression"]
    require(
        all(type(pg[key]) is int for key in ("passed", "failed", "skipped")),
        "PLG PostgreSQL execution counts are invalid",
    )
    tests = receipt["backendTests"]
    require(
        isinstance(tests, dict)
        and set(tests) == {"passed", "failed", "errors", "skipped"}
        and all(type(value) is int for value in tests.values())
        and tests["passed"] > 0
        and tests["failed"] == 0
        and tests["errors"] == 0
        and tests["skipped"] >= 0,
        "The full backend manifest did not pass",
    )


def select_artifact(inventory: dict, run: dict) -> dict:
    artifacts = inventory.get("artifacts")
    require(
        isinstance(artifacts, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(artifacts)
        and len(artifacts) <= 100,
        "PLG validation artifact inventory is incomplete",
    )
    name = f"plg-source-validation-{run['id']}-{run['run_attempt']}"
    matches = [item for item in artifacts if item.get("name") == name]
    require(len(matches) == 1, "The exact-attempt PLG artifact is missing or ambiguous")
    artifact = matches[0]
    require(
        artifact.get("expired") is False
        and type(artifact.get("id")) is int
        and artifact["id"] > 0
        and artifact.get("workflow_run", {}).get("id") == run["id"]
        and type(artifact.get("size_in_bytes")) is int
        and 0 < artifact["size_in_bytes"] <= transport.MAX_BYTES
        and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest", ""))
        is not None,
        "PLG artifact integrity, run identity or retention is invalid",
    )
    return artifact


def _qualify_definition(run: dict, record_digest: str) -> None:
    authority._git("merge-base", "--is-ancestor", run["head_sha"], "origin/main")
    for path in AUTHORITY_PATHS:
        expected = (
            record_digest
            if path == RECORD_PATH
            else hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
        )
        content = authority._git("show", f"{run['head_sha']}:{path}")
        require(
            hashlib.sha256(content).hexdigest() == expected,
            "Hosted PLG validation used different reviewed authority",
        )


def verify(run_id: int, sha: str, github=None) -> dict:
    require(
        type(run_id) is int and run_id > 0, "An exact PLG validation run is required"
    )
    record = authority.qualify_source(sha)
    digest = hashlib.sha256(authority.RECORD.read_bytes()).hexdigest()
    policy = json.loads((ROOT / "config/ci-governance.json").read_text())
    allowed = set(policy["production"]["manual_dispatch_users"])
    client = github or transport.GitHub()
    path = f"runs/{run_id}"
    run = client.read(path)
    qualify_run(run, run_id=run_id, allowed=allowed)
    _qualify_definition(run, digest)
    qualify_jobs(
        client.read(f"{path}/attempts/{run['run_attempt']}/jobs?per_page=100"), run
    )
    artifact = select_artifact(client.read(f"{path}/artifacts?per_page=100"), run)
    receipt = transport.unpack(
        client.read(f"artifacts/{artifact['id']}/zip", binary=True), artifact["digest"]
    )
    qualify_receipt(receipt, record, run, digest)
    client.cache.pop(path, None)
    current = client.read(path)
    qualify_run(current, run_id=run_id, allowed=allowed)
    require(
        all(
            current.get(key) == run.get(key)
            for key in ("run_attempt", "head_sha", "updated_at")
        ),
        "PLG validation changed during admission",
    )
    return {
        "status": "validated",
        "scope": "plg-only-source",
        "trafficAuthorized": False,
        "sourceSha": sha,
        "workflowSha": run["head_sha"],
        "recordSha256": digest,
        "runId": run_id,
        "runAttempt": run["run_attempt"],
        "artifactId": artifact["id"],
        "artifactDigest": artifact["digest"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify(args.run_id, args.sha)
    except Exception:
        parser.exit(1, "Exact PLG source validation could not be proved\n")
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(
        "Exact PLG source checks verified; no deployment or traffic authority granted"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
