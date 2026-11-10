#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bind recovery qualification to the recorded application and trusted Main run."""

import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

_authority = runpy.run_path(
    str(Path(__file__).with_name("github_security_authority.py"))
)
Refused, SHA = _authority["Refused"], _authority["SHA"]
ACTIVE_ANCHOR_PRIMARY_SOURCE = runpy.run_path(
    str(Path(__file__).with_name("production_auth_domain_refresh.py"))
)["ACTIVE_ANCHOR_PRIMARY_SOURCE"]

REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = "validate-production-recovery-source.yml"
GATE = "Production Recovery Source Gate"


def require(condition, message):
    if not condition:
        raise Refused(message)


def git(*args):
    try:
        return subprocess.check_output(["git", *args], text=True, timeout=30).strip()
    except (subprocess.SubprocessError, OSError):
        raise Refused("Recovery Git source identity could not be verified") from None


def identity(source):
    require(
        source == ACTIVE_ANCHOR_PRIMARY_SOURCE,
        "Source is not the recorded recovery application",
    )
    base = git("rev-parse", f"{source}^1")
    tree = git("rev-parse", f"{source}^{{tree}}")
    require(
        SHA.fullmatch(base)
        and SHA.fullmatch(tree)
        and int(git("rev-list", "--count", f"{base}..{source}")) > 0,
        "Recovery source tree or comparison is incomplete",
    )
    return base, tree


def prepare(source, base=None, tree=None):
    authority = os.environ.get("GITHUB_SHA", "")
    require(
        os.environ.get("GITHUB_REPOSITORY") == REPOSITORY
        and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and os.environ.get("GITHUB_WORKFLOW_REF")
        == f"{REPOSITORY}/.github/workflows/{WORKFLOW}@refs/heads/main"
        and os.environ.get("GITHUB_REF") == "refs/heads/main"
        and os.environ.get("GITHUB_RUN_ATTEMPT") == "1"
        and SHA.fullmatch(authority)
        and git("rev-parse", "HEAD") == authority
        and not git("status", "--porcelain"),
        "Recovery qualification requires a fresh, clean Main workflow dispatch",
    )
    git("merge-base", "--is-ancestor", authority, "origin/main")
    expected_base, expected_tree = identity(source)
    git("merge-base", "--is-ancestor", source, authority)
    if base is not None or tree is not None:
        require(
            (base, tree) == (expected_base, expected_tree),
            "Recovery source identity differs from admission",
        )
        git("checkout", "--detach", source)
        require(
            git("rev-parse", "HEAD") == source
            and git("rev-parse", "HEAD^{tree}") == tree
            and not git("status", "--porcelain"),
            "Recovery tests require the exact clean application checkout",
        )
    return expected_base, expected_tree


def qualification(api, source):
    """Accept only the newest dedicated run, using live Actions metadata."""
    base, tree = identity(source)
    run_query = (
        f"workflows/{WORKFLOW}/runs?branch=main&event=workflow_dispatch&per_page=1"
    )
    observed = {}

    def read(path):
        value = api.read(path)
        observed[path] = hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return value

    listing = read(run_query)
    candidates = listing.get("workflow_runs")
    require(
        isinstance(candidates, list) and len(candidates) == 1,
        "Exact recovery source qualification has no canonical run",
    )
    run = candidates[0]
    run_id, authority = run.get("id"), run.get("head_sha", "")
    require(
        all(
            type(run.get(key)) is int and run[key] > 0
            for key in ("id", "workflow_id", "check_suite_id")
        )
        and SHA.fullmatch(authority)
        and run.get("head_branch") == "main"
        and run.get("path") == f".github/workflows/{WORKFLOW}"
        and run.get("event") == "workflow_dispatch"
        and run.get("run_attempt") == 1
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and (run.get("head_repository") or {}).get("full_name") == REPOSITORY
        and (run.get("repository") or {}).get("full_name") == REPOSITORY,
        "The newest recovery qualification must be a successful fresh Main dispatch",
    )
    git("merge-base", "--is-ancestor", authority, "origin/main")
    git("merge-base", "--is-ancestor", source, authority)
    jobs = read(f"runs/{run_id}/attempts/1/jobs?per_page=100")
    inventory = jobs.get("jobs")
    require(
        isinstance(inventory, list)
        and jobs.get("total_count") == len(inventory) <= 100,
        "Recovery qualification job inventory is incomplete",
    )
    gates = [job for job in inventory if job.get("name") == GATE]
    marker = f"Verify recovery application ({source} {tree} {base})"
    require(
        len(gates) == 1
        and gates[0].get("run_id") == run_id
        and gates[0].get("head_sha") == authority
        and gates[0].get("status") == "completed"
        and gates[0].get("conclusion") == "success"
        and [
            step.get("conclusion")
            for step in gates[0].get("steps", [])
            if step.get("name") == marker
        ]
        == ["success"],
        "Recovery gate did not verify the recorded application and tree",
    )
    fresh = read(f"runs/{run_id}")
    references = fresh.get("referenced_workflows")
    require(
        isinstance(references, list)
        and len(references) == 2
        and all(
            isinstance(row, dict)
            and row.get("sha") == authority
            and row.get("ref") == "refs/heads/main"
            and str(row.get("path")).partition("@")[2]
            in {authority, "refs/heads/main", "main"}
            for row in references
        )
        and {row["path"].split("@", 1)[0] for row in references}
        == {
            f"{REPOSITORY}/.github/workflows/{workflow}"
            for workflow in ("ci.yml", "deployment-security.yml")
        },
        "Recovery CI or security tooling differs from the reviewed Main source",
    )
    require(
        all(
            fresh.get(key) == run.get(key)
            for key in (
                "id",
                "head_sha",
                "head_branch",
                "path",
                "workflow_id",
                "check_suite_id",
                "event",
                "status",
                "conclusion",
                "run_attempt",
                "updated_at",
            )
        ),
        "Recovery qualification attempt changed during verification",
    )
    return {
        "schema_version": 1,
        "repository": REPOSITORY,
        "sha": source,
        "source_branch": "main",
        "source_tree": tree,
        "comparison_sha": base,
        "authority_sha": authority,
        "checks": [
            {
                "check": GATE,
                "run_id": run_id,
                "run_attempt": 1,
                "workflow": run["path"],
                "event": run["event"],
            }
        ],
        "authority_reads": observed,
    }


if __name__ == "__main__":
    try:
        base, tree = prepare(*sys.argv[1:])
        if len(sys.argv) == 2:
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write(f"base={base}\ntree={tree}\n")
    except Refused as error:
        raise SystemExit(str(error)) from None
