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
import importlib
import json
import math
import os
import re
import time
from pathlib import Path

import uat_exact_ci as exact
from github_security_authority import GitHub, Refused, positive


SCOPE_DELTA_ERROR = "UAT candidate contains changes outside the approved PR delta against the serving base"


def validate_inspection(inputs: dict) -> None:
    allowed = {"operation": "inspect", "target": "shared-uat", "scope": "auto",
               "backend_image_source": "auto"}
    if not isinstance(inputs, dict):
        raise Refused("Inspection inputs are malformed")
    for key, value in inputs.items():
        if key == "source_branch" and value in exact.SOURCE_BRANCHES:
            continue
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


def require_fresh_email_risk(candidate: str) -> None:
    """Early public-input freshness only; release still validates the full snapshot."""
    enabled = os.environ.get("UAT_EMAIL_AUTH_ENABLED", "false")
    exact.require(enabled in {"true", "false"}, "UAT email-auth enable flag is invalid")
    if enabled == "false":
        return
    exact.require(bool(exact.SHA.fullmatch(candidate)), "Exact UAT email-risk source is required")
    try:
        raw = exact.git("show", f"{candidate}:consent-protocol/config/email-auth/risk-manifest.json")
        if len(raw) > 65536:
            raise ValueError("oversized manifest")
        manifest = json.loads(raw)
        expires = manifest.get("expires_at") if isinstance(manifest, dict) else None
        valid = type(expires) in {int, float} and math.isfinite(expires) and expires > time.time()
    except (Refused, ValueError, OverflowError):
        valid = False
    exact.require(valid, "UAT email-risk snapshot is expired or invalid; refresh the pinned upstream "
                  "artifact and qualify the new candidate before deployment")


def validate_deployment(api, sha: str, run: str, attempt: str, base: str, *, branch="uat", authority="") -> None:
    run_id, number = validate_pins(sha, run, attempt, base)
    exact.require_protected_tip(api, sha, branch)
    exact.verify_git_authority(sha, base, authority, branch=branch)
    require_fresh_email_risk(sha)
    if branch == "uat-isolated":
        exact.verify_attempt(api, sha, base, run_id, number, branch=branch, authority=authority)
    else:
        exact.verify_attempt(api, sha, base, run_id, number, branch=branch)
    exact.require_protected_tip(api, sha, branch)


def git_identity(*args: str) -> str:
    value = exact.git(*args).decode().strip()
    if not exact.SHA.fullmatch(value):
        raise Refused("UAT approved PR Git identity could not be established")
    return value


