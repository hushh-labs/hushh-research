#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Shared exact-resource checks for the UAT auth-health installer."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import setup_auth_health as health

PROJECT = "hushh-pda-uat"
OPERATION = "81b4233b2c6840e59b26982ccb0d2db5"
CHECKER_UNIQUE_ID = "112891356763771456056"
CLOCK_UNIQUE_ID = "111681910958362407355"
ROLE = "projects/hushh-pda-uat/roles/husshAuthHealthSecretReader"
SCHEDULE = "17 * * * *"
MAX_PROOF_AGE_SECONDS = 1800
HEALTH_MESSAGE = "auth.test_allowlist.health"
PHONE_LISTS = {"HUSHH_UAT_PHONE_TEST_NUMBERS", "HUSHH_PROD_PHONE_TEST_NUMBERS"}


def scheduler_matches(
    job: dict, name: str, operation: str, clock_email: str, job_resource: str
) -> bool:
    target = job.get("httpTarget", {})
    oauth = target.get("oauthToken", {})
    retry = job.get("retryConfig", {})
    headers = target.get("headers")
    expected_headers = {"Content-Type": "application/json"}
    if isinstance(headers, dict) and "User-Agent" in headers:
        expected_headers["User-Agent"] = "Google-Cloud-Scheduler"
    return (
        job.get("name") == name
        and job.get("description") == f"Hussh auth-health operation {operation}"
        and job.get("schedule") == SCHEDULE
        and job.get("timeZone") == "Etc/UTC"
        and target.get("uri") == f"https://run.googleapis.com/v2/{job_resource}:run"
        and target.get("httpMethod") == "POST"
        and target.get("body") == base64.b64encode(b"{}").decode("ascii")
        and headers == expected_headers
        and oauth.get("serviceAccountEmail") == clock_email
        and oauth.get("scope") == "https://www.googleapis.com/auth/cloud-platform"
        and retry.get("retryCount", 0) in {0, "0"}
        and job.get("attemptDeadline") in {"30s", "30.000s"}
    )


def _refuse(message: str):
    raise RuntimeError(f"UAT health installer refused: {message}")


class OperationUnresolved(RuntimeError):
    """A single mutation was attempted, but its exact postcondition is unreadable."""


MUTATION_FAILURES = (RuntimeError, subprocess.TimeoutExpired)


def _raise_unresolved_mutation(
    errors: tuple[BaseException, ...], resource: str
) -> None:
    if any(isinstance(error, subprocess.TimeoutExpired) for error in errors):
        raise RuntimeError(
            f"UAT health installer refused: {resource} timed out; exact readback unavailable"
        ) from None
    raise errors[0]


def _validate_owner(operation: str, checker_id: str, clock_id: str) -> None:
    if (
        operation != OPERATION
        or checker_id != CHECKER_UNIQUE_ID
        or clock_id != CLOCK_UNIQUE_ID
    ):
        _refuse("prepared operation or service-account identity changed")


def _require_member(policy: dict, role: str, email: str) -> None:
    member = f"serviceAccount:{email}"
    if not isinstance(policy, dict) or not isinstance(policy.get("bindings"), list):
        _refuse("required existing IAM policy is unreadable")
    if not any(
        isinstance(binding, dict)
        and binding.get("role") == role
        and binding.get("condition") is None
        and member in binding.get("members", [])
        for binding in policy["bindings"]
    ):
        _refuse("required existing health permission is absent or conditional")


def _account(run, email: str, unique_id: str, project: str) -> dict:
    account = run(["iam", "service-accounts", "describe", email])
    if (
        not isinstance(account, dict)
        or account.get("email") != email
        or account.get("projectId") != project
        or account.get("uniqueId") != unique_id
        or account.get("description") != f"Hussh auth-health operation {OPERATION}"
        or account.get("disabled") is True
    ):
        _refuse("existing service-account identity changed")
    return account


