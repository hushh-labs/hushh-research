#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""Keep PR test execution behind the trusted controller and isolated inputs."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
CACHE_TRUSTED = "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'"
TOKEN_REFERENCE = re.compile(
    r"(?im)^\s*(?:GH_TOKEN|GITHUB_TOKEN)\s*:|"
    r"\$\{\{\s*github\.token\s*\}\}|\$(?:GH_TOKEN|GITHUB_TOKEN)\b"
)

CANDIDATE_JOBS = (
    "secret-scan",
    "dco-check",
    "pr-base-policy",
    "paths",
    "preflight-gate",
    "ui-contracts",
    "main-freshness-gate",
    "web-core-check",
    "web-targeted-check",
    "web-editor-performance-check",
    "web-full-suite-check",
    "ios-native-check",
    "android-native-check",
    "protocol-check",
    "protocol-database-check",
    "mcp-package-check",
    "integration-check",
    "merge-fidelity-gate",
    "ci-status",
)
CACHE_JOBS = (
    "ui-contracts",
    "web-core-check",
    "web-targeted-check",
    "web-editor-performance-check",
    "web-full-suite-check",
    "ios-native-check",
    "android-native-check",
    "protocol-check",
    "protocol-database-check",
    "mcp-package-check",
    "integration-check",
)


def _steps(text: str) -> list[tuple[str, str]]:
    lines = text.splitlines()
    steps: list[tuple[str, str]] = []
    i = 0
    while i < len(lines):
        if not lines[i].startswith("      - "):
            i += 1
            continue
        start = i
        i += 1
        while i < len(lines) and not lines[i].startswith("      - "):
            i += 1
        block = "\n".join(lines[start:i])
        name = re.search(r"^      - name: (.+)$", block, re.M)
        steps.append((name.group(1) if name else "", block))
    return steps


def _job(workflow: str, name: str) -> str:
    start = workflow.index(f"\n  {name}:\n")
    match = re.search(r"\n  [A-Za-z0-9_-]+:\n", workflow[start + 1 :])
    return workflow[start : start + 1 + match.start()] if match else workflow[start:]


def _check_trigger(source: str, errors: list[str]) -> None:
    if not re.search(r"^  pull_request_target:\n", source, re.M):
        errors.append(
            "PR Validation must run from the target branch's workflow definition"
        )
    if not re.search(r"^permissions:\n  contents: read$", source, re.M):
        errors.append(
            "PR Validation must grant only read-only repository checkout authority by default"
        )
    trigger = source.split("\njobs:\n", 1)[0]
    for branch in ('"main"', '"dev"', '"uat"', '"integration/pr-train"'):
        if branch not in trigger:
            errors.append(
                f"pull_request_target must be limited to protected base branch {branch}"
            )
    if "github.event.pull_request.number || github.ref" not in source:
        errors.append("PR concurrency must remain isolated by pull request number")
    if (
        "CI_TEST_REF: ${{ github.event_name == 'pull_request_target' && format('refs/pull/{0}/merge', github.event.pull_request.number) || github.sha }}"
        not in source
    ):
        errors.append(
            "candidate test lanes must check out the exact synthetic PR merge ref"
        )


def _check_checkouts(source: str, errors: list[str]) -> None:
    checkout_steps = [
        block for _, block in _steps(source) if "uses: actions/checkout@v6" in block
    ]
    if not checkout_steps:
        errors.append("no explicit checkout steps found")
    for index, block in enumerate(checkout_steps, 1):
        if "persist-credentials: false" not in block:
            errors.append(f"checkout step {index} persists the GitHub token")


def _check_candidate_jobs(source: str, errors: list[str]) -> None:
    secret_scan = _job(source, "secret-scan")
    ci_status = _job(source, "ci-status")
    if "GH_TOKEN:" in secret_scan:
        errors.append("candidate-controlled secret scan receives a GitHub token")
    if "GH_TOKEN:" in ci_status:
        errors.append("final status job receives a GitHub token")
    if "CI_SECURITY_RECEIPT_MODE: separate-main-owned-job" not in secret_scan:
        errors.append(
            "candidate secret scan must defer the protected receipt to its separate job"
        )
    for job_name in CANDIDATE_JOBS:
        block = _job(source, job_name)
        if re.search(r"\$\{\{\s*secrets\.", block) or re.search(
            r"^\s*id-token:\s*write\s*$", block, re.M
        ):
            errors.append(
                f"candidate job {job_name} receives protected credentials or OIDC authority"
            )
        token_references = TOKEN_REFERENCE.findall(block)
        if job_name == "paths":
            path_filter_steps = [
                step
                for _, step in _steps(block)
                if "uses: dorny/paths-filter@v4" in step
            ]
            if (
                len(path_filter_steps) != 1
                or token_references != ["${{ github.token }}"]
                or "token: ${{ github.token }}" not in path_filter_steps[0]
            ):
                errors.append(
                    "path classification token must be scoped only to dorny/paths-filter"
                )
        elif token_references:
            errors.append(f"candidate job {job_name} receives a GitHub API token")
        if job_name != "paths" and re.search(r"^    permissions:\n", block, re.M):
            errors.append(
                f"candidate job {job_name} overrides the read-only workflow token policy"
            )
    paths = _job(source, "paths")
    if not re.search(
        r"^    permissions:\n      contents: read\n      pull-requests: read$",
        paths,
        re.M,
    ):
        errors.append(
            "path classification needs only checkout and PR file listing read permissions"
        )


