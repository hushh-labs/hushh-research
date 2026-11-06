#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Qualify Akshat's exact branch tip before a privileged sandbox deployment."""

from __future__ import annotations

import os
import re
import subprocess
import sys

import queue_combined_result as queue
from uat_exact_ci import (
    AUTHORITY_PATHS,
    BACKEND_TEST_MANIFEST,
    verify_invocation_authority,
)

REPOSITORY = "hushh-labs/hushh-research"
SOURCE_BRANCH = "New_memory_architecutre"
BASELINE = "d884959b5b1dc666b01998b24bdd8138be93161e"
QUALIFICATION_PATHS = (
    *AUTHORITY_PATHS,
    f":(exclude){BACKEND_TEST_MANIFEST}",
    ".gitattributes",
    ":(glob)**/.gitattributes",
    ".gitmodules",
    ".gitleaks.toml",
    ".gitleaksignore",
)
SHA = re.compile(r"[a-f0-9]{40}")


def qualify(source: str, authority: str) -> None:
    queue.require(
        os.environ.get("GITHUB_REPOSITORY") == REPOSITORY
        and os.environ.get("GITHUB_REF") == "refs/heads/main"
        and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
        "Sandbox qualification requires the canonical repository's Main workflow",
    )
    queue.require(
        SHA.fullmatch(source) and SHA.fullmatch(authority),
        "Expected full source and Main SHAs",
    )
    queue.require(
        queue.git("rev-parse", "HEAD") == authority, "Protected Main checkout changed"
    )
    ref = f"refs/heads/{SOURCE_BRANCH}"
    local_ref = f"refs/remotes/origin/{SOURCE_BRANCH}"
    # Fetch Git objects without checking out or running any source files here.
    queue.git("fetch", "--no-tags", "--depth=1", "origin", f"+{ref}:{local_ref}")
    queue.require(
        queue.git("rev-parse", local_ref) == source,
        "Select the current Akshat memory branch tip",
    )
    comparison = queue.api(
        f"repos/{REPOSITORY}/compare/{BASELINE}...{source}?per_page=1"
    )
    queue.require(
        comparison["merge_base_commit"]["sha"] == BASELINE,
        "The candidate does not contain the approved sandbox baseline",
    )
    queue.require(
        not queue.git(
            "diff", "--name-only", authority, source, "--", *QUALIFICATION_PATHS
        ),
        "Candidate CI or release authority differs from Main",
    )
    verify_invocation_authority(source, authority)
    subprocess.run(
        ["bash", "scripts/ci/require-deploy-sha-on-main.sh", source],
        env={
            **os.environ,
            "GITHUB_TOKEN": os.environ["GH_TOKEN"],
            "REQUIRED_BRANCH": SOURCE_BRANCH,
            "REQUIRE_CI_SUCCESS": "1",
            "REQUIRE_CI_HEAD_BRANCH": "1",
            "REQUIRED_CHECK_NAME": "Branch Validation Gate",
            "REQUIRED_CI_JOB_STEP": "Verify Akshat sandbox CI inputs",
        },
        check=True,
        timeout=180,
    )
    queue.require(
        queue.git("ls-remote", "origin", ref).split() == [source, ref],
        "The Akshat memory branch changed during qualification",
    )


if __name__ == "__main__":
    try:
        qualify(sys.argv[1], os.environ["GITHUB_SHA"])
    except (ValueError, KeyError, IndexError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Sandbox source qualification refused: {error}") from None
