#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Qualify and activate the exact hourly UAT auth-health timer."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests
import setup_auth_health as health
from auth_health_uat_common import (
    CHECKER_UNIQUE_ID,
    CLOCK_UNIQUE_ID,
    HEALTH_MESSAGE,
    MAX_PROOF_AGE_SECONDS,
    MUTATION_FAILURES,
    OPERATION,
    PHONE_LISTS,
    PROJECT,
    SCHEDULE,
    OperationUnresolved,
    _account,
    _bucket,
    _job_parts,
    _refuse,
    _raise_unresolved_mutation,
    scheduler_matches,
    _validate_owner,
    _verified_image,
    _verify_job,
    _write_receipt,
)

JOB_RESOURCE = f"projects/{PROJECT}/locations/{health.REGION}/jobs/{health.JOB}"


def _execution_proof(run, job: dict, execution_name: str, project_number: str) -> dict:
    prefix = f"{JOB_RESOURCE}/executions/"
    if not isinstance(execution_name, str) or not execution_name.startswith(prefix):
        _refuse("healthy execution must be named under the exact UAT job")
    leaf = execution_name[len(prefix) :]
    if not re.fullmatch(r"protected-configuration-health-[a-z0-9-]{4,64}", leaf):
        _refuse("healthy execution name is malformed")
    execution = run(
        ["run", "jobs", "executions", "describe", leaf, f"--region={health.REGION}"]
    )
    job_meta, _job_spec, _task = _job_parts(job)
    metadata = execution.get("metadata", {})
    expected_owner = [
        {
            "kind": "Job",
            "name": health.JOB,
            "uid": job_meta["uid"],
            "apiVersion": "serving.knative.dev/v1",
            "controller": True,
            "blockOwnerDeletion": True,
        }
    ]
    job_template = job.get("spec", {}).get("template", {}).get("spec")
    status = execution.get("status", {})
    conditions = status.get("conditions", [])
    completed = [row for row in conditions if row.get("type") == "Completed"]
    created = metadata.get("creationTimestamp")
    started = status.get("startTime")
    finished = status.get("completionTime")
    if (
        execution.get("kind") != "Execution"
        or metadata.get("name") != leaf
        or metadata.get("namespace") != project_number
        or not metadata.get("uid")
        or metadata.get("ownerReferences") != expected_owner
        or execution.get("spec") != job_template
        or len(completed) != 1
        or completed[0].get("status") != "True"
        or status.get("succeededCount") != 1
        or status.get("failedCount", 0) != 0
        or not all(isinstance(value, str) for value in (created, started, finished))
    ):
        _refuse("execution is not a successful task of the exact owned job template")

    def parse(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    created_at, start_at, finish_at = map(parse, (created, started, finished))
    now = datetime.now(timezone.utc)
    if (
        created_at < parse(job_meta["creationTimestamp"])
        or start_at < created_at
        or finish_at < start_at
        or (now - finish_at).total_seconds() < 0
        or (now - finish_at).total_seconds() > MAX_PROOF_AGE_SECONDS
    ):
        _refuse("healthy execution is stale or has inconsistent timestamps")
    return {
        "name": execution_name,
        "uid": metadata["uid"],
        "created": created,
        "started": started,
        "finished": finished,
        "log_start": started,
        "log_end": finished,
    }


def _healthy_event(run, execution: dict) -> dict:
    start = execution["log_start"]
    end = execution["log_end"]
    query = (
        f'logName="projects/{PROJECT}/logs/obs-auth-health" '
        f'AND jsonPayload.message="{HEALTH_MESSAGE}" '
        f'AND timestamp>="{start}" AND timestamp<="{end}"'
    )
    events = run(["logging", "read", query, "--limit=2"])
    config = json.loads((health.ROOT / health.FILES[0]).read_text())
    expected_count = sum(
        row.get("project") == PROJECT and row.get("name") in PHONE_LISTS
        for row in config.get("secrets", [])
    )
    if not expected_count or not isinstance(events, list) or len(events) != 1:
        _refuse("exact execution does not have one bounded health event")
    event = events[0]
    payload = event.get("jsonPayload", {})
    labels = event.get("resource", {}).get("labels", {})
    if (
        event.get("logName") != f"projects/{PROJECT}/logs/obs-auth-health"
        or event.get("resource", {}).get("type") != "global"
        or labels.get("project_id") != PROJECT
        or payload
        != {
            "message": HEALTH_MESSAGE,
            "status": "healthy",
            "checked_lists": expected_count,
            "runtime_status": "healthy",
        }
        or event.get("severity") != "INFO"
    ):
        _refuse(
            "execution health event is not the exact healthy UAT runtime observation"
        )
    return {
        "timestamp": event.get("timestamp"),
        "checked_lists": expected_count,
        "status": "healthy",
        "runtime_status": "healthy",
    }


def _policy_grants(policy: dict) -> set[tuple[str, str, str]]:
    bindings = policy.get("bindings", []) if isinstance(policy, dict) else None
    if not isinstance(bindings, list):
        _refuse("Cloud Run job IAM policy is unreadable")
    grants = set()
    for binding in bindings:
        if (
            not isinstance(binding, dict)
            or not isinstance(binding.get("role"), str)
            or not isinstance(binding.get("members"), list)
            or any(not isinstance(member, str) for member in binding["members"])
        ):
            _refuse("Cloud Run job IAM policy is malformed")
        condition = json.dumps(
            binding.get("condition"), sort_keys=True, separators=(",", ":")
        )
        grants.update(
            (binding["role"], member, condition) for member in binding["members"]
        )
    return grants


def _read_job_policy(api, *, after_write: bool = False) -> dict:
    url = f"https://run.googleapis.com/v2/{JOB_RESOURCE}:getIamPolicy"
    try:
        response = api.get(
            url,
            params={"options.requestedPolicyVersion": 3},
            timeout=30,
            allow_redirects=False,
        )
    except Exception:
        if after_write:
            raise OperationUnresolved(
                "clock job invocation binding policy readback is unavailable"
            ) from None
        raise OperationUnresolved(
            "required run.jobs.getIamPolicy read is unavailable"
        ) from None
    if response.status_code != 200:
        if after_write:
            raise OperationUnresolved(
                "clock job invocation binding policy readback was refused"
            )
        if response.status_code == 403:
            _refuse(
                "required permission run.jobs.getIamPolicy on the exact health job is denied"
            )
        _refuse("Cloud Run job IAM policy read was refused")
    try:
        policy = response.json()
    except (ValueError, TypeError):
        if after_write:
            raise OperationUnresolved(
                "clock job invocation binding policy readback is malformed"
            ) from None
        _refuse("Cloud Run job IAM policy read is malformed")
    if (
        not isinstance(policy, dict)
        or not isinstance(policy.get("etag"), str)
        or not policy["etag"]
    ):
        if after_write:
            raise OperationUnresolved(
                "clock job invocation binding policy readback lacks an etag"
            )
        _refuse("Cloud Run job IAM policy lacks a concurrency etag")
    return policy


def _job_invoker(api, clock_email: str) -> dict:
    """Ensure only the clock identity can execute this exact health job."""
    member = f"serviceAccount:{clock_email}"
    role = "roles/run.invoker"
    condition = json.dumps(None)
    before = _read_job_policy(api)
    grants = _policy_grants(before)
    if any(grant[0] == role and grant[1] != member for grant in grants):
        _refuse("Cloud Run job has an unexpected invocation principal")
    if (role, member, condition) in grants:
        return {"state": "already-present", "member": member, "role": role}
    if any(grant[:2] == (role, member) for grant in grants):
        _refuse("clock job invocation binding is conditional and cannot be broadened")

    updated = dict(before)
    updated["bindings"] = [
        *before.get("bindings", []),
        {"role": role, "members": [member]},
    ]
    url = f"https://run.googleapis.com/v2/{JOB_RESOURCE}:setIamPolicy"
    response_status = None
    write_error = False
    try:
        response = api.post(
            url, json={"policy": updated}, timeout=30, allow_redirects=False
        )
        response_status = response.status_code
    except Exception:
        write_error = True
    try:
        after = _read_job_policy(api, after_write=True)
    except OperationUnresolved:
        raise
    observed = _policy_grants(after)
    if not grants.issubset(observed):
        raise OperationUnresolved(
            "clock job invocation binding readback changed an existing grant"
        )
    if any(grant[0] == role and grant[1] != member for grant in observed):
        raise OperationUnresolved(
            "clock job invocation binding readback found an unexpected principal"
        )
    if (role, member, condition) not in observed:
        if response_status == 403:
            _refuse(
                "required permission run.jobs.setIamPolicy on the exact health job is denied"
            )
        if write_error:
            _refuse("clock job invocation write had no effect; no timer was changed")
        if response_status is not None and response_status != 200:
            _refuse(f"Cloud Run job IAM update was refused with HTTP {response_status}")
        raise OperationUnresolved(
            "clock job invocation binding write did not produce its exact postcondition"
        )
    if write_error or response_status != 200:
        return {"state": "reconciled", "member": member, "role": role}
    return {"state": "added", "member": member, "role": role}


def _activation_context(
    run, api, build_id: str, source: str, execution_name: str
) -> dict:
    bucket, project_number = _bucket(run, api)
    checker_email = f"auth-health-check@{PROJECT}.iam.gserviceaccount.com"
    clock_email = f"auth-health-clock@{PROJECT}.iam.gserviceaccount.com"
    _account(run, checker_email, CHECKER_UNIQUE_ID, PROJECT)
    _account(run, clock_email, CLOCK_UNIQUE_ID, PROJECT)
    image, _build = _verified_image(run, api, build_id, source, bucket)
    job = run(["run", "jobs", "describe", health.JOB, f"--region={health.REGION}"])
    job_record = _verify_job(job, project_number, checker_email, image)
    execution = _execution_proof(run, job, execution_name, project_number)
    event = _healthy_event(run, execution)
    return {
        "checker_email": checker_email,
        "clock_email": clock_email,
        "image": image,
        "job": job_record,
        "execution": execution,
        "health_event": event,
    }


def _read_scheduler(api, name: str, clock_email: str) -> tuple[str, dict | None]:
    schedule_url = f"https://cloudscheduler.googleapis.com/v1/{name}"
    scheduler = health._existing_resource(api, schedule_url, name)
    if scheduler is not None:
        if not scheduler_matches(scheduler, name, OPERATION, clock_email, JOB_RESOURCE):
            _refuse("existing timer does not match the exact owned hourly target")
        if scheduler.get("state") not in {"ENABLED", "PAUSED"}:
            _refuse("existing timer is in an unresolved state")
    return schedule_url, scheduler


def _activation_intent(
    source: str,
    build_id: str,
    name: str,
    scheduler: dict | None,
    context: dict,
) -> dict:
    return {
        "action": "activate-timer",
        "phase": "activation-intent",
        "project": PROJECT,
        "operation": OPERATION,
        "source": source,
        "build_id": build_id,
        "image": context["image"],
        "job": context["job"],
        "execution": context["execution"],
        "health_event": context["health_event"],
        "scheduler": name,
        "schedule": SCHEDULE,
        "timer_created": False,
        "prior_state": scheduler.get("state") if scheduler else "ABSENT",
        "iam_effect": {
            "resource": name,
            "member": f"serviceAccount:{context['clock_email']}",
            "role": "roles/run.invoker",
            "condition": None,
            "state": "pending",
        },
    }


def _activate_scheduler(
    run,
    api,
    scheduler: dict | None,
    schedule_url: str,
    name: str,
    clock_email: str,
    intent: dict,
    receipt_path: Path,
) -> dict:
    _write_receipt(receipt_path, intent)
    mutation_error = None
    try:
        if scheduler is None:
            run(
                [
                    "scheduler",
                    "jobs",
                    "create",
                    "http",
                    health.JOB,
                    f"--location={health.REGION}",
                    f"--schedule={SCHEDULE}",
                    "--time-zone=Etc/UTC",
                    f"--uri=https://run.googleapis.com/v2/projects/{PROJECT}/locations/{health.REGION}/jobs/{health.JOB}:run",
                    "--http-method=POST",
                    "--message-body={}",
                    "--headers=Content-Type=application/json",
                    f"--oauth-service-account-email={clock_email}",
                    "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform",
                    "--attempt-deadline=30s",
                    "--max-retry-attempts=0",
                    f"--description=Hussh auth-health operation {OPERATION}",
                ]
            )
        else:
            run(
                [
                    "scheduler",
                    "jobs",
                    "resume",
                    health.JOB,
                    f"--location={health.REGION}",
                ]
            )
    except MUTATION_FAILURES as error:
        mutation_error = error
    try:
        observed = health._existing_resource(api, schedule_url, name)
    except MUTATION_FAILURES + (
        requests.Timeout,
        requests.ConnectionError,
    ) as read_error:
        intent["phase"] = "activation-unresolved"
        _write_receipt(receipt_path, intent)
        if isinstance(read_error, (requests.Timeout, requests.ConnectionError)):
            raise RuntimeError(
                "UAT health installer refused: Cloud Scheduler readback unavailable"
            ) from None
        errors = (mutation_error, read_error) if mutation_error else (read_error,)
        _raise_unresolved_mutation(errors, "Cloud Scheduler mutation")
    if (
        observed is None
        or observed.get("state") != "ENABLED"
        or not scheduler_matches(observed, name, OPERATION, clock_email, JOB_RESOURCE)
    ):
        intent["phase"] = "activation-unresolved"
        _write_receipt(receipt_path, intent)
        if mutation_error:
            _raise_unresolved_mutation((mutation_error,), "Cloud Scheduler mutation")
        _refuse("timer activation readback did not match")
    result = {
        **intent,
        "phase": "active",
        "state": observed["state"],
        "reconciled": mutation_error is not None,
    }
    _write_receipt(receipt_path, result)
    return result


def activate_timer(
    operation: str,
    checker_id: str,
    clock_id: str,
    build_id: str,
    execution_name: str,
    receipt_path: Path,
) -> dict:
    """Ensure exact job invoker and hourly timer only after healthy execution proof."""
    _validate_owner(operation, checker_id, clock_id)
    source = health._reviewed_source()
    run, api = health._transport(PROJECT, build_only=True)
    try:
        context = _activation_context(run, api, build_id, source, execution_name)
        name = JOB_RESOURCE
        schedule_url, scheduler = _read_scheduler(api, name, context["clock_email"])
        intent = _activation_intent(source, build_id, name, scheduler, context)
        _write_receipt(receipt_path, intent)
        try:
            invoker_binding = _job_invoker(api, context["clock_email"])
        except OperationUnresolved:
            intent["phase"] = "invoker-unresolved"
            _write_receipt(receipt_path, intent)
            raise
        except RuntimeError:
            intent["phase"] = "invoker-refused"
            _write_receipt(receipt_path, intent)
            raise
        intent["iam_effect"]["state"] = invoker_binding["state"]
        _write_receipt(receipt_path, intent)
        if scheduler is not None:
            state = scheduler.get("state")
            if state == "ENABLED":
                result = {
                    **intent,
                    "phase": "active",
                    "state": "ENABLED",
                    "reconciled": True,
                }
                _write_receipt(receipt_path, result)
                return result
        return _activate_scheduler(
            run,
            api,
            scheduler,
            schedule_url,
            name,
            context["clock_email"],
            intent,
            receipt_path,
        )
    finally:
        api.close()
