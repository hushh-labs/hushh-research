#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Select the existing pod build/archive steps without deploying an application."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from copy import deepcopy
from pathlib import Path

import yaml

STEP_IDS = (
    "build-pod-image",
    "resolve-pod-image-digest",
    "publish-azure-pod-release",
)


def build_config(
    root: Path, *, sha: str, run_id: str, attempt: str, verified_reuse_sha: str = ""
) -> dict:
    if not re.fullmatch(r"[a-f0-9]{40}", sha) or any(
        not re.fullmatch(r"[1-9][0-9]{0,19}", value) for value in (run_id, attempt)
    ):
        raise ValueError("Exact source and workflow execution are required")
    reuse = root / "deploy/pod-release-reuse.json"
    if (
        reuse.exists()
        and hashlib.sha256(reuse.read_bytes()).hexdigest() != verified_reuse_sha
    ):
        raise ValueError("Reuse requires the Main-owned unchanged-image source check")
    if not reuse.exists() and verified_reuse_sha:
        raise ValueError("Verified reuse pin is absent")
    source = yaml.safe_load((root / "deploy/backend.cloudbuild.yaml").read_text())
    steps = []
    for index, name in enumerate(STEP_IDS):
        matches = [step for step in source["steps"] if step.get("id") == name]
        if len(matches) != 1:
            raise ValueError("Candidate lacks the canonical pod build interface")
        step = deepcopy(matches[0])
        step["waitFor"] = ["-" if index == 0 else STEP_IDS[index - 1]]
        steps.append(step)
    substitutions = {
        "_DEPLOY_ENV": "dev",
        "_BUILD_POD_IMAGE": "true",
        "_SECRET_PREFIX": "",
        "_IMAGE_TAG": f"dev-{sha}-{run_id}-{attempt}",
        "_DEPLOY_SHA": sha,
        "_GITHUB_RUN_ID": run_id,
    }
    required = set(re.findall(r"\$\{(_[A-Z0-9_]+)\}", json.dumps(steps)))
    if required != set(substitutions):
        raise ValueError(
            "Pod build substitutions changed; review the preparation interface"
        )
    return {
        "steps": steps,
        "substitutions": substitutions,
        "timeout": "1800s",
        "options": {"machineType": "E2_HIGHCPU_8", "logging": "CLOUD_LOGGING_ONLY"},
        "tags": [f"pod-prepare-{run_id}-{attempt}"],
        "artifacts": {
            "objects": {
                "location": "gs://hushh-pda-dev_cloudbuild/pod-preparations/${_DEPLOY_SHA}/${_GITHUB_RUN_ID}/",
                "paths": [
                    "pod-image-provenance.json",
                    "pod-image-manifest.json",
                    "pod-release.json",
                ],
            }
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--verified-reuse-sha", default="")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    value = build_config(
        args.root,
        sha=args.sha,
        run_id=args.run_id,
        attempt=args.attempt,
        verified_reuse_sha=args.verified_reuse_sha,
    )
    args.output.write_text(yaml.safe_dump(value, sort_keys=False))


if __name__ == "__main__":
    main()
