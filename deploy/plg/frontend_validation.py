"""Verify a Main-owned fixed frontend validation receipt; never authorize traffic."""

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


contract = _load(
    "plg_frontend_validation_contract",
    Path(__file__).with_name("frontend_validation_contract.py"),
)
source = contract.source
transport = _load(
    "plg_frontend_validation_transport",
    ROOT / "scripts/ci/verify-predecessor-acceptance.py",
)
require = source.require
Refused = source.Refused
REPOSITORY, WORKFLOW, WORKFLOW_NAME = (
    contract.REPOSITORY,
    contract.WORKFLOW,
    contract.WORKFLOW_NAME,
)
TITLE, GATE, JOB_STEPS = contract.TITLE, contract.GATE, contract.JOB_STEPS
_same_json, _positive = contract._same_json, contract._positive
qualify_run, qualify_jobs = contract.qualify_run, contract.qualify_jobs
qualify_test_report, _receipt = contract.qualify_test_report, contract._receipt
PAGE_SIZE = 100
MAX_RUNS = 2000

AUTHORITY_PATHS = (
    WORKFLOW,
    "deploy/plg/frontend_validation.py",
    "deploy/plg/frontend_validation_contract.py",
    "deploy/plg/frontend_source.py",
    "deploy/plg/frontend-source.json",
    "deploy/plg/release_source.py",
    "deploy/plg/production-source.json",
    ".github/workflows/ci-security.yml",
    "scripts/ci/github_security_authority.py",
    "scripts/ci/github_security_receipt.py",
    "scripts/ci/verify-predecessor-acceptance.py",
    "scripts/ci/process_group.py",
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


def select_artifact(inventory: dict, run: dict, prefix: str) -> dict:
    return contract.select_artifact(inventory, run, prefix, transport.MAX_BYTES)


def _artifact(client, inventory: dict, run: dict, prefix: str) -> tuple[dict, dict]:
    item = select_artifact(inventory, run, prefix)
    raw = client.read(f"artifacts/{item['id']}/zip", binary=True)
    require(len(raw) == item["size_in_bytes"], "Frontend artifact size mismatch")
    return item, transport.unpack(raw, item["digest"])


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
