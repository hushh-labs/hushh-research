#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Manual production predecessor exception; never a compatibility waiver.

The existing workflow owns source CI, builds, schema, rollback and health. This
module binds explicit incident authority to the actual paired serving baseline.
It neither deploys resources nor fabricates a Dev/UAT acceptance receipt.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import re
import subprocess

SHA = re.compile(r"[0-9a-f]{40}")
SERVICES = {"backend": "consent-protocol", "frontend": "hushh-webapp"}
ROOT = Path(__file__).resolve().parents[2]


def require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def dispatch(event: dict, environment: dict, policy: dict) -> dict:
    inputs = event.get("inputs") or {}
    source_ref = inputs.get("emergency_source_ref", "")
    reason = inputs.get("emergency_reason", "")
    if not source_ref and not reason:
        return {"mode": "ordinary"}
    repository = "hushh-labs/hushh-research"
    require(
        environment.get("GITHUB_REPOSITORY") == repository
        and environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and environment.get("GITHUB_REF") == "refs/heads/main"
        and environment.get("GITHUB_WORKFLOW_REF")
        == f"{repository}/.github/workflows/deploy-production.yml@refs/heads/main"
        and SHA.fullmatch(environment.get("GITHUB_SHA", "")),
        "Emergency production requires the trusted Main manual workflow",
    )
    actors = {
        environment.get("GITHUB_ACTOR"),
        environment.get("GITHUB_TRIGGERING_ACTOR"),
    }
    require(
        actors.issubset(set(policy["production"]["manual_dispatch_users"])),
        "Emergency production requires governed original and triggering operators",
    )
    require(
        isinstance(source_ref, str)
        and 1 <= len(source_ref) <= 160
        and re.fullmatch(r"(?:hotfix|fix)/[A-Za-z0-9][A-Za-z0-9._/-]*", source_ref)
        and ".." not in source_ref
        and not source_ref.endswith(("/", ".", ".lock"))
        and isinstance(reason, str)
        and 20 <= len(reason.strip()) <= 1000
        and all(ord(char) >= 32 for char in reason)
        and SHA.fullmatch(inputs.get("sha", "")),
        "Emergency production needs an incident branch, immutable source and meaningful reason",
    )
    incompatible = (
        "main_approval_sha",
        "cadence_origin",
        "cadence_ordinal",
        "restoration_validation_run",
        "restoration_activation_run_id",
        "restoration_activation_attempt",
        "phone_rollback_sha",
        "phone_activation_run_id",
        "phone_worker_stage_run_id",
        "phone_schema_origin_run_id",
        "phone_schema_origin_attempt",
    )
    require(
        not any(inputs.get(key) for key in incompatible)
        and inputs.get("phone_phase", "standard") == "standard"
        and inputs.get("backend_image_source", "build-from-source")
        == "build-from-source"
        and inputs.get("drive_live_mode", "preserve") == "preserve"
        and inputs.get("enable_one_email_kyc", "false") in (False, "false"),
        "Emergency authority cannot mix with cadence, recovery, transitions or new capabilities",
    )
    return {
        "mode": "manual-emergency",
        "application_sha": inputs["sha"],
        "source_ref": source_ref,
        "reason": reason.strip(),
        "workflow_sha": environment["GITHUB_SHA"],
        "actor": environment["GITHUB_ACTOR"],
        "triggering_actor": environment["GITHUB_TRIGGERING_ACTOR"],
        "run_id": environment["GITHUB_RUN_ID"],
        "run_attempt": environment["GITHUB_RUN_ATTEMPT"],
    }


def command(*args: str) -> str:
    result = subprocess.run(
        args, text=True, capture_output=True, timeout=45, check=True
    )  # noqa: S603
    require(
        len(result.stdout.encode()) <= 4 * 1024 * 1024,
        "Provider response exceeded its bound",
    )
    return result.stdout


def provider(kind: str, name: str) -> dict:
    result = json.loads(
        command(
            "gcloud",
            "run",
            kind,
            "describe",
            name,
            "--project=hushh-pda",
            "--region=us-central1",
            "--format=json",
        )
    )
    require(isinstance(result, dict), "Provider response is not an object")
    return result


