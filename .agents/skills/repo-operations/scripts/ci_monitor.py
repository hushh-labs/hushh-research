#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from collections import Counter, OrderedDict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
GOVERNANCE_POLICY_PATH = REPO_ROOT / "config" / "ci-governance.json"
TERMINAL_STATUSES = {"COMPLETED"}
SUCCESS_CONCLUSIONS = {"SUCCESS", "SKIPPED", "NEUTRAL"}
FAILURE_CONCLUSIONS = {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"}
DETAILS_URL_PATTERN = re.compile(r"/actions/runs/(?P<run_id>\d+)(?:/job/(?P<job_id>\d+))?")
PR_WORKFLOW_NAMES = {"PR Validation"}
QUEUE_WORKFLOW_NAMES = {"Queue Validation"}
POST_MERGE_WORKFLOW_NAMES = {"Main Post-Merge Smoke"}
CHECK_ROUTES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"web|next\.js|frontend", re.I), "frontend", "bug-triage"),
    (re.compile(r"protocol|python|fastapi|backend", re.I), "backend", "bug-triage"),
    (re.compile(r"integration|pkm|parity|playwright", re.I), "quality-contracts", "bug-triage"),
    (re.compile(r"publish\s+@hushh/mcp|mcp", re.I), "mcp-developer-surface", "mcp-surface-change"),
    (re.compile(r"upstream sync", re.I), "subtree-upstream-governance", "subtree-upstream-governance"),
    (re.compile(r"deploy to uat|deploy to production|freshness|secret scan|status gate", re.I), "repo-operations", "ci-watch-and-heal"),
]
UPSTREAM_SYNC_CHECK_NAMES = {"Upstream Sync"}
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")
SUBTREE_SYNC_SUMMARY_COMMAND = "./scripts/ci/subtree-sync-check.sh"
_SUBTREE_STATUS_CACHE: OrderedDict[str, Any] | None = None


def _run(command: list[str]) -> str:
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "command failed"
        raise RuntimeError(message)
    return completed.stdout


def _gh_json(args: list[str]) -> Any:
    output = _run(["gh", *args]).strip()
    return json.loads(output or "{}")


def _current_actor() -> str:
    user = _gh_json(["api", "user"])
    return str(user.get("login") or "")


def _governance_policy() -> dict[str, Any]:
    return json.loads(GOVERNANCE_POLICY_PATH.read_text(encoding="utf-8"))


