#!/usr/bin/env python3
"""Read-only, revision-bound admission for already qualified answer settlement."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

TARGETS = {
    "dev": (
        "hushh-pda-dev",
        "https://consent-protocol-621416509462.us-central1.run.app",
    ),
    "uat": ("hushh-pda-uat", "https://api.uat.hushh.ai"),
    "production": ("hushh-pda", "https://api.hushh.ai"),
}
STAGES = ("timeouts", "refunds", "payouts")
LOCATION = "us-central1"


def job_configuration(job: dict, environment: str, stage: str) -> dict:
    """A known name alone never authorizes a foreign job or token destination."""
    project, origin = TARGETS[environment]
    if stage not in STAGES:
        raise ValueError("Unknown answer settlement stage")
    target = job.get("httpTarget") or {}
    retry = job.get("retryConfig") or {}
    expected = {
        "name": f"projects/{project}/locations/{LOCATION}/jobs/answer-work-{stage}-{environment}",
        "state": "ENABLED",
        "schedule": "*/5 * * * *",
        "timeZone": "Etc/UTC",
        "attemptDeadline": "180s",
        "httpMethod": "POST",
        "uri": f"{origin}/api/internal/answer-work/drain?stage={stage}",
        "oidcToken": {
            "serviceAccountEmail": f"answer-work-drain-sched@{project}.iam.gserviceaccount.com",
            "audience": origin,
        },
        "body": "",
        "retryCount": 3,
        "minBackoffDuration": "10s",
        "maxBackoffDuration": "120s",
        "maxDoublings": 3,
        "maxRetryDuration": "0s",
    }
    actual = {
        **{
            key: job.get(key)
            for key in ("name", "state", "schedule", "timeZone", "attemptDeadline")
        },
        **{key: target.get(key) for key in ("httpMethod", "uri", "oidcToken")},
        "body": target.get("body", ""),
        **{
            key: retry.get(key)
            for key in (
                "retryCount",
                "minBackoffDuration",
                "maxBackoffDuration",
                "maxDoublings",
            )
        },
        "maxRetryDuration": retry.get("maxRetryDuration", "0s"),
    }
    if actual != expected or target.get("oauthToken"):
        raise ValueError(
            "Answer settlement job is absent, paused or outside its reviewed configuration"
        )
    if any(
        key.lower() in {"authorization", "cookie"} for key in target.get("headers", {})
    ):
        raise ValueError("Answer settlement job contains unexpected credentials")
    return expected


def _tool(directory: Path, name: str):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), directory / f"{name}.py"
    )
    if not spec or not spec.loader:
        raise ValueError("Trusted settlement verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _cloud(*arguments: str):
    result = subprocess.run(
        [shutil.which("gcloud") or "gcloud", *arguments, "--format=json"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise ValueError("Answer settlement cloud evidence is unavailable")
    return json.loads(result.stdout)


def _revision_backend(environment: str, revision: str) -> tuple[dict, str]:
    project, _ = TARGETS[environment]
    if not revision:
        raise ValueError("An exact backend revision is required")
    installed = _cloud(
        "run",
        "revisions",
        "describe",
        revision,
        f"--project={project}",
        f"--region={LOCATION}",
    )
    containers = (installed.get("spec") or {}).get("containers") or []
    if len(containers) != 1:
        raise ValueError("Answer settlement requires one known backend container")
    values = {item["name"]: item.get("value") for item in containers[0].get("env", [])}
    digest = str((installed.get("status") or {}).get("imageDigest") or "")
    ready = any(
        condition.get("type") == "Ready"
        and str(condition.get("status")).lower() == "true"
        for condition in (installed.get("status") or {}).get("conditions", [])
    )
    if not ready or not re.search(r"sha256:[0-9a-f]{64}$", digest):
        raise ValueError("Answer settlement predecessor is not a ready immutable image")
    return values, digest


def _serving_backend(environment: str, revision: str, tools: Path) -> tuple[dict, str]:
    project, _ = TARGETS[environment]
    serving = _tool(tools, "resolve-cloud-run-serving-state")
    service = _cloud(
        "run",
        "services",
        "describe",
        "consent-protocol",
        f"--project={project}",
        f"--region={LOCATION}",
    )
    if not revision or serving.resolve_serving_state(service).revision != revision:
        raise ValueError("Answer settlement serving baseline changed")
    return _revision_backend(environment, revision)


def verify_candidate(
    environment: str, revision: str, *, payments: bool, drain: bool
) -> dict:
    """Check installed flags, not merely requested build substitutions."""
    values, digest = _revision_backend(environment, revision)
    _, origin = TARGETS[environment]
    expected = {
        "PKM_ANSWER_PAYMENTS_ENABLED": str(payments).lower(),
        "ANSWER_WORK_DRAIN_ENABLED": str(drain).lower(),
        "ANSWER_WORK_DRAIN_AUDIENCE": origin,
    }
    if any(values.get(key) != value for key, value in expected.items()):
        raise ValueError("Installed answer settings differ from the admitted release")
    if payments and not drain:
        raise ValueError("New paid answers require independently enabled settlement")
    return {"revision": revision, "image_digest": digest, "settings": expected}


def _candidate_execution(
    logs: list, *, revision: str, uri: str, not_before: datetime
) -> dict | None:
    for row in logs:
        request = row.get("httpRequest") or {}
        try:
            when = datetime.fromisoformat(
                str(row.get("timestamp", "")).replace("Z", "+00:00")
            )
            status = int(request.get("status", 0))
        except (TypeError, ValueError):
            continue
        if (
            when.tzinfo is not None
            and when >= not_before
            and (row.get("resource") or {}).get("labels", {}).get("revision_name")
            == revision
            and request.get("requestUrl") == uri
            and request.get("requestMethod") == "POST"
            and 200 <= status < 300
        ):
            return {
                "revision": revision,
                "started_at": row["timestamp"],
                "insert_id": row.get("insertId", ""),
                "uri": uri,
                "http_status": status,
            }
    return None


class PendingSettlement(ValueError):
    """Only observed log-publication lag or transient HTTP completion may wait."""


def verify_paid_admission(
    environment: str,
    revision: str,
    tools: Path,
    *,
    baseline: dict | None = None,
    not_before: datetime | None = None,
    retry_pending: bool = False,
) -> dict:
    """Never create jobs or execute financial work while checking admission."""
    project, origin = TARGETS[environment]
    completion = _tool(tools, "verify-cloud-scheduler-attempt")
    values, digest = _serving_backend(environment, revision, tools)
    if (
        values.get("ANSWER_WORK_DRAIN_ENABLED") != "true"
        or values.get("ANSWER_WORK_DRAIN_AUDIENCE") != origin
    ):
        raise ValueError(
            "Qualify a settlement-enabled predecessor before enabling new payments"
        )
    identity_email = f"answer-work-drain-sched@{project}.iam.gserviceaccount.com"
    account = _cloud(
        "iam", "service-accounts", "describe", identity_email, f"--project={project}"
    )
    if account.get("email") != identity_email or account.get("disabled") is True:
        raise ValueError("Answer settlement identity is unavailable")
    configs, executions = {}, {}
    for stage in STAGES:
        name = f"answer-work-{stage}-{environment}"
        job = _cloud(
            "scheduler",
            "jobs",
            "describe",
            name,
            f"--project={project}",
            f"--location={LOCATION}",
        )
        config = job_configuration(job, environment, stage)
        configs[stage] = hashlib.sha256(
            json.dumps(config, sort_keys=True).encode()
        ).hexdigest()
        cutoff = datetime.now(UTC) - timedelta(minutes=15)
        updated = completion.parse_instant(job.get("userUpdateTime"))
        cutoff = max(cutoff, updated)
        uri = config["uri"]
        query = (
            f'resource.type="cloud_scheduler_job" AND resource.labels.job_id="{name}" '
            f'AND timestamp>="{cutoff.isoformat()}"'
        )
        logs = _cloud(
            "logging",
            "read",
            query,
            f"--project={project}",
            "--order=desc",
            "--limit=20",
            "--freshness=30m",
        )
        observed = completion.successful_completion(
            logs, triggered_at=cutoff, expected_job=config["name"], expected_uri=uri
        )
        if observed is None:
            if retry_pending and completion.completion_state(
                logs, triggered_at=cutoff, expected_job=config["name"], expected_uri=uri
            ) in {"pending", "transient_failure"}:
                raise PendingSettlement(
                    f"Answer settlement {stage} completion is pending"
                )
            raise ValueError(
                f"Answer settlement {stage} lacks fresh authenticated completion"
            )
        executions[stage] = observed
        if not_before is not None:
            logs = _cloud(
                "logging",
                "read",
                f'resource.type="cloud_run_revision" AND resource.labels.revision_name="{revision}" '
                f'AND httpRequest.requestUrl="{uri}" AND timestamp>="{not_before.isoformat()}"',
                f"--project={project}",
                "--order=desc",
                "--limit=20",
                "--freshness=30m",
            )
            execution = _candidate_execution(
                logs, revision=revision, uri=uri, not_before=not_before
            )
            if not execution:
                if retry_pending and logs == []:
                    raise PendingSettlement(
                        f"Answer settlement {stage} candidate execution is pending"
                    )
                raise ValueError(
                    f"Answer settlement {stage} has not executed on the serving candidate"
                )
            executions[stage]["candidate_request"] = execution
    identity = {
        "environment": environment,
        "revision": revision,
        "image_digest": digest,
        "jobs": configs,
    }
    if baseline is not None and baseline.get("identity") != identity:
        raise ValueError("Answer settlement changed after release admission")
    return {
        "schema": "answer.settlement.admission.v1",
        "status": "healthy",
        "identity": identity,
        "executions": executions,
    }


def verify_release_admission(
    environment: str,
    revision: str,
    tools: Path,
    *,
    payments: bool,
    drain: bool,
    baseline: dict | None = None,
) -> dict:
    if payments:
        if not drain:
            raise ValueError(
                "New paid answers require independently enabled settlement"
            )
        return verify_paid_admission(environment, revision, tools, baseline=baseline)
    values, digest = _serving_backend(environment, revision, tools)
    if not drain and values.get("ANSWER_WORK_DRAIN_ENABLED") == "true":
        raise ValueError(
            "Retain settlement for existing obligations; retirement requires separate reconciliation"
        )
    identity = {
        "environment": environment,
        "revision": revision,
        "image_digest": digest,
    }
    if baseline is not None and baseline.get("identity") != identity:
        raise ValueError("Answer settlement serving baseline changed")
    return {
        "schema": "answer.settlement.admission.v1",
        "status": "healthy",
        "identity": identity,
        "mode": "settlement-only" if drain else "disabled",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=TARGETS, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--coordinates", action="store_true")
    mode.add_argument("--job-json", type=Path)
    mode.add_argument("--paid-admission", action="store_true")
    mode.add_argument("--release-admission", action="store_true")
    mode.add_argument("--candidate", action="store_true")
    parser.add_argument("--stage", choices=STAGES)
    parser.add_argument("--revision", default="")
    parser.add_argument(
        "--tools-dir",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "scripts/ci",
    )
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--not-before")
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--payments-enabled", choices=("true", "false"), default="false"
    )
    parser.add_argument("--drain-enabled", choices=("true", "false"), default="false")
    parser.add_argument("--pending-exit-code", type=int, choices=(1, 75), default=1)
    args = parser.parse_args()
    if args.pending_exit_code == 75 and (
        args.environment != "uat" or not args.paid_admission
    ):
        parser.error(
            "pending exit codes are supported only for UAT paid-admission polling"
        )
    try:
        if args.coordinates:
            print(*TARGETS[args.environment])
        elif args.job_json:
            job_configuration(
                json.loads(args.job_json.read_text()), args.environment, args.stage
            )
        else:
            baseline = json.loads(args.baseline.read_text()) if args.baseline else None
            if args.candidate:
                result = verify_candidate(
                    args.environment,
                    args.revision,
                    payments=args.payments_enabled == "true",
                    drain=args.drain_enabled == "true",
                )
            elif args.release_admission:
                result = verify_release_admission(
                    args.environment,
                    args.revision,
                    args.tools_dir,
                    payments=args.payments_enabled == "true",
                    drain=args.drain_enabled == "true",
                    baseline=baseline,
                )
            else:
                result = verify_paid_admission(
                    args.environment,
                    args.revision,
                    args.tools_dir,
                    baseline=baseline,
                    retry_pending=args.pending_exit_code == 75,
                    not_before=datetime.fromisoformat(
                        args.not_before.replace("Z", "+00:00")
                    )
                    if args.not_before
                    else None,
                )
            if args.output is None:
                raise ValueError(
                    "Settlement admission requires a durable release receipt"
                )
            args.output.write_text(json.dumps(result, indent=2) + "\n")
        return 0
    except PendingSettlement as error:
        print(f"Answer settlement admission pending: {error}", file=sys.stderr)
        return args.pending_exit_code
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Answer settlement admission refused: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
