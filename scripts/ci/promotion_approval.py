#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Bind a qualified application to its distinct, validated Main approval.

This content proof does not replace functional qualification or Main smoke.
It neither deploys nor provides an emergency source bypass.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

SHA = re.compile(r"[0-9a-f]{40}")


def git(*args: str) -> str:
    # Internal fixed verbs plus validated immutable SHAs; no shell or caller refs.
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()  # noqa: S603


def verify(application: str, approval: str, *, resolve=git) -> dict:
    if not all(SHA.fullmatch(value) for value in (application, approval)):
        raise ValueError("Application and approval require full immutable SHAs")
    if application == approval:
        raise ValueError("Use ordinary Main admission when application and approval are identical")
    if resolve("merge-base", approval, "origin/main") != approval:
        raise ValueError("Approval is not on Main")
    if resolve("merge-base", application, approval) != application:
        raise ValueError("Main approval does not incorporate the tested application")
    if len(resolve("show", "-s", "--format=%P", approval).split()) != 2:
        raise ValueError("A reviewed Main merge approval is required")
    application_tree = resolve("rev-parse", f"{application}^{{tree}}")
    approval_tree = resolve("rev-parse", f"{approval}^{{tree}}")
    if not SHA.fullmatch(application_tree) or application_tree != approval_tree:
        raise ValueError("Main approval changes the qualified application content")
    return {
        "schema_version": 1,
        "kind": "main-application-approval",
        "application_sha": application,
        "main_approval_sha": approval,
        "application_tree": application_tree,
        "equivalence": "exact-git-tree",
        "predecessor_acceptance_required": "main-qualified-source",
    }


def uat_source(application: str, *, resolve=git, branch="uat") -> tuple[str, str]:
    """Require new UAT selections to belong to protected UAT history.

    Historical Main-backed receipts remain readable by the acceptance verifier;
    they do not authorize a new Main-only dispatch.
    """
    if not SHA.fullmatch(application):
        raise ValueError("A full application SHA is required")
    if branch not in ("uat", "uat-isolated"):
        raise ValueError("Unrecognized protected UAT branch")
    if resolve("merge-base", application, f"origin/{branch}") == application:
        return branch, "CI Status Gate,Queue Validation,Branch Validation Gate"
    raise ValueError("Application is not in protected UAT history")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", nargs="?", choices=("main", "uat"), default="main")
    parser.add_argument("--application-sha", required=True)
    parser.add_argument("--approval-sha", default="")
    parser.add_argument("--source-branch", choices=("uat", "uat-isolated"), default="uat")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        # No untrusted ref or option enters the fetch command.
        values = (
            (args.application_sha,)
            if args.mode == "uat"
            else (args.application_sha, args.approval_sha)
        )
        if not all(SHA.fullmatch(v) for v in values):
            raise ValueError("Full immutable SHAs are required")
        refs = ["+refs/heads/main:refs/remotes/origin/main"]
        if args.mode == "uat":
            refs.append(f"+refs/heads/{args.source_branch}:refs/remotes/origin/{args.source_branch}")
        subprocess.run(["git", "fetch", "--no-tags", "origin", *refs], check=True)
        if args.mode == "uat":
            branch, checks = uat_source(args.application_sha, branch=args.source_branch)
            if args.github_output is None:
                raise ValueError("UAT selection requires the workflow output port")
            with args.github_output.open("a", encoding="utf-8") as output:
                output.write(f"branch={branch}\nchecks={checks}\n")
            print(
                f"Selected {branch} source authority; exact branch CI and "
                "Main-owned UAT admission remain required."
            )
            return 0
        if args.output is None:
            raise ValueError("Main approval requires an output receipt")
        record = verify(args.application_sha, args.approval_sha)
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(record, output, indent=2)
        print(
            "Exact application content is incorporated by the Main approval; functional CI and Main smoke remain required."
        )
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Promotion approval refused: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
