#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Admit public invocation only after both exact preview applications serve."""

import argparse
import json
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from runpy import run_path

BOOTSTRAP = run_path(str(Path(__file__).with_name("commerce-preview-bootstrap.py")))
BootstrapError = BOOTSTRAP["BootstrapError"]


def admit(api, sha, run_id, reports):
    admissions = []
    # Validate both lanes before the first service-wide public IAM mutation.
    for identifier in (BOOTSTRAP["BACKEND"], BOOTSTRAP["FRONTEND"]):
        candidate = reports[identifier]
        expected = candidate.get("expected", {})
        health = candidate.get("http_health", {})
        revisions = candidate.get("checked_revisions", [])
        if (
            candidate.get("ok") is not True
            or candidate.get("service") != identifier
            or candidate.get("project") != BOOTSTRAP["PROJECT"]
            or candidate.get("region") != BOOTSTRAP["REGION"]
            or expected.get("HUSHH_DEPLOY_SHA") != sha
            or expected.get("HUSHH_DEPLOY_RUN_ID") != run_id
            or health.get("status_code") != "200"
            or health.get("authentication") != "workload_identity"
            or len(revisions) != 1
            or revisions[0].get("ok") is not True
        ):
            raise BootstrapError("preview_authenticated_candidate_unverified")
        name = BOOTSTRAP["PARENT"] + "/services/" + identifier
        service = api.request(name)
        current = BOOTSTRAP["inspect"](api, name, service)
        if (
            current["kind"] != "application"
            or current["sha"] != sha
            or current["revision"].rsplit("/", 1)[-1] != revisions[0].get("revision")
            or service.get("invokerIamDisabled", False)
        ):
            raise BootstrapError("preview_application_promotion_unverified")
        admissions.append((name, current))

    for name, _ in admissions:
        policy = api.request(name + ":getIamPolicy")
        bindings = policy.setdefault("bindings", [])
        if any("allAuthenticatedUsers" in b.get("members", []) for b in bindings):
            raise BootstrapError("preview_invoker_policy_unverified")
        binding = next(
            (
                b
                for b in bindings
                if b.get("role") == "roles/run.invoker" and not b.get("condition")
            ),
            None,
        )
        if binding is None:
            binding = {"role": "roles/run.invoker", "members": []}
            bindings.append(binding)
        if "allUsers" not in binding.setdefault("members", []):
            binding["members"].append("allUsers")
            api.request(name + ":setIamPolicy", method="POST", body={"policy": policy})
        verified = api.request(name + ":getIamPolicy")
        if not any(
            b.get("role") == "roles/run.invoker"
            and not b.get("condition")
            and "allUsers" in b.get("members", [])
            for b in verified.get("bindings", [])
        ):
            raise BootstrapError("preview_public_admission_unverified")
    return {
        "verified_at": datetime.now(UTC).isoformat(),
        "sha": sha,
        "run_id": run_id,
        "public_invoker_verified": True,
        "applications": [current for _, current in admissions],
    }


def public_health(origin, path):
    for attempt in range(1, 6):
        result = subprocess.run(  # noqa: S603 - fixed curl flags, provider-verified origin, no credentials.
            [
                "curl",
                "--silent",
                "--show-error",
                "--max-time",
                "15",
                "--output",
                "/dev/null",
                "--write-out",
                "%{http_code}",
                origin + path,
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode == 0 and result.stdout == "200":
            return {"status_code": "200", "attempts": attempt, "authentication": "anonymous"}
        if attempt < 5:
            time.sleep(3)
    raise BootstrapError("preview_public_http_health_unverified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--report-path", required=True, type=Path)
    args = parser.parse_args()
    reports = {
        identifier: json.loads(Path(f"/tmp/dev-candidate-{identifier}.json").read_text())  # noqa: S108 - fixed runner-owned provenance artifact.
        for identifier in (BOOTSTRAP["BACKEND"], BOOTSTRAP["FRONTEND"])
    }
    result = admit(BOOTSTRAP["CloudRun"](), args.sha, args.run_id, reports)
    args.report_path.write_text(json.dumps(result, indent=2) + "\n")
    result["anonymous_health"] = [
        public_health(current["origin"], path)
        for current, path in zip(result["applications"], ("/health", "/login"), strict=True)
    ]
    result["public_http_health_verified"] = True
    args.report_path.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(json.dumps(BOOTSTRAP["safe_failure"](error))) from None