def _bucket(run, api) -> tuple[str, str]:
    number = run(["projects", "describe", PROJECT]).get("projectNumber")
    bucket = f"{PROJECT}-auth-health-ops"
    observed = health._existing_resource(
        api, f"https://storage.googleapis.com/storage/v1/b/{bucket}", bucket
    )
    if observed is None or not str(number).isdecimal():
        _refuse("prepared operations bucket is absent")
    labels = observed.get("labels")
    iam = observed.get("iamConfiguration")
    uniform = iam.get("uniformBucketLevelAccess") if isinstance(iam, dict) else None
    if (
        str(observed.get("projectNumber")) != str(number)
        or not isinstance(labels, dict)
        or labels.get("operation") != OPERATION
        or not isinstance(uniform, dict)
        or uniform.get("enabled") is not True
        or iam.get("publicAccessPrevention") != "enforced"
    ):
        _refuse("operations bucket ownership or safety configuration changed")

    checker = f"auth-health-check@{PROJECT}.iam.gserviceaccount.com"
    _require_member(
        run(["storage", "buckets", "get-iam-policy", f"gs://{bucket}"]),
        "roles/storage.objectUser",
        checker,
    )
    _require_member(
        run(["projects", "get-iam-policy", PROJECT]), "roles/logging.logWriter", checker
    )
    custom_role = run(["iam", "roles", "describe", "husshAuthHealthSecretReader"])
    if set(custom_role.get("includedPermissions", [])) != {
        "secretmanager.versions.list",
        "secretmanager.versions.access",
    }:
        _refuse("existing health reader role has unexpected permissions")
    config = json.loads((health.ROOT / health.FILES[0]).read_text())
    for secret in config["secrets"]:
        if secret["project"] == PROJECT:
            _require_member(
                run(["secrets", "get-iam-policy", secret["name"]]), ROLE, checker
            )
    service_policy = run(
        [
            "run",
            "services",
            "get-iam-policy",
            "consent-protocol",
            f"--region={health.REGION}",
        ]
    )
    if not health._has_runtime_permission(service_policy, checker):
        _refuse("existing service-level runtime observation permission is absent")
    return bucket, str(number)


def _verified_image(
    run, api, build_id: str, source: str, bucket: str
) -> tuple[str, dict]:
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", build_id
    ):
        _refuse("Cloud Build ID is malformed")
    tag = f"gcr.io/{PROJECT}/auth-health-job:{source}"
    expected_tags = {f"auth-health-{OPERATION}", f"auth-health-source-{source}"}
    matches = run(
        [
            "builds",
            "list",
            f"--filter=tags:auth-health-{OPERATION} AND tags:auth-health-source-{source}",
            "--limit=2",
        ]
    )
    if (
        not isinstance(matches, list)
        or len(matches) != 1
        or matches[0].get("id") != build_id
        or set(matches[0].get("tags", [])) != expected_tags
        or tag not in matches[0].get("images", [])
    ):
        _refuse("Cloud Build is not the successful operation-bound source build")
    build = run(["builds", "describe", build_id])
    if (
        not isinstance(build, dict)
        or build.get("id") != build_id
        or build.get("status") != "SUCCESS"
        or set(build.get("tags", [])) != expected_tags
        or tag not in build.get("images", [])
    ):
        _refuse("Cloud Build detail is not the successful operation-bound source build")

    def existing_build(args, *, optional=False):
        if args[:2] == ["builds", "list"]:
            return [build]
        return run(args, optional=optional)

    image, observed_build_id = health._image(
        existing_build, api, PROJECT, OPERATION, source, bucket, lambda **_: None
    )
    if observed_build_id != build_id:
        _refuse("verified image does not belong to the supplied Cloud Build ID")
    return image, build


def _job_parts(job: dict) -> tuple[dict, dict, dict]:
    metadata = job.get("metadata")
    job_template = job.get("spec", {}).get("template")
    job_spec = job_template.get("spec") if isinstance(job_template, dict) else None
    task = (
        job_spec.get("template", {}).get("spec") if isinstance(job_spec, dict) else None
    )
    if not all(isinstance(value, dict) for value in (metadata, job_spec, task)):
        _refuse("Cloud Run job metadata or template is malformed")
    return metadata, job_spec, task


