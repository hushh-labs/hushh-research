"""Verify a Main-owned W2 frontend validation receipt; never authorize traffic."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/ci"))
import github_security_authority as security_authority  # noqa: E402
import github_security_receipt as security_receipt  # noqa: E402


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError("PLG validation authority unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


source = _load(
    "plg_frontend_source_authority", Path(__file__).with_name("frontend_source.py")
)
transport = _load(
    "plg_frontend_validation_transport",
    ROOT / "scripts/ci/verify-predecessor-acceptance.py",
)
require = source.require
Refused = source.Refused
REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/validate-plg-frontend-source.yml"
WORKFLOW_NAME = "validate-plg-frontend-source.yml"
TITLE = f"PLG frontend source {source.SOURCE_SHA}"
GATE = "PLG Frontend Source Validation Gate"
PAGE_SIZE = 100
MAX_RUNS = 2000
CHECKS = [
    "source-identity",
    "protected-security",
    "source-secret-scan",
    "source-dco",
    "canonical-web-core",
    "back-hierarchy",
    "plg-privacy-account",
    "source-recheck",
]
JOB_STEPS = {
    "Admit PLG frontend source": {
        "Require Main workflow dispatch",
        "Checkout Main authority",
        "Require governed production actors",
        "Install locked authority Python",
        "Run authority contract tests",
        "Fetch pinned frontend source",
        "Verify source and protected security",
        "Scan source changes for secrets",
        "Verify source DCO signoffs",
        "Upload admission receipt",
    },
    "Verify frontend candidate": {
        "Checkout pinned frontend source",
        "Verify source checkout",
        "Set up Node 24",
        "Set up Python 3.13",
        "Run canonical web core",
        "Run Back hierarchy",
        "Run PLG privacy and account tests",
        "Write test report",
        "Verify source after tests",
        "Upload frontend test report",
    },
    GATE: {
        "Checkout Main authority",
        "Require successful predecessors",
        "Fetch pinned frontend source",
        "Recheck source and protected security",
        "Upload source validation receipt",
    },
}
AUTHORITY_PATHS = (
    WORKFLOW,
    "deploy/plg/frontend_validation.py",
    "deploy/plg/frontend_source.py",
    "deploy/plg/frontend-source.json",
    "deploy/plg/release_source.py",
    "deploy/plg/production-source.json",
    ".github/workflows/ci-security.yml",
    "scripts/ci/github_security_authority.py",
    "scripts/ci/github_security_receipt.py",
    "scripts/ci/verify-predecessor-acceptance.py",
    "scripts/ci/release_acceptance_provenance.py",
    "scripts/ci/assert-governed-actor.py",
    "scripts/ci/check-dco-signoff.sh",
    "config/ci-governance.json",
    ".gitleaks.toml",
    "consent-protocol/.github/actions/setup-python-uv/action.yml",
    "consent-protocol/scripts/sync_runtime_requirements.sh",
    "consent-protocol/pyproject.toml",
    "consent-protocol/uv.lock",
    "consent-protocol/tests/test_plg_frontend_source.py",
    "consent-protocol/tests/test_plg_frontend_validation.py",
    "consent-protocol/tests/test_plg_release_source.py",
)


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _same_json(left: object, right: object) -> bool:
    try:
        return json.dumps(
            left, sort_keys=True, separators=(",", ":"), allow_nan=False
        ) == json.dumps(right, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError):
        return False


def authority_hashes() -> dict[str, str]:
    result = {}
    for path in AUTHORITY_PATHS:
        raw = (ROOT / path).read_bytes()
        require(
            len(raw) <= 2 * 1024 * 1024,
            "Frontend validation authority file exceeds its bound",
        )
        result[path] = hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()
    return result


def qualify_definition(workflow_sha: str, hashes: dict[str, str]) -> None:
    require(
        re.fullmatch(r"[0-9a-f]{40}", workflow_sha) is not None,
        "Invalid frontend workflow SHA",
    )
    source.backend._git("merge-base", "--is-ancestor", workflow_sha, "origin/main")
    require(hashes == authority_hashes(), "Frontend validation authority changed")
    for path, expected in hashes.items():
        tested = source.backend._git("show", f"{workflow_sha}:{path}")
        current = source.backend._git("show", f"origin/main:{path}")
        require(
            hashlib.sha256(tested).hexdigest() == expected and tested == current,
            "Frontend hosted validation used different reviewed authority",
        )


def _timestamp(value: object) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise Refused("Frontend validation run timestamp is invalid") from None
    require(
        parsed.tzinfo is not None, "Frontend validation run timestamp lacks a timezone"
    )
    return parsed


def _inventory(read, base: str) -> list[dict]:
    """Read every page or refuse; no older green run may hide beyond page one."""
    result = []
    total = None
    for page in range(1, MAX_RUNS // PAGE_SIZE + 1):
        document = read(f"{base}&per_page={PAGE_SIZE}&page={page}")
        rows = document.get("workflow_runs") if isinstance(document, dict) else None
        count = document.get("total_count") if isinstance(document, dict) else None
        require(
            type(count) is int and 0 <= count <= MAX_RUNS and isinstance(rows, list),
            "Run inventory is invalid",
        )
        if total is None:
            total = count
        require(
            count == total and len(rows) <= PAGE_SIZE,
            "Run inventory changed during pagination",
        )
        result.extend(rows)
        if len(result) >= total:
            break
    require(total is not None and len(result) == total, "Run inventory is incomplete")
    require(
        all(isinstance(row, dict) and _positive(row.get("id")) for row in result),
        "Invalid workflow run",
    )
    require(len({row["id"] for row in result}) == len(result), "Duplicate workflow run")
    return result


def _matching_runs(rows: list[dict], title: str) -> list[dict]:
    matches = [row for row in rows if row.get("display_title") == title]
    for row in matches:
        require(
            type(row.get("run_attempt")) is int and row["run_attempt"] > 0,
            "Invalid workflow attempt",
        )
        _timestamp(row.get("updated_at"))
    return sorted(
        matches,
        key=lambda row: (_timestamp(row["updated_at"]), row["id"], row["run_attempt"]),
        reverse=True,
    )


def _run_identity(run: dict) -> tuple:
    return tuple(
        run.get(key)
        for key in (
            "id",
            "run_attempt",
            "head_sha",
            "status",
            "conclusion",
            "updated_at",
        )
    )


def verify_security(run_id: int, attempt: int, sha: str, api=None) -> dict:
    """Recheck the newest protected worker for this exact CI source attempt."""
    require(
        type(run_id) is int and run_id > 0 and type(attempt) is int and attempt > 0,
        "Invalid security source identity",
    )
    require(
        sha == source.SOURCE_SHA, "Security source is not the pinned frontend candidate"
    )
    client = api or security_authority.GitHub(
        REPOSITORY, os.environ.get("GH_TOKEN", "")
    )
    expected = {"run_id": run_id, "attempt": attempt, "head_sha": sha}
    try:
        verified_source = security_authority.verify_source(
            client.read, REPOSITORY, expected
        )
        root = f"repos/{REPOSITORY}/actions"
        workflow = client.read(f"{root}/workflows/ci-security.yml")
        query = f"{root}/workflows/ci-security.yml/runs?branch=main"
        title = f"Security alerts for {run_id} / {attempt} / {sha}"
        matches = _matching_runs(_inventory(client.read, query), title)
        require(bool(matches), "Protected security worker is missing")
        newest = matches[0]
        require(
            newest.get("status") == "completed"
            and newest.get("conclusion") == "success",
            "Latest security worker is not successful",
        )
        receipt = None
        for run in matches:
            require(
                run.get("status") == "completed" and run.get("conclusion") == "success",
                "Security receipt predecessor is not successful",
            )
            try:
                receipt = security_receipt.consume(
                    client, verified_source, run, workflow
                )
                break
            except security_receipt.MissingReceipt:
                security_receipt.verify_reused_worker(client, run)
        require(isinstance(receipt, dict), "Protected security receipt is missing")
        again = _matching_runs(_inventory(client.read, query), title)
        require(
            bool(again) and _run_identity(again[0]) == _run_identity(newest),
            "Security worker changed during verification",
        )
    except security_authority.Refused:
        raise Refused(
            "Exact protected security receipt could not be verified"
        ) from None
    return {"source": expected, "receiptSha256": _digest(receipt)}


def admission(sha: str, security_run: int, security_attempt: int, api=None) -> dict:
    proof = source.qualify_source(sha)
    security = verify_security(security_run, security_attempt, sha, api=api)
    return {
        "schemaVersion": 1,
        "sourceSha": sha,
        "sourceTree": proof["sourceTree"],
        "baselineSha": proof["baselineSha"],
        "recordSha256": proof["recordSha256"],
        "backendRecordSha256": proof["backendRecordSha256"],
        "security": security,
        "authorityFiles": authority_hashes(),
        "sourceQualified": True,
        "trafficAuthorized": False,
        "environmentAccepted": False,
        "customerSendingAuthorized": False,
    }


def _positive(value: object) -> bool:
    return type(value) is int and value > 0


def qualify_run(
    run: dict, workflow: dict, run_id: int, allowed: set[str], *, completed: bool = True
) -> None:
    repo = run.get("repository") or {}
    head_repo = run.get("head_repository") or {}
    require(
        _positive(run_id)
        and _positive(run.get("id"))
        and run.get("id") == run_id
        and run.get("path") == WORKFLOW
        and run.get("event") == "workflow_dispatch"
        and run.get("head_branch") == "main"
        and run.get("display_title") == TITLE
        and repo.get("full_name") == REPOSITORY
        and head_repo.get("full_name") == REPOSITORY
        and _positive(repo.get("id"))
        and repo.get("id") == head_repo.get("id")
        and _positive(workflow.get("id"))
        and _positive(run.get("workflow_id"))
        and run.get("workflow_id") == workflow.get("id")
        and workflow.get("path") == WORKFLOW
        and _positive(run.get("run_attempt"))
        and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", ""))
        and run.get("actor", {}).get("login") in allowed
        and run.get("triggering_actor", {}).get("login") in allowed,
        "Frontend validation is not a governed Main workflow dispatch",
    )
    if completed:
        require(
            run.get("status") == "completed" and run.get("conclusion") == "success",
            "Frontend validation did not succeed",
        )
    else:
        require(
            run.get("status") == "in_progress", "Frontend validation is not in progress"
        )


def qualify_jobs(inventory: dict, run: dict) -> None:
    jobs = inventory.get("jobs")
    require(
        type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(JOB_STEPS)
        and isinstance(jobs, list)
        and len(jobs) == len(JOB_STEPS),
        "Frontend job inventory is incomplete",
    )
    require(all(isinstance(job, dict) for job in jobs), "Invalid frontend job")
    require(
        {job.get("name") for job in jobs} == set(JOB_STEPS),
        "Frontend job identities changed",
    )
    for job in jobs:
        require(
            _positive(job.get("run_id"))
            and job.get("run_id") == run["id"]
            and job.get("head_sha") == run["head_sha"]
            and job.get("status") == "completed"
            and job.get("conclusion") == "success",
            "Frontend job did not pass",
        )
        steps = job.get("steps") or []
        required = JOB_STEPS[job["name"]]
        selected = [step for step in steps if step.get("name") in required]
        require(
            len(selected) == len(required)
            and {step["name"] for step in selected} == required
            and all(
                step.get("status") == "completed"
                and step.get("conclusion") == "success"
                for step in selected
            ),
            "Frontend required step was missing, duplicated, skipped or failed",
        )


def select_artifact(inventory: dict, run: dict, prefix: str) -> dict:
    rows = inventory.get("artifacts")
    require(
        isinstance(rows, list)
        and type(inventory.get("total_count")) is int
        and inventory["total_count"] == len(rows) <= 100,
        "Frontend artifact inventory is incomplete",
    )
    require(all(isinstance(item, dict) for item in rows), "Invalid frontend artifact")
    name = f"{prefix}-{run['id']}-{run['run_attempt']}"
    matches = [item for item in rows if item.get("name") == name]
    require(len(matches) == 1, "Frontend artifact is missing or ambiguous")
    item = matches[0]
    require(
        item.get("expired") is False
        and _positive(item.get("id"))
        and _positive(item.get("workflow_run", {}).get("id"))
        and item.get("workflow_run", {}).get("id") == run["id"]
        and _positive(item.get("size_in_bytes"))
        and item["size_in_bytes"] <= transport.MAX_BYTES
        and re.fullmatch(r"sha256:[0-9a-f]{64}", item.get("digest", "")) is not None,
        "Frontend artifact integrity is invalid",
    )
    return item


def _artifact(client, inventory: dict, run: dict, prefix: str) -> tuple[dict, dict]:
    item = select_artifact(inventory, run, prefix)
    raw = client.read(f"artifacts/{item['id']}/zip", binary=True)
    require(len(raw) == item["size_in_bytes"], "Frontend artifact size mismatch")
    return item, transport.unpack(raw, item["digest"])


def qualify_test_report(report: dict, sha: str) -> None:
    require(
        report
        == {
            "schemaVersion": 1,
            "sourceSha": sha,
            "back": {"files": 16, "passed": 494, "failed": 0, "pending": 0},
            "privacy": {"files": 4, "passed": 119, "failed": 0, "pending": 0},
        }
        and type(report.get("schemaVersion")) is int
        and all(
            type(value) is int
            for key in ("back", "privacy")
            for value in report[key].values()
        ),
        "Frontend test report is incomplete or not exact-source",
    )


def _receipt(
    run: dict,
    admitted: dict,
    admission_artifact: dict,
    test_artifact: dict,
    report: dict,
) -> dict:
    return {
        "schemaVersion": 1,
        "status": "passed",
        "repository": REPOSITORY,
        "workflowSha": run["head_sha"],
        "sourceSha": admitted["sourceSha"],
        "baselineSha": admitted["baselineSha"],
        "recordSha256": admitted["recordSha256"],
        "backendRecordSha256": admitted["backendRecordSha256"],
        "authorityFiles": admitted["authorityFiles"],
        "security": admitted["security"],
        "runId": run["id"],
        "runAttempt": run["run_attempt"],
        "admissionArtifact": {
            "id": admission_artifact["id"],
            "digest": admission_artifact["digest"],
        },
        "testArtifact": {"id": test_artifact["id"], "digest": test_artifact["digest"]},
        "testReport": report,
        "checks": CHECKS,
        "sourceQualified": True,
        "trafficAuthorized": False,
        "environmentAccepted": False,
        "customerSendingAuthorized": False,
    }


def _allowed_actors() -> set[str]:
    policy = json.loads(
        (ROOT / "config/ci-governance.json").read_text(encoding="utf-8")
    )
    return set(policy["production"]["manual_dispatch_users"])


def finalize(
    run_id: int,
    run_attempt: int,
    sha: str,
    security_run: int,
    security_attempt: int,
    github=None,
    api=None,
) -> dict:
    client = github or transport.GitHub()
    run = client.read(f"runs/{run_id}")
    workflow = client.read(f"workflows/{WORKFLOW_NAME}")
    qualify_run(run, workflow, run_id, _allowed_actors(), completed=False)
    require(
        run["run_attempt"] == run_attempt
        and run["head_sha"] == os.environ.get("GITHUB_SHA"),
        "Frontend workflow identity changed",
    )
    current = admission(sha, security_run, security_attempt, api=api)
    qualify_definition(run["head_sha"], current["authorityFiles"])
    inventory = client.read(f"runs/{run_id}/artifacts?per_page=100")
    admission_item, recorded = _artifact(
        client, inventory, run, "plg-frontend-admission"
    )
    require(
        _same_json(recorded, current),
        "Frontend source or protected security changed after admission",
    )
    test_item, report = _artifact(client, inventory, run, "plg-frontend-tests")
    qualify_test_report(report, sha)
    return _receipt(run, current, admission_item, test_item, report)


def _latest(client, sha: str) -> dict:
    query = f"workflows/{WORKFLOW_NAME}/runs?branch=main&event=workflow_dispatch"
    for key in list(client.cache):
        if key.startswith(query):
            client.cache.pop(key, None)
    matches = _matching_runs(
        _inventory(client.read, query), f"PLG frontend source {sha}"
    )
    require(bool(matches), "Frontend validation run is missing")
    return matches[0]


def verify(run_id: int, sha: str, github=None, api=None) -> dict:
    require(
        _positive(run_id) and sha == source.SOURCE_SHA,
        "Exact frontend validation source and run required",
    )
    client = github or transport.GitHub()
    latest = _latest(client, sha)
    require(latest.get("id") == run_id, "A newer frontend validation attempt exists")
    run = client.read(f"runs/{run_id}")
    workflow = client.read(f"workflows/{WORKFLOW_NAME}")
    qualify_run(run, workflow, run_id, _allowed_actors())
    require(
        _run_identity(latest) == _run_identity(run),
        "Frontend validation inventory changed",
    )
    qualify_jobs(
        client.read(f"runs/{run_id}/attempts/{run['run_attempt']}/jobs?per_page=100"),
        run,
    )
    inventory = client.read(f"runs/{run_id}/artifacts?per_page=100")
    final_item, recorded = _artifact(
        client, inventory, run, "plg-frontend-source-validation"
    )
    admission_item, admitted = _artifact(
        client, inventory, run, "plg-frontend-admission"
    )
    test_item, report = _artifact(client, inventory, run, "plg-frontend-tests")
    security_source = admitted.get("security", {}).get("source", {})
    current = admission(
        sha, security_source.get("run_id"), security_source.get("attempt"), api=api
    )
    qualify_definition(run["head_sha"], current["authorityFiles"])
    require(
        _same_json(admitted, current), "Frontend admission is stale or does not match"
    )
    qualify_test_report(report, sha)
    require(
        _same_json(recorded, _receipt(run, current, admission_item, test_item, report)),
        "Frontend validation receipt does not match",
    )
    client.cache.pop(f"runs/{run_id}", None)
    require(
        _run_identity(client.read(f"runs/{run_id}")) == _run_identity(run)
        and _run_identity(_latest(client, sha)) == _run_identity(run),
        "Frontend validation changed during verification",
    )
    return {
        "status": "validated",
        "scope": "plg-frontend-source",
        "sourceSha": sha,
        "runId": run_id,
        "runAttempt": run["run_attempt"],
        "artifactId": final_item["id"],
        "artifactDigest": final_item["digest"],
        "trafficAuthorized": False,
        "environmentAccepted": False,
        "customerSendingAuthorized": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("admit", "finalize", "verify"))
    parser.add_argument("--sha", required=True)
    parser.add_argument("--security-run", type=int)
    parser.add_argument("--security-attempt", type=int)
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--run-attempt", type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.mode == "admit":
            result = admission(args.sha, args.security_run, args.security_attempt)
        elif args.mode == "finalize":
            result = finalize(
                args.run_id,
                args.run_attempt,
                args.sha,
                args.security_run,
                args.security_attempt,
            )
        else:
            result = verify(args.run_id, args.sha)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )
    except Exception:
        parser.exit(1, "Exact PLG frontend validation could not be proved\n")
    print(
        "Exact frontend source proof recorded; no environment or traffic authority granted"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