def baseline(service: dict, revision: dict, name: str) -> dict:
    serving = importlib.import_module("resolve-cloud-run-serving-state")
    selected = serving.resolve_serving_state(service).revision
    metadata, status = revision.get("metadata", {}), revision.get("status", {})
    labels = metadata.get("labels", {})
    service_metadata = service.get("metadata", {})
    principal = revision.get("spec", {}).get("serviceAccountName", "")
    source = labels.get("deploy-sha", "")
    image = status.get("imageDigest", "")
    generation = str(service_metadata.get("generation", ""))

    def ready(value):
        return any(
            row.get("type") == "Ready" and row.get("status") == "True"
            for row in value.get("status", {}).get("conditions", [])
        )

    require(
        name in SERVICES.values()
        and service_metadata.get("name") == name
        and bool(service_metadata.get("uid"))
        and bool(metadata.get("uid"))
        and metadata.get("name") == selected
        and labels.get("serving.knative.dev/service") == name
        and labels.get("deploy-env") == "production"
        and labels.get("deploy-source") == "deploy-production"
        and SHA.fullmatch(source)
        and re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", image)
        and re.fullmatch(r"[a-z0-9-]+@hushh-pda\.iam\.gserviceaccount\.com", principal)
        and ready(service)
        and ready(revision)
        and re.fullmatch(r"[1-9][0-9]{0,18}", generation)
        and str(service.get("status", {}).get("observedGeneration")) == generation,
        "Emergency baseline requires healthy, current, immutable production identities",
    )
    return {
        "service": name,
        "service_uid": service_metadata["uid"],
        "generation": generation,
        "revision": selected,
        "revision_uid": metadata["uid"],
        "source": source,
        "image": image,
        "workload_principal": principal,
    }


def capture(read=provider) -> dict:
    serving = importlib.import_module("resolve-cloud-run-serving-state")
    result = {}
    for kind, name in SERVICES.items():
        service = read("services", name)
        selected = serving.resolve_serving_state(service).revision
        result[kind] = baseline(service, read("revisions", selected), name)
    return result


def admit(authority: dict, observed: dict, scope: str, *, run=command) -> dict:
    require(
        authority.get("mode") == "manual-emergency",
        "Explicit emergency authority is missing",
    )
    require(
        scope in {"all", "backend", "frontend"},
        "A resolved deployment scope is required",
    )
    application = authority["application_sha"]
    for kind in SERVICES:
        source = observed[kind]["source"]
        # A scoped patch must not discard either side of the serving pair.
        run("git", "fetch", "--no-tags", "origin", source)
        run("git", "merge-base", "--is-ancestor", source, application)
    return {
        "schema_version": 1,
        "kind": "manual-production-predecessor-exception",
        "authority": authority,
        "scope": scope,
        "baseline": observed,
        "waived": ["dev-deployment-acceptance", "uat-deployment-acceptance"],
        "required": [
            "exact-source-ci",
            "schema-compatibility",
            "qualified-rollback",
            "health",
            "provenance",
        ],
        "ordinary_promotion_evidence": False,
    }


def recheck(receipt: dict, authority: dict, observed: dict) -> None:
    require(
        receipt.get("schema_version") == 1
        and receipt.get("kind") == "manual-production-predecessor-exception"
        and receipt.get("authority") == authority
        and receipt.get("baseline") == observed
        and receipt.get("ordinary_promotion_evidence") is False,
        "Incident authority or serving baseline changed; no mutation is admitted",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("dispatch", "admit", "recheck"))
    parser.add_argument("--scope", default="")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        policy = json.loads(
            (
                Path(__file__).with_name("ci-governance.json")
                if Path(__file__).with_name("ci-governance.json").exists()
                else ROOT / "config/ci-governance.json"
            ).read_text()
        )
        authority = dispatch(event, dict(os.environ), policy)
        if args.mode == "dispatch":
            with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
                output.write(f"mode={authority['mode']}\n")
                output.write(f"branch={authority.get('source_ref', 'main')}\n")
            return 0
        require(
            args.output is not None, "The immutable incident receipt path is required"
        )
        if args.mode == "admit":
            receipt = admit(authority, capture(), args.scope)
            with args.output.open("x", encoding="utf-8") as output:
                json.dump(receipt, output, indent=2)
        else:
            recheck(json.loads(args.output.read_text()), authority, capture())
        print(
            "Manual incident boundary verified; normal lifecycle and rollback gates remain required."
        )
        return 0
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        print(
            "Emergency production refused: source, authority or serving evidence is unavailable."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