def _verify_job(job: dict, project_number: str, checker_email: str, image: str) -> dict:
    metadata, job_spec, task = _job_parts(job)
    containers = task.get("containers")
    if not isinstance(containers, list) or len(containers) != 1:
        _refuse("health job must have one reviewed container")
    container = containers[0]
    labels = metadata.get("labels", {})
    env = {row.get("name"): row.get("value") for row in container.get("env", [])}
    timeout = task.get("timeoutSeconds")
    if container.get("image") != image:
        _refuse("existing job has a different image")
    if (
        metadata.get("name") != health.JOB
        or metadata.get("namespace") != project_number
        or not isinstance(metadata.get("uid"), str)
        or not metadata["uid"]
        or labels.get("operation") != OPERATION
        or labels.get("managed_by") != "repo_observability"
        or labels.get("purpose") != "auth_health"
        or job_spec.get("taskCount") != 1
        or job_spec.get("parallelism") != 1
        or task.get("serviceAccountName") != checker_email
        or task.get("maxRetries") != 0
        or timeout not in {"600", 600}
        or len(container) != 3
        or env
        != {"AUTH_HEALTH_PROJECT": PROJECT, "AUTH_PHONE_RUNTIME_HEALTH_ENABLED": "true"}
        or container.get("resources", {}).get("limits")
        != {"cpu": "1", "memory": "512Mi"}
    ):
        _refuse(
            "Cloud Run job does not match the exact operation, identity, image, and runtime"
        )
    return {
        "name": metadata["name"],
        "namespace": metadata["namespace"],
        "uid": metadata["uid"],
        "generation": metadata.get("generation"),
        "image": image,
        "checker": checker_email,
    }


def _write_receipt(path: Path, receipt: dict) -> None:
    if path.is_symlink():
        _refuse("receipt path cannot be a symlink")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            json.dump(receipt, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def record_intent(
    action: str,
    operation: str,
    checker_id: str,
    clock_id: str,
    build_id: str,
    execution_name: str | None,
    receipt_path: Path,
) -> dict:
    """Persist a sanitized, source-bound request before any cloud mutation."""
    if action not in {"install-job", "activate-timer"}:
        _refuse("intent action is not a UAT installer operation")
    _validate_owner(operation, checker_id, clock_id)
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", build_id
    ):
        _refuse("Cloud Build ID is malformed")
    expected_prefix = (
        f"projects/{PROJECT}/locations/{health.REGION}/jobs/{health.JOB}/executions/"
    )
    if action == "activate-timer":
        if (
            not isinstance(execution_name, str)
            or not execution_name.startswith(expected_prefix)
            or not re.fullmatch(
                r"protected-configuration-health-[a-z0-9-]{4,64}",
                execution_name[len(expected_prefix) :],
            )
        ):
            _refuse("activation intent requires an exact UAT execution resource name")
    elif execution_name is not None:
        _refuse("job installation does not accept an execution name")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not run_id.isdecimal() or not attempt.isdecimal():
        _refuse("intent requires the current workflow run and attempt")
    receipt = {
        "action": action,
        "phase": "requested",
        "project": PROJECT,
        "operation": OPERATION,
        "source": health._reviewed_source(),
        "build_id": build_id,
        "checker_unique_id": CHECKER_UNIQUE_ID,
        "clock_unique_id": CLOCK_UNIQUE_ID,
        "execution": execution_name,
        "workflow_run_id": run_id,
        "workflow_run_attempt": attempt,
        "timer_created": False,
        "iam_effect": (
            {
                "resource": f"projects/{PROJECT}/locations/{health.REGION}/jobs/{health.JOB}",
                "member": f"serviceAccount:auth-health-clock@{PROJECT}.iam.gserviceaccount.com",
                "role": "roles/run.invoker",
                "condition": None,
                "when": "after exact healthy execution proof, before timer activation",
            }
            if action == "activate-timer"
            else None
        ),
    }
    _write_receipt(receipt_path, receipt)
    return receipt