def _check_trusted_jobs(source: str, errors: list[str]) -> None:
    security_receipt = _job(source, "protected-security-receipt")
    governance = _job(source, "repo-governance")
    for name, block in (
        ("protected security receipt", security_receipt),
        ("governance", governance),
    ):
        token_steps = [step for _, step in _steps(block) if "GH_TOKEN:" in step]
        if not token_steps:
            errors.append(
                f"trusted {name} job lost its narrowly scoped GitHub API token"
            )
        checkouts = [
            step for _, step in _steps(block) if "uses: actions/checkout@v6" in step
        ]
        if not any("ref: refs/heads/main" in step for step in checkouts):
            errors.append(f"{name} token job lacks a Main-owned checkout")
        if name == "protected security receipt" and any(
            "python3 scripts/ci/github_security_receipt.py" not in step
            for step in token_steps
        ):
            errors.append("security token is not scoped to the trusted receipt command")
        if name == "governance" and any(
            "orchestrate.sh governance" not in step for step in token_steps
        ):
            errors.append(
                "governance token is not scoped to the trusted governance command"
            )
    for name, block in (
        ("protected security receipt", security_receipt),
        ("governance", governance),
    ):
        checkouts = [
            step for _, step in _steps(block) if "uses: actions/checkout@v6" in step
        ]
        if not checkouts or any(
            "ref: refs/heads/main" not in step for step in checkouts
        ):
            errors.append(f"{name} must run only from protected Main source")


def _check_candidate_cache(source: str, errors: list[str]) -> None:
    for job_name in CACHE_JOBS:
        block = _job(source, job_name)
        for _, step in _steps(block):
            if "uses: actions/cache" in step and CACHE_TRUSTED not in step:
                errors.append(
                    f"{job_name} cache is not restricted to trusted Main-ref runs"
                )
            if "uses: actions/setup-node@" in step and "cache:" in step:
                if CACHE_TRUSTED not in step:
                    errors.append(
                        f"{job_name} package cache is not restricted to trusted Main-ref runs"
                    )


def check_trust_boundary(workflow: str | None = None) -> list[str]:
    source = workflow if workflow is not None else WORKFLOW.read_text(encoding="utf-8")
    errors: list[str] = []
    _check_trigger(source, errors)
    _check_checkouts(source, errors)
    _check_candidate_jobs(source, errors)
    _check_trusted_jobs(source, errors)
    _check_candidate_cache(source, errors)
    if "MAIN_SYNC_SCRIPT_SHA: ${{ github.workflow_sha }}" not in _job(
        source, "main-freshness-gate"
    ):
        errors.append("freshness validation must use the trusted base-branch script")
    return errors


def _self_test() -> int:
    base = WORKFLOW.read_text(encoding="utf-8")
    failures = check_trust_boundary(base)
    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    mutations = (
        (
            "persisted checkout credential",
            "persist-credentials: false",
            "persist-credentials: true",
        ),
        (
            "candidate token access",
            "CI_SECURITY_RECEIPT_MODE: separate-main-owned-job",
            "GH_TOKEN: ${{ github.token }}",
        ),
        (
            "inherited candidate write permission",
            "permissions:\n  contents: read",
            "permissions:\n  contents: write",
        ),
        (
            "candidate-writable cache",
            "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && 'npm'",
            "'npm'",
        ),
    )
    for label, old, new in mutations:
        if old not in base:
            print(f"FAIL self-test anchor missing: {old}")
            return 1
        errors = check_trust_boundary(base.replace(old, new, 1))
        if not errors:
            print(f"FAIL self-test did not reject {label}")
            return 1
        print(f"ok rejects {label}")
    token_mutation = base.replace(
        "  preflight-gate:\n",
        "  preflight-gate:\n    env:\n      GITHUB_TOKEN: ${{ github.token }}\n",
        1,
    )
    if token_mutation == base or not check_trust_boundary(token_mutation):
        print(
            "FAIL self-test did not reject GitHub token injection into a candidate job"
        )
        return 1
    print("ok rejects GitHub token injection into a candidate job")
    print("ok trusted controller and candidate execution are isolated")
    return 0


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["--self-test"]:
        raise SystemExit(_self_test())
    errors = check_trust_boundary()
    if errors:
        print("PR Validation trust boundary is incomplete:")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)
    print("PR Validation trust boundary is intact")
