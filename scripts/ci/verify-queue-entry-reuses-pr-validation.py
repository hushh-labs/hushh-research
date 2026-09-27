#!/usr/bin/env python3
"""Pass a merge-queue entry only when PR Validation already proved its exact tree.

Queue Validation used to re-run the whole CI surface on every merge group. It
has not run since 2026-09-01 (maintainers bypass the queue), and its web-full
step was red in each of its last six runs. It still cannot simply be deleted:
`main` requires the `CI Status Gate` check and has an active merge-queue
ruleset, so a PR that enters the queue needs *something* to report that check
on the merge group, or the entry waits out the queue's check timeout and is
dropped.

This script is that something, and it never passes content CI has not seen.
A merge group is accepted only when:

1. its head ref names exactly one PR (`gh-readonly-queue/<base>/pr-<N>-<sha>`);
2. the merge group's git TREE is byte-identical to the PR head's tree, which
   holds exactly when the PR already contained the queue base (the PR-level
   Base Freshness Gate enforces that) and no other queued entry is stacked
   underneath it; and
3. the latest `PR Validation` run for that PR head has a successful
   `CI Status Gate` job.

Anything else fails closed with the reason and the fix (update the branch,
wait for PR Validation, re-queue). Identical trees mean identical content, so
the PR result is a result for the merge group, not an approximation of it.

Run with --self-test to exercise the decision logic without the network.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass

PR_VALIDATION_WORKFLOW_PATH = ".github/workflows/ci.yml"
PR_VALIDATION_WORKFLOW_NAME = "PR Validation"
GATE_JOB_NAME = "CI Status Gate"
QUEUE_REF_RE = re.compile(r"^(?:refs/heads/)?gh-readonly-queue/.+/pr-(\d+)-[0-9a-f]{40}$")


class QueueEntryRejected(Exception):
    """The merge group cannot reuse a PR Validation result."""


@dataclass(frozen=True)
class WorkflowRun:
    run_id: int
    path: str
    name: str
    event: str
    head_sha: str
    status: str
    created_at: str


def parse_pr_number(head_ref: str) -> int:
    match = QUEUE_REF_RE.match(head_ref.strip())
    if not match:
        raise QueueEntryRejected(
            f"merge-group head ref {head_ref!r} does not name a single queued PR "
            "(expected gh-readonly-queue/<base>/pr-<N>-<sha>)"
        )
    return int(match.group(1))


def require_identical_trees(merge_group_tree: str, pr_head_tree: str, pr_number: int) -> None:
    if not merge_group_tree or merge_group_tree != pr_head_tree:
        raise QueueEntryRejected(
            f"the merge group's content differs from PR #{pr_number}'s head, so PR Validation "
            "never ran on it. Update the PR branch from its base, let PR Validation go green, "
            "and re-queue. (This also happens when another entry is queued ahead of it.)"
        )


def latest_pr_validation_run(runs: list[WorkflowRun], pr_head_sha: str) -> WorkflowRun:
    candidates = [
        run
        for run in runs
        if run.path == PR_VALIDATION_WORKFLOW_PATH
        and run.name == PR_VALIDATION_WORKFLOW_NAME
        and run.event == "pull_request"
        and run.head_sha == pr_head_sha
    ]
    if not candidates:
        raise QueueEntryRejected(f"no PR Validation run exists for PR head {pr_head_sha}")
    # The newest run is the verdict; a stale green run must not outvote a newer red one.
    return max(candidates, key=lambda run: (run.created_at, run.run_id))


def require_gate_success(run: WorkflowRun, jobs: list[dict]) -> None:
    if run.status != "completed":
        raise QueueEntryRejected(
            f"PR Validation run {run.run_id} is still {run.status}; wait for it before queueing"
        )
    gates = [job for job in jobs if job.get("name") == GATE_JOB_NAME]
    if not gates:
        raise QueueEntryRejected(f"PR Validation run {run.run_id} has no {GATE_JOB_NAME} job")
    conclusions = {str(job.get("conclusion")) for job in gates}
    if conclusions != {"success"}:
        raise QueueEntryRejected(
            f"{GATE_JOB_NAME} in PR Validation run {run.run_id} concluded "
            f"{', '.join(sorted(conclusions))}, not success"
        )


def _run(*args: str) -> str:
    # Fixed argv (gh/git with values from the merge_group event), never a shell.
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()  # noqa: S603


def _gh_json(path: str) -> dict:
    return json.loads(_run("gh", "api", "-H", "Accept: application/vnd.github+json", path))


def verify(repo: str, head_ref: str, merge_group_sha: str) -> str:
    pr_number = parse_pr_number(head_ref)
    pull = _gh_json(f"repos/{repo}/pulls/{pr_number}")
    pr_head_sha = str(pull["head"]["sha"])

    _run("git", "fetch", "--no-tags", "--quiet", "origin", f"+refs/pull/{pr_number}/head:refs/remotes/origin/pr-head")
    fetched = _run("git", "rev-parse", "refs/remotes/origin/pr-head")
    if fetched != pr_head_sha:
        raise QueueEntryRejected(
            f"PR #{pr_number} head moved while queued ({fetched} vs {pr_head_sha}); re-queue it"
        )
    require_identical_trees(
        _run("git", "rev-parse", f"{merge_group_sha}^{{tree}}"),
        _run("git", "rev-parse", f"{pr_head_sha}^{{tree}}"),
        pr_number,
    )

    payload = _gh_json(
        f"repos/{repo}/actions/runs?head_sha={pr_head_sha}&event=pull_request&per_page=100"
    )
    runs = [
        WorkflowRun(
            run_id=int(item["id"]),
            path=str(item.get("path", "")).split("@", 1)[0],
            name=str(item.get("name", "")),
            event=str(item.get("event", "")),
            head_sha=str(item.get("head_sha", "")),
            status=str(item.get("status", "")),
            created_at=str(item.get("created_at", "")),
        )
        for item in payload.get("workflow_runs", [])
    ]
    run = latest_pr_validation_run(runs, pr_head_sha)
    jobs = _gh_json(f"repos/{repo}/actions/runs/{run.run_id}/jobs?per_page=100").get("jobs", [])
    require_gate_success(run, jobs)
    return (
        f"PR #{pr_number}: merge group {merge_group_sha} has the same tree as PR head "
        f"{pr_head_sha}, whose PR Validation run {run.run_id} passed {GATE_JOB_NAME}."
    )


def _expect(condition: bool, message: str) -> None:
    # Not `assert`: `python -O` strips asserts, and a self-test must not pass vacuously.
    if not condition:
        raise AssertionError(message)


def self_test() -> int:
    sha = "a" * 40
    _expect(parse_pr_number(f"refs/heads/gh-readonly-queue/main/pr-7140-{sha}") == 7140, "main queue ref")
    _expect(
        parse_pr_number(f"gh-readonly-queue/integration/pr-train/pr-12-{sha}") == 12,
        "pr-train queue ref",
    )
    for bad in ("refs/heads/main", f"gh-readonly-queue/main/pr-x-{sha}", "gh-readonly-queue/main/pr-1-abc"):
        try:
            parse_pr_number(bad)
        except QueueEntryRejected:
            pass
        else:
            raise AssertionError(f"accepted non-queue ref {bad!r}")

    require_identical_trees("t1", "t1", 1)
    for merge_tree, head_tree in (("t1", "t2"), ("", "")):
        try:
            require_identical_trees(merge_tree, head_tree, 1)
        except QueueEntryRejected:
            pass
        else:
            raise AssertionError("accepted a merge group whose content CI never saw")

    def run(run_id: int, created: str, **overrides: str) -> WorkflowRun:
        fields = {
            "path": PR_VALIDATION_WORKFLOW_PATH,
            "name": PR_VALIDATION_WORKFLOW_NAME,
            "event": "pull_request",
            "head_sha": sha,
            "status": "completed",
        }
        fields.update(overrides)
        return WorkflowRun(run_id=run_id, created_at=created, **fields)  # type: ignore[arg-type]

    older, newer = run(1, "2026-09-01T00:00:00Z"), run(2, "2026-09-02T00:00:00Z")
    decoys = [
        run(9, "2026-09-09T00:00:00Z", path=".github/workflows/queue-validation.yml"),
        run(8, "2026-09-09T00:00:00Z", event="workflow_dispatch"),
        run(7, "2026-09-09T00:00:00Z", head_sha="b" * 40),
    ]
    _expect(latest_pr_validation_run([older, newer, *decoys], sha) == newer, "newest PR Validation run wins")
    try:
        latest_pr_validation_run(decoys, sha)
    except QueueEntryRejected:
        pass
    else:
        raise AssertionError("accepted a run that is not PR Validation on this head")

    require_gate_success(newer, [{"name": GATE_JOB_NAME, "conclusion": "success"}])
    rejections = (
        (newer, [{"name": GATE_JOB_NAME, "conclusion": "failure"}]),
        (newer, [{"name": GATE_JOB_NAME, "conclusion": "skipped"}]),
        (newer, [{"name": "Protocol (Python)", "conclusion": "success"}]),
        (newer, []),
        (run(3, "2026-09-03T00:00:00Z", status="in_progress"), [{"name": GATE_JOB_NAME, "conclusion": "success"}]),
    )
    for candidate, jobs in rejections:
        try:
            require_gate_success(candidate, jobs)
        except QueueEntryRejected:
            pass
        else:
            raise AssertionError(f"accepted gate jobs {jobs!r} on run status {candidate.status}")

    print("verify-queue-entry-reuses-pr-validation self-test passed.")
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return self_test()
    repo = os.environ["GITHUB_REPOSITORY"]
    head_ref = os.environ["MERGE_GROUP_HEAD_REF"]
    merge_group_sha = os.environ["MERGE_GROUP_HEAD_SHA"]
    try:
        print(verify(repo, head_ref, merge_group_sha))
    except QueueEntryRejected as rejected:
        print(f"::error::Queue entry rejected: {rejected}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
