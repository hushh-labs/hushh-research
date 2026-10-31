#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Create the exact reviewed UAT auth-health Cloud Run Job."""

from __future__ import annotations

import os
from pathlib import Path

import setup_auth_health as health
from auth_health_uat_common import (
    CHECKER_UNIQUE_ID,
    CLOCK_UNIQUE_ID,
    MUTATION_FAILURES,
    OPERATION,
    PROJECT,
    _account,
    _bucket,
    _refuse,
    _raise_unresolved_mutation,
    _validate_owner,
    _verified_image,
    _verify_job,
    _write_receipt,
)


def install_job(
    operation: str, checker_id: str, clock_id: str, build_id: str, receipt_path: Path
) -> dict:
    """Create the exact UAT Cloud Run Job only; never grant IAM or create a timer."""
    _validate_owner(operation, checker_id, clock_id)
    source = health._reviewed_source()
    run, api = health._transport(PROJECT, build_only=True)
    try:
        bucket, project_number = _bucket(run, api)
        checker = f"auth-health-check@{PROJECT}.iam.gserviceaccount.com"
        _account(run, checker, CHECKER_UNIQUE_ID, PROJECT)
        _account(
            run,
            f"auth-health-clock@{PROJECT}.iam.gserviceaccount.com",
            CLOCK_UNIQUE_ID,
            PROJECT,
        )
        image, build = _verified_image(run, api, build_id, source, bucket)
        intent = {
            "action": "install-job",
            "phase": "install-intent",
            "project": PROJECT,
            "operation": OPERATION,
            "source": source,
            "build_id": build_id,
            "build_source_generation": build["sourceProvenance"][
                "resolvedStorageSource"
            ]["generation"],
            "image": image,
            "checker_unique_id": CHECKER_UNIQUE_ID,
            "clock_unique_id": CLOCK_UNIQUE_ID,
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID"),
            "workflow_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "timer_created": False,
        }
        resource = f"projects/{PROJECT}/locations/{health.REGION}/jobs/{health.JOB}"
        observed = health._existing_resource(
            api, f"https://run.googleapis.com/v2/{resource}", resource
        )
        existing = None
        if observed is not None:
            existing = run(
                ["run", "jobs", "describe", health.JOB, f"--region={health.REGION}"]
            )
            metadata = existing.get("metadata") if isinstance(existing, dict) else None
            if (
                not isinstance(observed.get("uid"), str)
                or not observed["uid"]
                or not isinstance(metadata, dict)
                or metadata.get("uid") != observed["uid"]
            ):
                _refuse("Cloud Run job identity changed during preflight")
        if existing is not None:
            return _accept_existing_job(
                existing, project_number, checker, image, intent, receipt_path
            )
        return _create_owned_job(
            run, project_number, checker, image, intent, receipt_path
        )
    finally:
        api.close()


def _accept_existing_job(
    existing: dict,
    project_number: str,
    checker: str,
    image: str,
    intent: dict,
    receipt_path: Path,
) -> dict:
    metadata = existing.get("metadata", {})
    if metadata.get("labels", {}).get("operation") != OPERATION:
        _refuse("an existing job has a different operation owner")
    job = _verify_job(existing, project_number, checker, image)
    intent.update(phase="installed", job=job, reconciled=True)
    _write_receipt(receipt_path, intent)
    return intent


def _create_owned_job(
    run, project_number: str, checker: str, image: str, intent: dict, receipt_path: Path
) -> dict:
    _write_receipt(receipt_path, intent)
    mutation_error = None
    try:
        run(
            [
                "run",
                "jobs",
                "create",
                health.JOB,
                f"--region={health.REGION}",
                f"--image={image}",
                f"--service-account={checker}",
                "--tasks=1",
                "--parallelism=1",
                "--max-retries=0",
                "--task-timeout=600s",
                "--cpu=1",
                "--memory=512Mi",
                f"--set-env-vars=AUTH_HEALTH_PROJECT={PROJECT},AUTH_PHONE_RUNTIME_HEALTH_ENABLED=true",
                f"--labels=managed_by=repo_observability,purpose=auth_health,operation={OPERATION}",
            ]
        )
    except MUTATION_FAILURES as error:
        mutation_error = error
    try:
        existing = run(
            ["run", "jobs", "describe", health.JOB, f"--region={health.REGION}"],
            optional=True,
        )
        if existing is None:
            _refuse("created job is not visible for exact readback")
        job = _verify_job(existing, project_number, checker, image)
    except MUTATION_FAILURES as read_error:
        intent.update(phase="install-unresolved")
        _write_receipt(receipt_path, intent)
        errors = (mutation_error, read_error) if mutation_error else (read_error,)
        _raise_unresolved_mutation(errors, "Cloud Run job creation")
    reconciled = mutation_error is not None
    intent.update(phase="installed", job=job, reconciled=reconciled)
    _write_receipt(receipt_path, intent)
    return intent
