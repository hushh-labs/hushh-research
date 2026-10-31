"""Fail-closed exact-head CI admission for the existing operator CLI.

The canonical Admin SOP still owns review, protection and merge authority. This
module is a read-only CI preflight, and never performs a merge or deployment.
"""

from __future__ import annotations

import re
from typing import Any


def _parse_details_url(value):
    match = re.fullmatch(
        r"https://github\.com/hushh-labs/hushh-research/actions/runs/(\d+)/job/(\d+)", value or ""
    )
    return (match.group(1), match.group(2)) if match else (None, None)


def require_successful_head(
    pr: dict[str, Any], *, expected_sha: str, required_contexts: set[str], run: dict[str, Any]
) -> None:
    """Exact-head admission for operators; monitoring alone grants no merge authority."""
    if not re.fullmatch(r"[0-9a-f]{40}", expected_sha) or pr.get("headRefOid") != expected_sha:
        raise RuntimeError("PR head changed or expected SHA is invalid")
    if (
        pr.get("state") != "OPEN"
        or pr.get("isDraft") is not False
        or pr.get("mergeable") != "MERGEABLE"
    ):
        raise RuntimeError("PR is not an open, non-draft, mergeable candidate")
    if not required_contexts or "CI Status Gate" not in required_contexts:
        raise RuntimeError("Required-check policy is missing its aggregate authority")
    if (
        run.get("headSha") != expected_sha
        or run.get("name") != "PR Validation"
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
    ):
        raise RuntimeError("The current exact-source PR validation attempt did not succeed")
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for check in pr.get("statusCheckRollup", []):
        name, workflow = check.get("name"), check.get("workflowName")
        if not name or not workflow or not check.get("startedAt"):
            raise RuntimeError("Malformed or unbound check evidence")
        key = workflow, name
        if key not in latest or check["startedAt"] >= latest[key]["startedAt"]:
            latest[key] = check
    names = {check["name"] for check in latest.values()}
    if not latest or required_contexts - names:
        raise RuntimeError("Required check evidence is absent")
    for check in latest.values():
        if check.get("status") != "COMPLETED":
            raise RuntimeError("Required or auxiliary work is still pending")
        conclusion = check.get("conclusion")
        intentional_skip = (
            conclusion == "SKIPPED"
            and check["name"] not in required_contexts
            and check["workflowName"] == "PR Validation"
        )
        if conclusion != "SUCCESS" and not intentional_skip:
            raise RuntimeError("Required or auxiliary work did not succeed")
    gate = latest.get(("PR Validation", "CI Status Gate"))
    if gate is None or _parse_details_url(gate.get("detailsUrl"))[0] != str(run.get("databaseId")):
        raise RuntimeError("Aggregate check does not bind the successful source run")


def preflight(
    pr_number: int | None, branch: str | None, expected_sha: str, *, resolve_pr, gh_json
) -> dict[str, Any]:
    from ci_rerun import REPOSITORY, verify_gate_job, verify_source

    pr = resolve_pr(pr_number, branch)
    protection = gh_json(
        ["api", f"repos/hushh-labs/hushh-research/branches/{pr['baseRefName']}/protection"]
    )
    status = protection.get("required_status_checks") or {}
    required = set(status.get("contexts") or ()) | {
        item["context"] for item in status.get("checks", [])
    }
    checks = [
        c
        for c in pr.get("statusCheckRollup", [])
        if c.get("workflowName") == "PR Validation" and c.get("name") == "CI Status Gate"
    ]
    if not checks:
        raise RuntimeError("PR validation aggregate has not been reported")
    gate = max(checks, key=lambda c: c.get("startedAt") or "")
    run_id, job_id = _parse_details_url(gate.get("detailsUrl"))
    if not run_id or not job_id:
        raise RuntimeError("PR validation source run is not bound")
    run = gh_json(
        ["run", "view", run_id, "--json", "databaseId,headSha,name,status,conclusion,attempt"]
    )
    require_successful_head(pr, expected_sha=expected_sha, required_contexts=required, run=run)
    def read(path: str) -> Any:
        return gh_json(["api", path])
    expected = {"run_id": int(run_id), "attempt": run["attempt"], "head_sha": expected_sha}
    source = verify_source(read, REPOSITORY, expected)
    if source["event"] != "pull_request":
        raise RuntimeError("Only canonical PR validation can satisfy PR admission")
    verify_gate_job(read, source, int(job_id))
    job = read(f"repos/{REPOSITORY}/actions/jobs/{job_id}")
    if job.get("conclusion") != "success":
        raise RuntimeError("The exact-attempt gate did not succeed")
    current = read(f"repos/{REPOSITORY}/actions/runs/{run_id}")
    if any(
        current.get(key) != value
        for key, value in {
            "id": int(run_id),
            "run_attempt": run["attempt"],
            "head_sha": expected_sha,
            "status": "completed",
            "conclusion": "success",
        }.items()
    ):
        raise RuntimeError("PR validation changed during verification")
    # A fresh head read immediately before handing authority back to the operator.
    if resolve_pr(pr["number"], None).get("headRefOid") != expected_sha:
        raise RuntimeError("PR head changed during verification")
    return {
        "pr": pr["number"],
        "head": expected_sha,
        "run": run_id,
        "attempt": run["attempt"],
        "requiredChecks": sorted(required),
        "status": "verified",
    }