def require_combined_scope(
    api, *, branch: str, number: str, base: str, prior: str, head: str, landed: str,
    landed_tree: str, merged_at: str | None,
) -> None:
    """Verify the approved head's clean merge into the preceding approved commit."""
    parents = exact.git("show", "-s", "--format=%P", landed).decode().split()
    exact.require(parents == [prior, head], SCOPE_DELTA_ERROR)
    exact.require(git_identity("merge-tree", "--write-tree", prior, head) == landed_tree,
                  SCOPE_DELTA_ERROR)

    repo = exact.REPOSITORY
    actions = f"repos/{repo}/actions"
    workflow = f"{actions}/workflows/queue-validation.yml"
    path = ".github/workflows/queue-validation.yml"
    exact.require(not exact.git("diff", "--name-only", prior, landed, "--", path),
                  "Combined UAT merge changed its queue validation workflow")
    definition = api.read(workflow)
    exact.require(isinstance(definition, dict) and definition.get("path") == path,
                  "Combined UAT queue workflow is unavailable")
    workflow_id = positive(definition.get("id"), "queue workflow")
    runs = api.read(f"{workflow}/runs?event=merge_group&head_sha={landed}&per_page=100")
    rows = runs.get("workflow_runs") if isinstance(runs, dict) else None
    exact.require(isinstance(rows, list) and type(runs.get("total_count")) is int
                  and runs["total_count"] == len(rows) <= 1,
                  "Combined UAT merge requires one exact queue validation run")
    if not rows and branch == "uat":
        # A non-queued merge can earn independent release-level proof of its
        # own exact SHA. Focused PR checks never qualify this combined tree.
        exact.require(not exact.git("diff", "--name-only", prior, landed, "--",
                                    *exact.AUTHORITY_PATHS),
                      "Combined UAT merge changed its release qualification authority")
        run = latest_attempt(api, landed, branch)
        exact.require(bool(run), "Combined UAT merge requires exact release qualification")
        exact.verify_attempt(api, landed, base, positive(run.get("id"), "combined run"),
                             positive(run.get("run_attempt"), "combined attempt"), branch=branch)
        return
    exact.require(len(rows) == 1, "Combined UAT merge requires one exact queue validation run")
    run = rows[0]
    exact.require(
        isinstance(run, dict)
        and run.get("workflow_id") == workflow_id and run.get("path") == path
        and run.get("event") == "merge_group" and run.get("head_sha") == landed
        and run.get("head_branch") == f"gh-readonly-queue/{branch}/pr-{number}-{prior}"
        and (run.get("repository") or {}).get("full_name") == repo
        and (run.get("head_repository") or {}).get("full_name") == repo
        and run.get("status") == "completed" and run.get("conclusion") == "success",
        "Combined UAT merge requires successful queue validation for the approved parents",
    )
    run_id = positive(run.get("id"), "queue run")
    attempt = positive(run.get("run_attempt"), "queue attempt")
    inventory = api.read(f"{actions}/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    jobs = inventory.get("jobs") if isinstance(inventory, dict) else None
    exact.require(isinstance(jobs, list) and len(jobs) <= 100
                  and inventory.get("total_count") == len(jobs),
                  "Combined UAT queue jobs are incomplete")
    gates = [job for job in jobs if isinstance(job, dict) and job.get("name") == "CI Status Gate"]
    exact.require(len(gates) == 1, "Combined UAT queue gate is unavailable")
    gate = gates[0]
    steps = gate.get("steps") or []
    completed_at = gate.get("completed_at")
    # GitHub supplies fixed-width UTC timestamps for the merge and the check.
    timestamp = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"
    exact.require(
        gate.get("run_id") == run_id and gate.get("run_attempt") == attempt
        and gate.get("head_sha") == landed
        and gate.get("status") == "completed" and gate.get("conclusion") == "success"
        and isinstance(merged_at, str) and re.fullmatch(timestamp, merged_at)
        and isinstance(completed_at, str) and re.fullmatch(timestamp, completed_at)
        and completed_at <= merged_at
        and isinstance(steps, list) and sum(
            isinstance(step, dict) and step.get("name") == "Recheck membership, review and validation attempts"
            and step.get("conclusion") == "success" for step in steps
        ) == 1,
        "Combined UAT queue gate did not verify the reviewed merge",
    )
    check_url = gate.get("check_run_url") or ""
    match = re.fullmatch(rf"https://api\.github\.com/repos/{re.escape(repo)}/check-runs/([1-9][0-9]*)", check_url)
    exact.require(match is not None, "Combined UAT queue check identity is unavailable")
    check = api.read(f"repos/{repo}/check-runs/{match[1]}")
    exact.require(
        isinstance(check, dict) and check.get("name") == "CI Status Gate"
        and check.get("head_sha") == landed and check.get("status") == "completed"
        and check.get("conclusion") == "success"
        and (check.get("app") or {}).get("id") == 15368
        and (check.get("app") or {}).get("slug") == "github-actions"
        and (check.get("check_suite") or {}).get("id") == positive(run.get("check_suite_id"), "queue suite"),
        "Combined UAT queue check does not match the successful GitHub Actions attempt",
    )
    latest = api.read(f"{actions}/runs/{run_id}")
    keys = ("id", "run_attempt", "workflow_id", "head_sha", "check_suite_id", "status", "conclusion")
    exact.require(isinstance(latest, dict) and all(latest.get(key) == run.get(key) for key in keys),
                  "Combined UAT queue attempt changed during scope verification")


def verify_approved_scope(api, sha: str, base: str, approval: str, *, read_live=None, branch="uat") -> None:
    """Bind the governed dispatch to an ordered PR chain and both serving bases."""
    if branch not in exact.SOURCE_BRANCHES:
        raise Refused("Unrecognized protected UAT branch")
    match = re.fullmatch(
        r"([0-9a-f]{40}):([0-9a-f]{40}):"
        r"([1-9][0-9]{0,9}=[0-9a-f]{40}(?:,[1-9][0-9]{0,9}=[0-9a-f]{40}){0,19})",
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
            and (pr.get("base") or {}).get("ref") == branch
            and ((pr.get("base") or {}).get("repo") or {}).get("full_name") == exact.REPOSITORY
        ):
            raise Refused("UAT scope does not identify an approved head's landed release PR")
        landed = pr["merge_commit_sha"]
        try:
            head_tree = git_identity("rev-parse", f"{head}^{{tree}}")
        except Refused:
            # Squashed/deleted branches may only retain the reviewed GitHub PR ref.
            exact.git("fetch", "--no-tags", "--no-recurse-submodules", "origin", f"refs/pull/{number}/head")
            if git_identity("rev-parse", "FETCH_HEAD") != head:
                raise Refused("The retained GitHub UAT PR ref does not match the approved head") from None
            head_tree = git_identity("rev-parse", f"{head}^{{tree}}")
        parent = git_identity("rev-parse", f"{landed}^1")
        comparison = git_identity("merge-base", "--all", parent, head)
        # Compare complete trees, including modes, generated files and removals.
        tree = git_identity("rev-parse", f"{prior}^{{tree}}")
        landed_tree = git_identity("rev-parse", f"{landed}^{{tree}}")
        if git_identity("rev-parse", f"{comparison}^{{tree}}") != tree or head_tree != landed_tree:
            require_combined_scope(api, branch=branch, number=number, base=base, prior=prior, head=head,
                                   landed=landed, landed_tree=landed_tree, merged_at=pr.get("merged_at"))
        prior = landed
    if prior != sha:
        raise Refused("UAT candidate is not the last approved PR merge")
    if read_live is not None:
        serving = read_live("all")
        if any(serving.get(name, {}).get("sha") != expected for name, expected in
               (("backend", backend), ("frontend", frontend))):
            raise Refused("UAT serving revisions changed after scope approval; compare and approve again")
    print(f"UAT scope approved: {approvals}, backend base {backend}, frontend base {frontend}")


def verify_release_scope(api, sha: str, base: str, approval: str, *, branch="uat", read_live=None, predecessor: Path | None = None) -> None:
    """Admit the exact protected SHA; recheck recorded revisions under the lock."""
    if branch == "uat-isolated":
        verify_approved_scope(api, sha, base, approval, branch=branch, read_live=read_live)
        return
    exact.require(branch == "uat" and exact.SHA.fullmatch(sha or "")
                  and exact.SHA.fullmatch(base or ""), "Exact protected UAT source and base are required")
    exact.require_protected_tip(api, sha, branch)
    if read_live is not None:
        exact.require(predecessor is not None, "UAT serving recheck requires its captured admission")
        prior = json.loads(predecessor.read_text())
        exact.require(isinstance(prior, dict) and prior.get("kind") == "uat-exact-ci"
                      and prior.get("status") == "accepted" and prior.get("environment") == "uat"
                      and prior.get("repository") == exact.REPOSITORY
                      and prior.get("source_branch", "uat") == branch
                      and prior.get("sha") == sha and prior.get("base_sha") == base,
                      "UAT serving recheck admission belongs to another source")
        exact.verify_predecessor(prior, current=True)
        expected = prior.get("serving")
        exact.require(isinstance(expected, dict) and set(expected) == {"backend", "frontend"}
                      and all(isinstance(value, dict) and exact.SHA.fullmatch(value.get("sha", ""))
                              and isinstance(value.get("revision"), str) and value["revision"]
                              for value in expected.values()),
                      "UAT serving admission has no complete revision inventory")
        exact.require(read_live("all") == expected, "UAT serving revisions changed before mutation")
    exact.require_protected_tip(api, sha, branch)


def latest_attempt(api, candidate: str, branch="uat", authority="") -> dict:
    """Return diagnostics only; canonical verification below decides eligibility."""
    prefix = f"repos/{exact.REPOSITORY}/actions"
    isolated = branch == "uat-isolated"
    run_branch, head = ("main", authority) if isolated else (branch, candidate)
    rows = api.read(f"{prefix}/workflows/ci.yml/runs?branch={run_branch}&event=workflow_dispatch"
                    f"&head_sha={head}&per_page=100")
    if not isinstance(rows, dict):
        raise Refused("CI run inventory is malformed")
    runs = rows.get("workflow_runs")
    if not (isinstance(runs, list) and type(rows.get("total_count")) is int
            and rows["total_count"] == len(runs) <= 100):
        raise Refused("No complete exact-source CI inventory is available")
    if isolated:
        runs = [run for run in runs if run.get("display_title") == f"Isolated UAT {candidate}"]
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
        branch = result.get("source_branch", "uat")
        run = (latest_attempt(api, result["candidate_sha"], branch, result["authority_sha"])
               if branch == "uat-isolated" else latest_attempt(api, result["candidate_sha"], branch))
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
        options = {"authority": result["authority_sha"]} if branch == "uat-isolated" else {}
        exact.verify_attempt(api, result["candidate_sha"], result["base_sha"],
                             run["id"], run["run_attempt"], branch=branch, **options)
        result.update(ready=True, reason_code="qualified_current_ci")
    except (Refused, KeyError, TypeError):
        result["reason_code"] = "qualification_unverified"


def inspect(api, authority: str, *, read_live=None, branch="uat") -> dict:
    read_live = read_live or exact.live_serving_bases
    if branch not in exact.SOURCE_BRANCHES:
        raise Refused("Unrecognized protected UAT branch")
    ref = api.read(f"repos/{exact.REPOSITORY}/branches/{branch}")
    candidate = ref.get("commit", {}).get("sha", "")
    if not all(exact.SHA.fullmatch(value) for value in (candidate, authority)):
        raise Refused("Protected UAT source or Main workflow identity is unavailable")
    exact.require_protected_tip(api, candidate, branch)
    serving = read_live("all")
    base = serving.get("backend", {}).get("sha", "")
    if branch == "uat-isolated":
        exact.verify_serving_bases(base, "all", base, serving.get("frontend", {}).get("sha", ""))
    else:
        exact.require(set(serving) == {"backend", "frontend"}
                      and all(exact.SHA.fullmatch(value.get("sha", "")) for value in serving.values()),
                      "UAT serving source inventory is incomplete")
    result = {"kind": "uat-prerequisite-inspection", "ready": False,
              "candidate_sha": candidate, "base_sha": base,
              "authority_sha": authority, "serving": serving, "source_branch": branch,
              "reason_code": "qualification_unverified"}
    exact.verify_git_authority(candidate, base, authority, branch=branch)
    require_fresh_email_risk(candidate)
    source_only = False
    if branch == "uat":
        scope = importlib.import_module("resolve-deploy-scope")
        # Avoid receipt collection for any changed runtime/build/unknown input.
        if all(scope.source_only_update(value["sha"], candidate, "uat") for value in serving.values()):
            selection = importlib.import_module("uat_application_selection")
            acceptance = importlib.import_module("verify-predecessor-acceptance").GitHub()
            current = selection.current_application(
                selection.ObservedRepository(api), acceptance, candidate, "auto"
            )
            source_only = (
                not current["waiting"]
                and current.get("sources") == {name: value["sha"] for name, value in serving.items()}
                and current.get("revisions") == {name: value["revision"] for name, value in serving.items()}
                and set(current.get("tooling", {})) == set(serving)
                and all(scope.source_only_update(old, authority, "uat") for old in current["tooling"].values())
            )
    if source_only:
        result.update(reason_code="source_only_update", accepted_sources=current["sources"])
    else:
        qualify_inspection(api, result)
    exact.require_protected_tip(api, candidate, branch)
    if read_live("all") != serving:
        raise Refused("UAT serving state changed during inspection; inspect again")
    return result


def render(result: dict) -> str:
    lines = ["## UAT prerequisites (read-only; no deployment)",
             f"- Protected UAT source: `{result['candidate_sha']}`",
             f"- Observed serving base: `{result['base_sha']}`",
             f"- Main workflow authority: `{result['authority_sha']}`"]
    if result["reason_code"] == "source_only_update":
        lines += [
            "- Source-only update: current accepted application sources require no rollout for this change.",
            "- Accepted application sources: " + ", ".join(
                f"{name} `{sha}`" for name, sha in sorted(result["accepted_sources"].items())
            ),
            "- Do not dispatch full release CI merely because a reviewed operations/docs sync advanced UAT.",
            "- Required PR and combined-result CI still applies to the source merge.",
            "- This is not new application acceptance or a live cloud-health certification.",
            "- Environment/secret changes or deliberate controller testing still require an explicitly qualified release.",
            "- An explicitly requested redeployment still requires normal exact-source qualification.",
        ]
    elif result["ready"]:
        lines += ["- Current exact-source CI passed. Explicit deployment selects this protected SHA; compatibility and rollback remain required. Use the protected UAT caller with:",
                  f"  - `sha={result['candidate_sha']}`",
                  f"  - `ci_run_id={result['ci_run_id']}`",
                  f"  - `ci_run_attempt={result['ci_run_attempt']}`",
                  f"  - `ci_base_sha={result['base_sha']}`", "  - `scope=auto`"]
        if result.get("source_branch") == "uat-isolated":
            lines += ["  - `approved_scope=BACKEND:FRONTEND:PR=HEAD[,PR=HEAD]` (legacy isolated history only)"]
    elif result["reason_code"] in {"qualification_missing", "qualification_base_unpublished", "qualification_base_changed"}:
        branch = result.get("source_branch", "uat")
        lines += ["- Qualification is required. In Actions → PR Validation → Run workflow:",
                  f"  - Branch: `{'main' if branch == 'uat-isolated' else branch}`; scope: `all`",
                  f"  - `uat_base_sha={result['base_sha']}`",
                  "- Wait for success, then run this inspection again."]
        if branch == "uat-isolated":
            lines.insert(-1, f"  - `uat_candidate_sha={result['candidate_sha']}`")
            lines.insert(-1, f"  - `uat_candidate_tree={exact.application_tree(result['candidate_sha'])}`")
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
    parser.add_argument("--predecessor", type=Path)
    parser.add_argument("--source-branch", choices=exact.SOURCE_BRANCHES, default="uat")
    args = parser.parse_args()
    try:
        if args.mode == "validate-inspection":
            validate_inspection(json.loads(os.environ.get("WORKFLOW_INPUTS", "{}")))
            return 0
        api = GitHub(exact.REPOSITORY, os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", ""))
        if args.mode == "validate-deployment":
            verify_release_scope(api, args.sha, args.base_sha, args.approved_scope, branch=args.source_branch)
            validate_deployment(api, args.sha, args.ci_run_id, args.ci_attempt, args.base_sha, branch=args.source_branch, authority=args.authority_sha)
        elif args.mode == "validate-scope-live":
            verify_release_scope(api, args.sha, args.base_sha, args.approved_scope,
                                 read_live=exact.live_serving_bases, branch=args.source_branch,
                                 predecessor=args.predecessor)
        else:
            result = inspect(api, args.authority_sha, branch=args.source_branch)
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
