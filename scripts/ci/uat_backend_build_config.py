#!/usr/bin/env python3
"""Schedule UAT's zero-traffic candidates alongside image readiness probes.

Derive from the shared build rather than duplicating its deployment or policy.
The shared template retains its predeployment Vertex gate for other environments.
"""

from __future__ import annotations

import argparse
import json
import re
from copy import deepcopy
from pathlib import Path

import yaml

FRONTEND_STEPS = (
    "resolve-google-contacts-client-config",
    "build-frontend-image",
    "deploy-frontend",
)
SHARED_SUBSTITUTIONS = {
    "_REGION",
    "_DEPLOY_ENV",
    "_DEPLOY_SOURCE",
    "_DEPLOY_SHA",
    "_GITHUB_RUN_ID",
}
CUSTOM_SUBSTITUTION = re.compile(r"(?<!\$)\$\{(_[A-Z0-9_]+)\}")


def substitutions(raw: str, separator: str) -> dict[str, str]:
    values = {}
    for pair in raw.split(separator):
        key, equal, value = pair.partition("=")
        if not equal or not re.fullmatch(r"_[A-Z0-9_]+", key) or key in values:
            raise ValueError("Malformed or duplicate deployment substitution")
        values[key] = value
    return values


def _validate_frontend_release(values: dict, backend: dict) -> None:
    required = {
        "_FRONTEND_SERVICE": "hushh-webapp",
        "_FRONTEND_RUNTIME_SERVICE_ACCOUNT": "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com",
        "_APP_ENV": "uat",
        "_DEPLOY_ENV": "uat",
        "_DEPLOY_SOURCE": "deploy-uat",
        "_SKIP_IMAGE_BUILD": "true",
        "_CLOUD_RUN_NO_TRAFFIC": "true",
        "_SECRET_PREFIX": "",
        "_OBSERVABILITY_ENABLED": "true",
    }
    if (
        any(values.get(key) != value for key, value in required.items())
        or any(values[key] != backend.get(key) for key in SHARED_SUBSTITUTIONS)
        or not re.fullmatch(r"[0-9a-f]{40}", values["_DEPLOY_SHA"])
        or not re.fullmatch(r"[0-9]+", values["_GITHUB_RUN_ID"])
        or not re.fullmatch(r"[1-9][0-9]*", values["_GITHUB_RUN_ATTEMPT"])
        or not re.fullmatch(
            r"gcr\.io/hushh-pda-uat/hushh-webapp@sha256:[0-9a-f]{64}",
            values["_IMAGE_REFERENCE"],
        )
    ):
        raise ValueError(
            "Parallel frontend requires the exact pinned zero-traffic UAT release"
        )


def _validate_frontend_template(
    config: dict, frontend: dict, values: dict, frontend_values: dict
) -> None:
    if (
        set(frontend)
        != {"steps", "timeout", "substitutions", "availableSecrets", "options"}
        or frontend["timeout"] != config["timeout"]
        or {
            key: value
            for key, value in frontend["options"].items()
            if key != "dynamicSubstitutions"
        }
        != config["options"]
        or any(not isinstance(value, str) or "$" in value for value in values.values())
        or frontend_values.keys() - frontend["substitutions"].keys()
        or [step["id"] for step in frontend["steps"]] != list(FRONTEND_STEPS)
        or any(
            step.get("waitFor")
            or step.get("allowFailure")
            or step.get("allowExitCodes")
            for step in frontend["steps"]
        )
        or "availableSecrets" in config
    ):
        raise ValueError(
            "Parallel frontend requires the complete compatible frontend template"
        )


def frontend_parallel_config(
    config: dict, frontend: dict, backend_values: dict, frontend_values: dict
) -> dict:
    """Append the unchanged frontend checks and rollout to one required build.

    Only an already-built immutable UAT image is eligible. Namespace frontend
    settings so its capacity, image and runtime identity cannot alter backend
    settings. Do not enable dynamic substitutions in the shared backend build.
    """
    config = deepcopy(config)
    values = {**frontend["substitutions"], **frontend_values}
    backend = {**config["substitutions"], **backend_values}
    _validate_frontend_release(values, backend)
    _validate_frontend_template(config, frontend, values, frontend_values)
    names = {
        key: key if key in SHARED_SUBSTITUTIONS else "_WEB_" + key[1:] for key in values
    }
    # These templates use braced custom substitutions. Refuse a future syntax
    # change instead of accidentally sharing an unnamespaced backend setting.
    if re.search(r"(?<!\$)\$_[A-Z0-9_]+", json.dumps(frontend)):
        raise ValueError("Parallel frontend requires braced custom substitutions")

    def rename(value):
        if isinstance(value, str):
            return CUSTOM_SUBSTITUTION.sub(
                lambda match: "${" + names[match[1]] + "}", value
            )
        if isinstance(value, list):
            return [rename(item) for item in value]
        if isinstance(value, dict):
            return {key: rename(item) for key, item in value.items()}
        return value

    for index, step in enumerate(rename(frontend["steps"])):
        step["waitFor"] = (
            ["build-backend-image", "verify-runtime-iam"]
            if index == 0
            else [FRONTEND_STEPS[index - 1]]
        )
        if step["id"] in {existing["id"] for existing in config["steps"]}:
            raise ValueError("Cloud Build step identities must be unique")
        config["steps"].append(step)
    config["availableSecrets"] = rename(frontend["availableSecrets"])
    for key, value in values.items():
        if key not in SHARED_SUBSTITUTIONS:
            if names[key] in config["substitutions"]:
                raise ValueError("Frontend substitution namespace collision")
            config["substitutions"][names[key]] = value
    if len(config["substitutions"]) > 200 or any(
        len(key.encode()) > 100 or len(value.encode()) > 4000
        for key, value in config["substitutions"].items()
    ):
        raise ValueError("Combined build exceeds Cloud Build substitution limits")
    return config


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
        != [
            "deploy-backend",
            "verify-azure-pwm-runtime",
            "verify-managed-vertex-runtime",
        ]
        or aggregate.get("allowFailure", False)
        or aggregate.get("allowExitCodes")
        or any(
            steps[provider].get("waitFor")
            != ["build-backend-image", "verify-runtime-iam"]
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
    parser.add_argument(
        "--source", type=Path, default=Path("deploy/backend.cloudbuild.yaml")
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frontend-source", type=Path)
    parser.add_argument("--frontend-substitutions")
    parser.add_argument("--backend-substitutions")
    args = parser.parse_args()
    config = candidate_parallel_config(yaml.safe_load(args.source.read_text()))
    if args.frontend_source:
        config = frontend_parallel_config(
            config,
            yaml.safe_load(args.frontend_source.read_text()),
            substitutions(args.backend_substitutions, "##"),
            substitutions(args.frontend_substitutions, ","),
        )
    args.output.write_text(json.dumps(config, indent=2) + "\n")


if __name__ == "__main__":
    main()
