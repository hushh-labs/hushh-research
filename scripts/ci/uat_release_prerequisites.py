#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Owner: platform. Read-only UAT preparation and early exact-CI input validation.

This composes the existing exact-source verifier. Inspection never dispatches
CI, publishes acceptance, or changes cloud resources. Deployment rechecks every
source, security, current-attempt and live-base gate under its existing lock.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

import uat_exact_ci as exact
from github_security_authority import GitHub, Refused


def validate_inspection(inputs: dict) -> None:
    allowed = {"operation": "inspect", "target": "shared-uat", "scope": "auto",
               "backend_image_source": "auto"}
    if not isinstance(inputs, dict):
        raise Refused("Inspection inputs are malformed")
    for key, value in inputs.items():
        if key in allowed:
            if value != allowed[key]:
                raise Refused("Inspection accepts only the default target and scope")
        elif value not in (None, "", False, "false"):
            raise Refused("Inspection accepts no application, qualification or release overrides")


def validate_pins(sha: str, run: str, attempt: str, base: str) -> tuple[int, int]:
    values = {"ci_run_id": run, "ci_run_attempt": attempt, "ci_base_sha": base}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise Refused("UAT deployment requires " + ", ".join(missing)
                      + "; run Deploy to UAT with operation=inspect for Actions-only instructions")
    if not (exact.SHA.fullmatch(sha or "") and exact.SHA.fullmatch(base or "")
            and re.fullmatch(r"[1-9][0-9]{0,19}", run)
            and re.fullmatch(r"[1-9][0-9]{0,5}", attempt)):
        raise Refused("UAT qualification pins require full SHAs and positive run/attempt integers")
    return int(run), int(attempt)


def validate_deployment(api, sha: str, run: str, attempt: str, base: str) -> None:
    run_id, number = validate_pins(sha, run, attempt, base)
    exact.require_protected_tip(api, sha)
    exact.verify_attempt(api, sha, base, run_id, number)
    exact.require_protected_tip(api, sha)


def git_identity(*args: str) -> str:
    value = exact.git(*args).decode().strip()
    if not exact.SHA.fullmatch(value):
        raise Refused("UAT approved PR Git identity could not be established")
    return value


def verify_approved_scope(api, sha: str, base: str, approval: str, *, read_live=None) -> None:
    """Bind the governed dispatch to an ordered PR chain and both serving bases."""
    match = re.fullmatch(
        r"([0-9a-f]{40}):([0-9a-f]{40}):"
        r"([1-9][0-9]{0,9}=[0-9a-f]{40}(?:,[1-9][0-9]{0,9}=[0-9a-f]{40}){0,9})",
        approval,
    )
    if not match or not exact.SHA.fullmatch(sha) or not exact.SHA.fullmatch(base):
        raise Refused("UAT requires an explicit candidate and approved_scope BACKEND:FRONTEND:PR=HEAD[,PR=HEAD]")
    backend, frontend, approvals = match.groups()
    if base not in (backend, frontend):
        raise Refused("The qualified UAT base is absent from the approved service bases")
    prior = base
    seen = set()
    for item in approvals.split(","):
        number, head = item.split("=")
        if number in seen:
            raise Refused("The approved UAT PR chain repeats a pull request")
        seen.add(number)
        pr = api.read(f"repos/{exact.REPOSITORY}/pulls/{number}")
        if not (
            isinstance(pr, dict)
            and pr.get("merged") is True
            and exact.SHA.fullmatch(pr.get("merge_commit_sha") or "")
            and (pr.get("head") or {}).get("sha") == head
            and (pr.get("base") or {}).get("ref") == "uat"
            and ((pr.get("base") or {}).get("repo") or {}).get("full_name") == exact.REPOSITORY
        ):
            raise Refused("UAT scope does not identify an approved head's landed release PR")
        landed = pr["merge_commit_sha"]
        parent = git_identity("rev-parse", f"{landed}^1")
        comparison = git_identity("merge-base", "--all", parent, head)
        # Compare complete trees, including modes, generated files and removals.
        tree = git_identity("rev-parse", f"{prior}^{{tree}}")
        if (git_identity("rev-parse", f"{comparison}^{{tree}}") != tree
                or git_identity("rev-parse", f"{head}^{{tree}}")
                != git_identity("rev-parse", f"{landed}^{{tree}}")):
            raise Refused("UAT candidate contains changes outside the approved PR delta against the serving base")
        prior = landed
    if prior != sha:
        raise Refused("UAT candidate is not the last approved PR merge")
    if read_live is not None:
        serving = read_live("all")
        if any(serving.get(name, {}).get("sha") != expected for name, expected in
               (("backend", backend), ("frontend", frontend))):
            raise Refused("UAT serving revisions changed after scope approval; compare and approve again")
    print(f"UAT scope approved: {approvals}, backend base {backend}, frontend base {frontend}")


