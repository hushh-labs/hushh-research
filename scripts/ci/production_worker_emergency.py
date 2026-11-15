#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Emergency incident worker source qualification for governed backend staging."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import release_artifact_receipts as receipts

REPOSITORY = "hushh-labs/hushh-research"
WORKFLOW = ".github/workflows/deploy-production.yml"
ACCEPTED_CHECKS = frozenset({"CI Status Gate", "Branch Validation Gate"})
SHA = re.compile(r"[0-9a-f]{40}")
BRANCH = re.compile(r"(?:hotfix|fix)/[A-Za-z0-9][A-Za-z0-9._/-]*")


def _require(condition: object, reason: str) -> None:
    if not condition:
        raise receipts.retention.UnsafeState("Healthy worker basis: " + reason)


def _fresh_authority_read(owner, path: str):
    _require(
        isinstance(path, str) and path.startswith(("runs/", "workflows/")),
        "Emergency authority read left its bounded Actions owner",
    )
    token = owner._API_CACHE.set(None)
    try:
        return owner.api(REPOSITORY, path)
    finally:
        owner._API_CACHE.reset(token)


def _verify_git(
    source: str, source_ref: str, workflow_sha: str, baseline: dict
) -> None:
    try:
        subprocess.run(
            [
                "git",
                "fetch",
                "--no-tags",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
                f"+refs/heads/{source_ref}:refs/remotes/origin/{source_ref}",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        for commit, ref, label in (
            (
                workflow_sha,
                "origin/main",
                "Emergency workflow SHA is not on origin/main",
            ),
            (
                source,
                f"origin/{source_ref}",
                "Emergency candidate is not on its incident branch",
            ),
        ):
            ancestry = subprocess.run(
                ["git", "merge-base", "--is-ancestor", commit, ref],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
            _require(ancestry.returncode == 0, label)
        for kind in ("backend", "frontend"):
            base_sha = (baseline.get(kind) or {}).get("source", "")
            _require(
                bool(SHA.fullmatch(str(base_sha))),
                "Emergency baseline source is invalid",
            )
            ancestry = subprocess.run(
                ["git", "merge-base", "--is-ancestor", base_sha, source],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
            _require(
                ancestry.returncode == 0,
                "Emergency candidate does not preserve serving baselines",
            )
    except subprocess.SubprocessError as error:
        raise receipts.retention.UnsafeState(
            "Healthy worker basis: Emergency git ancestry check failed"
        ) from error


def _verify_ci(owner, ci: object, source: str, source_ref: str) -> None:
    checks = ci.get("checks") if isinstance(ci, dict) else None
    reads = ci.get("authority_reads") if isinstance(ci, dict) else None
    _require(
        isinstance(ci, dict)
        and ci.get("schema_version") == 1
        and ci.get("repository") == REPOSITORY
        and ci.get("sha") == source
        and ci.get("source_branch") == source_ref
        and isinstance(checks, list)
        and bool(checks)
        and isinstance(reads, dict)
        and bool(reads)
        and all(
            isinstance(check, dict)
            and check.get("check") in ACCEPTED_CHECKS
            and type(check.get("run_id")) is int
            and check["run_id"] > 0
            and type(check.get("run_attempt")) is int
            and check["run_attempt"] > 0
            and check.get("workflow") == ".github/workflows/ci.yml"
            and check.get("event") in {"pull_request", "workflow_dispatch"}
            and f"runs/{check['run_id']}" in reads
            for check in checks
        ),
        "Emergency functional CI evidence is invalid",
    )
    fresh_by_path = {}
    for path, expected_digest in reads.items():
        _require(
            isinstance(expected_digest, str)
            and bool(re.fullmatch(r"[0-9a-f]{64}", expected_digest)),
            "Emergency authority read digest is invalid",
        )
        current = _fresh_authority_read(owner, path)
        digest = hashlib.sha256(
            json.dumps(current, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        _require(
            digest == expected_digest, "Emergency CI changed after worker admission"
        )
        fresh_by_path[path] = current
    for check in checks:
        run_payload = fresh_by_path.get(f"runs/{check['run_id']}")
        _require(
            isinstance(run_payload, dict)
            and run_payload.get("id") == check["run_id"]
            and run_payload.get("run_attempt") == check["run_attempt"]
            and run_payload.get("status") == "completed"
            and run_payload.get("conclusion") == "success",
            "Emergency CI qualification run is not a completed success",
        )


def verify_qualification(owner, pin: object, source: str) -> dict:
    _require(
        isinstance(pin, dict) and set(pin) == {"admission", "ci"},
        "Emergency worker qualification receipt is invalid",
    )
    admission = pin.get("admission")
    authority = admission.get("authority") if isinstance(admission, dict) else None
    baseline = admission.get("baseline") if isinstance(admission, dict) else None
    _require(
        isinstance(admission, dict)
        and admission.get("schema_version") == 1
        and admission.get("kind") == "manual-production-predecessor-exception"
        and admission.get("scope") == "backend"
        and admission.get("ordinary_promotion_evidence") is False
        and isinstance(authority, dict)
        and authority.get("mode") == "manual-emergency"
        and authority.get("frontend_auth_domain_refresh") is not True
        and authority.get("application_sha") == source
        and isinstance(baseline, dict)
        and set(baseline) == {"backend", "frontend"},
        "Emergency worker incident admission is invalid",
    )
    source_ref = authority.get("source_ref", "")
    reason = authority.get("reason", "")
    workflow_sha = authority.get("workflow_sha", "")
    run_id = authority.get("run_id", "")
    run_attempt = authority.get("run_attempt", "")
    _require(
        isinstance(source_ref, str)
        and 1 <= len(source_ref) <= 160
        and bool(BRANCH.fullmatch(source_ref))
        and ".." not in source_ref
        and not source_ref.endswith(("/", ".", ".lock"))
        and isinstance(reason, str)
        and 20 <= len(reason.strip()) <= 1000
        and bool(SHA.fullmatch(str(workflow_sha)))
        and bool(re.fullmatch(r"[1-9][0-9]*", str(run_id)))
        and bool(re.fullmatch(r"[1-9][0-9]*", str(run_attempt))),
        "Emergency worker authority fields are invalid",
    )
    _verify_git(source, source_ref, workflow_sha, baseline)
    _verify_ci(owner, pin.get("ci"), source, source_ref)
    stage_run = _fresh_authority_read(owner, f"runs/{run_id}")
    same_attempt = (
        os.environ.get("GITHUB_RUN_ID"),
        os.environ.get("GITHUB_RUN_ATTEMPT"),
    ) == (str(run_id), str(run_attempt))
    run_ok = (
        isinstance(stage_run, dict)
        and stage_run.get("status") in {"in_progress", "completed"}
        and stage_run.get("conclusion") in {None, "success"}
        if same_attempt
        else isinstance(stage_run, dict)
        and stage_run.get("status") == "completed"
        and stage_run.get("conclusion") == "success"
    )
    governed_candidate = (
        {**stage_run, "status": "completed", "conclusion": "success"}
        if same_attempt and run_ok
        else stage_run
    )
    _require(
        isinstance(stage_run, dict)
        and stage_run.get("id") == int(run_id)
        and stage_run.get("run_attempt") == int(run_attempt)
        and stage_run.get("path") == WORKFLOW
        and stage_run.get("head_sha") == workflow_sha
        and (stage_run.get("actor") or {}).get("login") != "github-actions[bot]"
        and owner.governed_dispatch(governed_candidate, REPOSITORY, "production")
        and run_ok,
        "Emergency worker stage run is not a governed active or completed success",
    )
    return copy.deepcopy(pin)


def build_qualification(admission_path: Path, *, source: str, source_ref: str) -> dict:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    _require(bool(token), "GitHub qualification credential is unavailable")
    admission = json.loads(admission_path.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="hussh-emergency-worker-ci-") as directory:
        ci_path = Path(directory) / "ci.json"
        env = dict(
            os.environ,
            GITHUB_REPOSITORY=REPOSITORY,
            GITHUB_TOKEN=token,
            REQUIRED_BRANCH=source_ref,
            REQUIRE_CI_SUCCESS="1",
            REQUIRED_CHECK_NAME="CI Status Gate,Branch Validation Gate",
            REQUIRE_LATEST_FUNCTIONAL_CI="1",
            DEPLOY_SHA_EVIDENCE_OUTPUT=str(ci_path),
        )
        result = subprocess.run(
            [
                "bash",
                str(Path(__file__).with_name("require-deploy-sha-on-main.sh")),
                source,
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        _require(result.returncode == 0, "Emergency functional CI qualification failed")
        ci = json.loads(ci_path.read_text(encoding="utf-8"))
    owner = importlib.import_module("uat-retention-maintenance")
    return verify_qualification(owner, {"admission": admission, "ci": ci}, source)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admission", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    qualified = build_qualification(
        args.admission, source=args.sha, source_ref=args.source_ref
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(qualified, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
