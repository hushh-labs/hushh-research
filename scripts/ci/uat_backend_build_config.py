#!/usr/bin/env python3
"""Schedule UAT's zero-traffic candidate alongside its image readiness probes.

Derive from the shared build rather than duplicating its deployment or policy.
The shared template retains its predeployment Vertex gate for other environments.
"""

from __future__ import annotations

import argparse
import json
from copy import deepcopy
from pathlib import Path

import yaml

UAT_CANDIDATE_COMMAND = """set -euo pipefail
if [[ "$PROJECT_ID" != "hushh-pda-uat" || "$_DEPLOY_ENV" != "uat" ||
      "$_DEPLOY_SOURCE" != "deploy-uat" || "$_BACKEND_SERVICE" != "consent-protocol" ]]; then
  echo "Parallel candidate deployment requires the canonical UAT lane." >&2; exit 1
fi
source scripts/deploy/backend-capacity-settings.sh
IFS='|' read -r prebuilt image tag pod prefix extra <<< "$_IMAGE_SETTINGS"
if [[ "$prebuilt" != "true" || "$pod" != "false" || -n "$prefix$extra" ||
      ! "$image" =~ ^gcr[.]io/hushh-pda-uat/consent-protocol@sha256:[0-9a-f]{64}$ ||
      ! "$_GITHUB_RUN_ID" =~ ^[0-9]+$ || "$tag" != "account-deletion-${_GITHUB_RUN_ID}" ||
      "${_CLOUD_RUN_NO_TRAFFIC:-}" != "true" ]]; then
  echo "Parallel candidate requires a pinned, zero-traffic UAT image." >&2; exit 1
fi
exec bash scripts/deploy/backend-deploy.sh
"""


def candidate_parallel_config(source: dict) -> dict:
    config = deepcopy(source)
    steps = {step["id"]: step for step in config["steps"]}
    if len(steps) != len(config["steps"]):
        raise ValueError("Cloud Build step identities must be unique")
    deploy = steps["deploy-backend"]
    aggregate = steps["verify-managed-provider-readiness"]
    providers = {"verify-azure-pwm-runtime", "verify-managed-vertex-runtime"}
    if (
        deploy.get("waitFor")
        != [
            "resolve-pod-image-digest",
            "publish-azure-pod-release",
            "verify-managed-vertex-runtime",
        ]
        or deploy.get("entrypoint") != "bash"
        or deploy.get("args") != ["scripts/deploy/backend-deploy.sh"]
        or aggregate.get("waitFor")
        != ["deploy-backend", "verify-azure-pwm-runtime", "verify-managed-vertex-runtime"]
        or aggregate.get("allowFailure", False)
        or aggregate.get("allowExitCodes")
        or any(
            steps[provider].get("waitFor") != ["build-backend-image", "verify-runtime-iam"]
            for provider in providers
        )
    ):
        raise ValueError("UAT scheduling requires the complete known readiness DAG")
    deploy["waitFor"] = [
        "resolve-pod-image-digest",
        "publish-azure-pod-release",
        "verify-runtime-iam",
    ]
    # Shell variables come from the unchanged step env, not substitutions.
    deploy["args"] = ["-c", UAT_CANDIDATE_COMMAND.replace("$", "$$")]
    return config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("deploy/backend.cloudbuild.yaml"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = candidate_parallel_config(yaml.safe_load(args.source.read_text()))
    args.output.write_text(json.dumps(config, indent=2) + "\n")


if __name__ == "__main__":
    main()