def latest_attempt(api, candidate: str) -> dict:
    """Return diagnostics only; canonical verification below decides eligibility."""
    prefix = f"repos/{exact.REPOSITORY}/actions"
    rows = api.read(f"{prefix}/workflows/ci.yml/runs?branch=uat&event=workflow_dispatch"
                    f"&head_sha={candidate}&per_page=100")
    if not isinstance(rows, dict):
        raise Refused("CI run inventory is malformed")
    runs = rows.get("workflow_runs")
    if not (isinstance(runs, list) and type(rows.get("total_count")) is int
            and rows["total_count"] == len(runs) <= 100):
        raise Refused("No complete exact-source CI inventory is available")
    if not runs:
        return {}
    attempts = []
    for run in runs:
        if not (isinstance(run, dict) and type(run.get("id")) is int and run["id"] > 0
                and type(run.get("run_attempt")) is int and run["run_attempt"] > 0):
            raise Refused("CI attempt identity is unavailable")
        attempts.append(api.read(f"{prefix}/runs/{run['id']}/attempts/{run['run_attempt']}"))
    if not all(isinstance(run, dict) for run in attempts):
        raise Refused("CI attempt metadata is malformed")
    return attempts[0] if len(attempts) == 1 else max(attempts, key=exact._started)


def qualify_inspection(api, result: dict) -> None:
    """Offer pins only through current canonical admission; diagnose without rerunning."""
    try:
        run = latest_attempt(api, result["candidate_sha"])
        if not run:
            result["reason_code"] = "qualification_missing"
            return
        result.update(ci_run_id=run["id"], ci_run_attempt=run["run_attempt"],
                      ci_status=run.get("status"), ci_conclusion=run.get("conclusion"))
        if run.get("status") in {"queued", "in_progress", "waiting", "requested", "pending"}:
            result["reason_code"] = "qualification_in_flight"
            return
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            result["reason_code"] = "qualification_failed"
            return
        prefix = f"repos/{exact.REPOSITORY}/actions"
        inventory = api.read(f"{prefix}/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100")
        jobs = inventory.get("jobs") if isinstance(inventory, dict) else None
        if not (isinstance(jobs, list) and all(isinstance(job, dict) for job in jobs)
                and type(inventory.get("total_count")) is int
                and inventory["total_count"] == len(jobs) <= 100):
            raise Refused("CI job inventory is malformed")
        names = [job.get("name", "") for job in jobs]
        if not any(isinstance(name, str) and name.startswith("Exact UAT Candidate")
                   and name != "Exact UAT Candidate ()" for name in names):
            result["reason_code"] = "qualification_missing"
            return
        published = [name for name in names if isinstance(name, str) and
                     re.fullmatch(r"Exact UAT Candidate \([0-9a-f]{40}\)", name)]
        if (len(published) == 1 and "Exact UAT Candidate" not in names
                and published[0] != f"Exact UAT Candidate ({result['base_sha']})"):
            result["reason_code"] = "qualification_base_changed"
            return
        static = [job for job in jobs if job.get("name") == "Exact UAT Candidate"]
        if static and not exact._static_candidate_base_is_bound(static[0], result["base_sha"]):
            result["reason_code"] = "qualification_base_unpublished"
            return
        job = exact._exact_candidate_job(jobs, result["base_sha"])
        if job.get("name") not in {
            "Exact UAT Candidate",
            f"Exact UAT Candidate ({result['base_sha']})",
        }:
            result["reason_code"] = "qualification_base_unpublished"
            return
        exact.verify_attempt(api, result["candidate_sha"], result["base_sha"],
                             run["id"], run["run_attempt"])
        result.update(ready=True, reason_code="qualified_current_ci")
    except (Refused, KeyError, TypeError):
        result["reason_code"] = "qualification_unverified"