def _team_membership(org_id: int, team_id: int, actor: str) -> bool:
    completed = subprocess.run(
        ["gh", "api", f"organizations/{org_id}/team/{team_id}/memberships/{actor}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return False
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return False
    return str(payload.get("state") or "").lower() == "active"


def _git_branch() -> str:
    return _run(["git", "branch", "--show-current"]).strip()


def _resolve_pr(pr_number: int | None, branch: str | None) -> dict[str, Any]:
    fields = "number,title,url,headRefName,statusCheckRollup"
    if pr_number is not None:
        return _gh_json(["pr", "view", str(pr_number), "--json", fields])

    head_ref = branch or _git_branch()
    pulls = _gh_json(["pr", "list", "--state", "open", "--head", head_ref, "--json", fields])
    if not pulls:
        raise RuntimeError(f"No open pull request found for branch `{head_ref}`")
    return pulls[0]


def _parse_details_url(details_url: str | None) -> tuple[str | None, str | None]:
    if not details_url:
        return None, None
    match = DETAILS_URL_PATTERN.search(details_url)
    if not match:
        return None, None
    return match.group("run_id"), match.group("job_id")


def _route_check(name: str, workflow_name: str | None) -> tuple[str, str]:
    haystack = f"{workflow_name or ''} {name}"
    for pattern, owner_skill, workflow_id in CHECK_ROUTES:
        if pattern.search(haystack):
            return owner_skill, workflow_id
    return "repo-operations", "ci-watch-and-heal"


def _workflow_stage(workflow_name: str | None) -> str:
    if workflow_name in PR_WORKFLOW_NAMES:
        return "pr_feedback_lane"
    if workflow_name in QUEUE_WORKFLOW_NAMES:
        return "queue_authority_lane"
    if workflow_name in POST_MERGE_WORKFLOW_NAMES:
        return "post_merge_deploy_authority_lane"
    return "unknown"


def _classify_subtree_status(output: str) -> str:
    haystack = output.lower()
    if "behind upstream by" in haystack:
        return "behind_upstream"
    if "ahead of upstream by" in haystack:
        return "ahead_of_upstream"
    if "diverged from upstream" in haystack:
        return "diverged"
    if "tree-level sync detected" in haystack or "content matches upstream" in haystack or "in sync with upstream" in haystack:
        return "in_sync"
    if "metadata was stale" in haystack:
        return "metadata_healed"
    if "could not fetch upstream" in haystack or "could not resolve upstream commit" in haystack:
        return "upstream_unavailable"
    if "no valid subtree sync baseline found" in haystack:
        return "missing_sync_baseline"
    if "direction undetermined" in haystack:
        return "direction_undetermined"
    return "unknown"


def _subtree_status_summary() -> OrderedDict[str, Any]:
    global _SUBTREE_STATUS_CACHE
    if _SUBTREE_STATUS_CACHE is not None:
        return _SUBTREE_STATUS_CACHE

    try:
        completed = subprocess.run(
            ["bash", "scripts/ci/subtree-sync-check.sh"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=45,
        )
        raw_output = f"{completed.stdout or ''}{completed.stderr or ''}"
        output = ANSI_ESCAPE_RE.sub("", raw_output).strip()
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        summary = lines[-1] if lines else "No subtree sync summary was emitted."
        _SUBTREE_STATUS_CACHE = OrderedDict(
            status=_classify_subtree_status(output),
            summary=summary,
            command=SUBTREE_SYNC_SUMMARY_COMMAND,
            timed_out=False,
            exit_code=completed.returncode,
        )
    except subprocess.TimeoutExpired:
        _SUBTREE_STATUS_CACHE = OrderedDict(
            status="probe_timed_out",
            summary=(
                "Subtree sync probe timed out while computing consent-protocol status. "
                "Run ./bin/hushh protocol check-sync for the authoritative result."
            ),
            command=SUBTREE_SYNC_SUMMARY_COMMAND,
            timed_out=True,
            exit_code=None,
        )
    return _SUBTREE_STATUS_CACHE


def _normalize_checks(pr_payload: dict[str, Any]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for raw_check in pr_payload.get("statusCheckRollup", []):
        name = raw_check.get("name") or raw_check.get("context") or "unknown-check"
        workflow_name = raw_check.get("workflowName")
        owner_skill, workflow_id = _route_check(name, workflow_name)
        run_id, job_id = _parse_details_url(raw_check.get("detailsUrl"))
        next_commands = [f"./bin/hushh codex route-task {workflow_id}"]
        if run_id and job_id:
            next_commands.append(f"gh run view {run_id} --job {job_id} --log-failed")
        subtree_summary: OrderedDict[str, Any] | None = None
        if name in UPSTREAM_SYNC_CHECK_NAMES:
            subtree_summary = _subtree_status_summary()
            next_commands.append("./bin/hushh protocol check-sync")
        checks.append(
            OrderedDict(
                name=name,
                workflow_name=workflow_name,
                status=raw_check.get("status"),
                conclusion=raw_check.get("conclusion"),
                started_at=raw_check.get("startedAt"),
                completed_at=raw_check.get("completedAt"),
                details_url=raw_check.get("detailsUrl"),
                delivery_stage=_workflow_stage(workflow_name),
                recommended_owner_skill=owner_skill,
                recommended_workflow_id=workflow_id,
                run_id=run_id,
                job_id=job_id,
                recommended_next_commands=next_commands,
                surface_summary=subtree_summary["summary"] if subtree_summary else None,
                surface_status=subtree_summary["status"] if subtree_summary else None,
                surface_command=subtree_summary["command"] if subtree_summary else None,
            )
        )
    return sorted(checks, key=lambda item: (item["workflow_name"] or "", item["name"]))


def _review_policy(base_branch: str = "main") -> OrderedDict[str, Any]:
    protection = _gh_json(["api", f"repos/hushh-labs/hushh-research/branches/{base_branch}/protection"])
    merge_queue_rules = _gh_json(["api", f"repos/hushh-labs/hushh-research/rules/branches/{base_branch}"])
    merge_queue_ruleset_id = next(
        (item.get("ruleset_id") for item in merge_queue_rules if item.get("type") == "merge_queue"),
        None,
    )
    merge_queue_ruleset = _gh_json(["api", f"repos/hushh-labs/hushh-research/rulesets/{merge_queue_ruleset_id}"]) if merge_queue_ruleset_id else {}
    rulesets = _gh_json(["api", f"repos/hushh-labs/hushh-research/rules/branches/{base_branch}"])
    policy = _governance_policy()
    bypass_users = [
        user["login"]
        for user in protection.get("required_pull_request_reviews", {})
        .get("bypass_pull_request_allowances", {})
        .get("users", [])
    ]
    actor = _current_actor()
    merge_queue_required = any(item.get("type") == "merge_queue" for item in rulesets)
    review_bypass_users = sorted(set(bypass_users))
    bypass_actors = merge_queue_ruleset.get("bypass_actors") or []
    queue_bypass_team = next((actor_info for actor_info in bypass_actors if actor_info.get("actor_type") == "Team"), None)
    queue_bypass_team_id = int(queue_bypass_team.get("actor_id")) if queue_bypass_team and queue_bypass_team.get("actor_id") else None
    queue_bypass_team_slug = policy["main"].get("merge_queue_bypass_team_slug")
    actor_can_bypass_queue = False
    if queue_bypass_team_id:
      actor_can_bypass_queue = _team_membership(140115870, queue_bypass_team_id, actor)
    return OrderedDict(
        current_actor=actor,
        required_approving_review_count=protection.get("required_pull_request_reviews", {}).get("required_approving_review_count", 0),
        review_bypass_users=review_bypass_users,
        current_actor_can_bypass_review=actor in review_bypass_users,
        merge_queue_required=merge_queue_required,
        merge_queue_bypass_team_slug=queue_bypass_team_slug,
        merge_queue_bypass_users=policy["main"]["merge_queue_bypass_users"],
        current_actor_can_bypass_queue=actor_can_bypass_queue,
        uat_manual_dispatch_users=policy["uat"]["manual_dispatch_users"],
        current_actor_can_dispatch_uat=actor in policy["uat"]["manual_dispatch_users"],
        production_manual_dispatch_users=policy["production"]["manual_dispatch_users"],
        current_actor_can_dispatch_production=actor in policy["production"]["manual_dispatch_users"],
        notes=[
            "A PR author still cannot self-approve through GitHub.",
            "Review bypass and merge-queue policy are separate gates.",
            "The sanctioned main owner-bypass cohort may waive review on main and bypass merge queue through the dedicated team-backed owner path.",
        ],
    )


def _overall_status(checks: list[dict[str, Any]]) -> str:
    if not checks:
        return "booting"
    if any((check["conclusion"] or "").upper() in FAILURE_CONCLUSIONS for check in checks):
        return "failing"
    if any((check["status"] or "").upper() not in TERMINAL_STATUSES for check in checks):
        return "pending"
    if checks and all((check["conclusion"] or "").upper() in SUCCESS_CONCLUSIONS for check in checks):
        return "passing"
    return "attention"


def _build_payload(pr_payload: dict[str, Any]) -> OrderedDict[str, Any]:
    checks = _normalize_checks(pr_payload)
    review_policy = _review_policy()
    overall_status = _overall_status(checks)
    status_counts = Counter(
        "failing"
        if (check["conclusion"] or "").upper() in FAILURE_CONCLUSIONS
        else "pending"
        if (check["status"] or "").upper() not in TERMINAL_STATUSES
        else "passing"
        for check in checks
    )
    failing_checks = [
        check
        for check in checks
        if (check["conclusion"] or "").upper() in FAILURE_CONCLUSIONS
    ]
    pending_checks = [
        check
        for check in checks
        if (check["status"] or "").upper() not in TERMINAL_STATUSES
    ]
    if failing_checks:
        completion_gate = OrderedDict(
            task_complete=False,
            reason="Core checks are failing. Repair the failing workflow chain or emit a concrete blocker with workflow, job, and step context.",
        )
    elif pending_checks:
        completion_gate = OrderedDict(
            task_complete=False,
            reason="Core checks are still active. Keep monitoring until GitHub reaches a terminal state; after merge, continue through Main Post-Merge Smoke, and only continue into Deploy to UAT if a UAT deployment was explicitly requested or already dispatched.",
        )
    elif overall_status == "booting":
        completion_gate = OrderedDict(
            task_complete=False,
            reason="GitHub has not reported checks yet. The task is still in progress until the core check set becomes terminal.",
        )
    else:
        completion_gate = OrderedDict(
            task_complete=True,
            reason="Core PR checks are terminal green. If the change has landed on main, continue monitoring post-merge smoke before closing the task; proceed to Deploy to UAT only when that deployment was explicitly requested.",
        )
    next_actions = OrderedDict()
    next_actions["route_task"] = "./bin/hushh codex route-task ci-watch-and-heal"
    next_actions["impact"] = "./bin/hushh codex impact ci-watch-and-heal"
    next_actions["completion_gate"] = completion_gate["reason"]
    if review_policy["current_actor_can_bypass_review"]:
        next_actions["review_gate"] = "Current actor may waive the review gate on main; this is not the same as self-approval."
    else:
        next_actions["review_gate"] = "Current actor is not in the PR-review bypass allowlist."
    if review_policy["merge_queue_required"]:
        if review_policy["current_actor_can_bypass_queue"]:
            next_actions["merge_queue"] = "Current actor may bypass merge queue through the dedicated owner team-backed path."
        else:
            next_actions["merge_queue"] = "main still has an active merge-queue rule; current actor is not in the queue-bypass path."
    next_actions["deploy_uat"] = (
        "Current actor may manually dispatch UAT."
        if review_policy["current_actor_can_dispatch_uat"]
        else "Current actor may not manually dispatch UAT."
    )
    next_actions["deploy_production"] = (
        "Current actor may manually dispatch Production."
        if review_policy["current_actor_can_dispatch_production"]
        else "Current actor may not manually dispatch Production."
    )
    if failing_checks:
        next_actions["primary_owner_skills"] = sorted({check["recommended_owner_skill"] for check in failing_checks})
    elif pending_checks:
        next_actions["primary_owner_skills"] = sorted({check["recommended_owner_skill"] for check in pending_checks})
    else:
        next_actions["primary_owner_skills"] = []
    upstream_sync_check = next((check for check in checks if check["name"] in UPSTREAM_SYNC_CHECK_NAMES), None)
    if upstream_sync_check and upstream_sync_check.get("surface_summary"):
        next_actions["upstream_subtree_summary"] = upstream_sync_check["surface_summary"]
        next_actions["upstream_subtree_route_task"] = "./bin/hushh codex route-task subtree-upstream-governance"

    return OrderedDict(
        pr=OrderedDict(
            number=pr_payload["number"],
            title=pr_payload["title"],
            url=pr_payload["url"],
            head_ref=pr_payload["headRefName"],
        ),
        review_policy=review_policy,
        overall_status=overall_status,
        completion_gate=completion_gate,
        status_counts=OrderedDict(
            passing=status_counts["passing"],
            pending=status_counts["pending"],
            failing=status_counts["failing"],
        ),
        failing_checks=failing_checks,
        pending_checks=pending_checks,
        checks=checks,
        next_actions=next_actions,
    )


def _watch(pr_number: int | None, branch: str | None, interval: int, timeout: int) -> OrderedDict[str, Any]:
    deadline = time.monotonic() + timeout
    last_signature: tuple[str, tuple[tuple[str, str | None, str | None], ...]] | None = None

    while True:
        pr_payload = _resolve_pr(pr_number, branch)
        payload = _build_payload(pr_payload)
        signature = (
            payload["overall_status"],
            tuple((check["name"], check["status"], check["conclusion"]) for check in payload["checks"]),
        )
        if signature != last_signature:
            print(_render_text(payload), file=sys.stderr)
            print("", file=sys.stderr)
            last_signature = signature

        if payload["overall_status"] in {"passing", "failing", "attention"}:
            return payload
        if time.monotonic() >= deadline:
            payload["overall_status"] = "timed_out"
            return payload
        time.sleep(interval)


def _render_text(payload: OrderedDict[str, Any]) -> str:
    pr = payload["pr"]
    lines = [
        f"PR #{pr['number']}: {pr['title']}",
        f"Head ref: {pr['head_ref']}",
        f"URL: {pr['url']}",
        (
            "Review policy: "
            f"actor={payload['review_policy']['current_actor'] or 'unknown'}, "
            f"actor_can_bypass_review={payload['review_policy']['current_actor_can_bypass_review']}, "
            f"actor_can_bypass_queue={payload['review_policy']['current_actor_can_bypass_queue']}, "
            f"actor_can_dispatch_uat={payload['review_policy']['current_actor_can_dispatch_uat']}, "
            f"actor_can_dispatch_production={payload['review_policy']['current_actor_can_dispatch_production']}, "
            f"merge_queue_required={payload['review_policy']['merge_queue_required']}"
        ),
        f"Overall status: {payload['overall_status']}",
        f"Task complete: {payload['completion_gate']['task_complete']}",
        f"Completion gate: {payload['completion_gate']['reason']}",
        (
            "Counts: "
            f"passing={payload['status_counts']['passing']}, "
            f"pending={payload['status_counts']['pending']}, "
            f"failing={payload['status_counts']['failing']}"
        ),
    ]
    if payload["failing_checks"]:
        lines.append("Failing checks:")
        for check in payload["failing_checks"]:
            lines.append(
                f"- {check['name']} [{check['workflow_name'] or 'no-workflow'}] -> "
                f"{check['recommended_owner_skill']} via {check['recommended_workflow_id']} "
                f"({check['delivery_stage']})"
            )
    elif payload["pending_checks"]:
        lines.append("Pending checks:")
        for check in payload["pending_checks"]:
            lines.append(
                f"- {check['name']} [{check['workflow_name'] or 'no-workflow'}] -> "
                f"{check['recommended_owner_skill']} ({check['delivery_stage']})"
            )
    elif payload["overall_status"] == "booting":
        lines.append("Checks have not been reported by GitHub yet.")
    else:
        lines.append("No failing or pending checks.")
    upstream_sync_check = next((check for check in payload["checks"] if check["name"] in UPSTREAM_SYNC_CHECK_NAMES), None)
    if upstream_sync_check and upstream_sync_check.get("surface_summary"):
        lines.append(
            "Upstream subtree summary: "
            f"{upstream_sync_check['surface_summary']}"
        )
    lines.append("Next actions:")
    for key, value in payload["next_actions"].items():
        if isinstance(value, list):
            lines.append(f"- {key}: {', '.join(value) if value else 'none'}")
        else:
            lines.append(f"- {key}: {value}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Monitor and classify GitHub PR checks for Hussh Codex.")
    parser.add_argument("--pr", type=int, help="pull request number")
    parser.add_argument("--branch", help="head branch name; defaults to the current branch")
    parser.add_argument("--watch", action="store_true", help="poll until the PR checks reach a terminal state")
    parser.add_argument("--interval", type=int, default=15, help="poll interval in seconds for --watch")
    parser.add_argument("--timeout", type=int, default=1800, help="max wait in seconds for --watch")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--text", action="store_true", help="emit concise text")
    args = parser.parse_args()

    payload = _watch(args.pr, args.branch, args.interval, args.timeout) if args.watch else _build_payload(_resolve_pr(args.pr, args.branch))
    if args.json and not args.text:
        print(json.dumps(payload, indent=2))
    else:
        print(_render_text(payload))
    if args.watch:
        return 0 if payload["overall_status"] == "passing" else 1
    return 0 if payload["overall_status"] in {"passing", "pending", "booting"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