def inspect(api, authority: str, *, read_live=None) -> dict:
    read_live = read_live or exact.live_serving_bases
    branch = api.read(f"repos/{exact.REPOSITORY}/branches/uat")
    candidate = branch.get("commit", {}).get("sha", "")
    if not all(exact.SHA.fullmatch(value) for value in (candidate, authority)):
        raise Refused("Protected UAT source or Main workflow identity is unavailable")
    exact.require_protected_tip(api, candidate)
    serving = read_live("all")
    base = serving.get("backend", {}).get("sha", "")
    exact.verify_serving_bases(base, "all", base, serving.get("frontend", {}).get("sha", ""))
    result = {"kind": "uat-prerequisite-inspection", "ready": False,
              "candidate_sha": candidate, "base_sha": base,
              "authority_sha": authority, "serving": serving,
              "reason_code": "qualification_unverified"}
    exact.verify_git_authority(candidate, base, authority)
    qualify_inspection(api, result)
    exact.require_protected_tip(api, candidate)
    if read_live("all") != serving:
        raise Refused("UAT serving state changed during inspection; inspect again")
    return result


def render(result: dict) -> str:
    lines = ["## UAT prerequisites (read-only; no deployment)",
             f"- Protected UAT application: `{result['candidate_sha']}`",
             f"- Observed serving base: `{result['base_sha']}`",
             f"- Main workflow authority: `{result['authority_sha']}`"]
    if result["ready"]:
        lines += ["- Current exact-source CI passed. Deploy from Main with:",
                  f"  - `sha={result['candidate_sha']}`",
                  f"  - `ci_run_id={result['ci_run_id']}`",
                  f"  - `ci_run_attempt={result['ci_run_attempt']}`",
                  f"  - `ci_base_sha={result['base_sha']}`", "  - `scope=auto`"]
    elif result["reason_code"] in {"qualification_missing", "qualification_base_unpublished", "qualification_base_changed"}:
        lines += ["- Qualification is required. In Actions → PR Validation → Run workflow:",
                  "  - Branch: `uat`; scope: `all`",
                  f"  - `uat_base_sha={result['base_sha']}`",
                  "- Wait for success, then run this inspection again."]
    else:
        code = result["reason_code"]
        messages = {
            "qualification_in_flight": "Wait for the existing CI run; do not dispatch a replacement.",
            "qualification_failed": "Inspect the current CI failure, fix it and rerun the failed checks.",
            "qualification_unverified": "CI could not be qualified. Retry inspection; inspect the current run before starting new CI.",
        }
        lines += ["- " + messages[code]]
    if result.get("ci_run_id"):
        lines += [f"- Current CI: https://github.com/{exact.REPOSITORY}/actions/runs/{result['ci_run_id']} (attempt {result['ci_run_attempt']})"]
    lines += ["- Inspection grants no deployment authority. Deployment repeats all gates under its lock."]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("validate-inspection", "inspect", "validate-deployment", "validate-scope-live"))
    parser.add_argument("--authority-sha", default="")
    parser.add_argument("--sha", default="")
    parser.add_argument("--ci-run-id", default="")
    parser.add_argument("--ci-attempt", default="")
    parser.add_argument("--base-sha", default="")
    parser.add_argument("--approved-scope", default="")
    args = parser.parse_args()
    try:
        if args.mode == "validate-inspection":
            validate_inspection(json.loads(os.environ.get("WORKFLOW_INPUTS", "{}")))
            return 0
        api = GitHub(exact.REPOSITORY, os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", ""))
        if args.mode == "validate-deployment":
            verify_approved_scope(api, args.sha, args.base_sha, args.approved_scope)
            validate_deployment(api, args.sha, args.ci_run_id, args.ci_attempt, args.base_sha)
        elif args.mode == "validate-scope-live":
            verify_approved_scope(api, args.sha, args.base_sha, args.approved_scope,
                                  read_live=exact.live_serving_bases)
        else:
            result = inspect(api, args.authority_sha)
            print(json.dumps(result, sort_keys=True))
            if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
                with Path(summary).open("a") as output:
                    output.write(render(result))
        return 0
    except (Refused, ValueError, OSError) as error:
        # Local validation errors contain fixed prose and field names only.
        # Cloud/API error payloads are intentionally excluded.
        message = str(error) if isinstance(error, Refused) else "UAT prerequisite inspection unavailable; verify protected source, Main authority and read-only serving access"
        print(message)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
