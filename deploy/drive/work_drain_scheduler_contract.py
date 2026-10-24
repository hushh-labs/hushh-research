# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Pure fixed-job configuration boundary shared by release capture and repair."""

from __future__ import annotations

import base64
import binascii
import json
import re
from urllib.parse import urlsplit

PROJECT = "hushh-pda-uat"
LOCATION = "us-central1"
PUBLIC_ORIGIN = "https://api.uat.hushh.ai"
RUNTIME_ORIGIN = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
SCHEDULER_ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
DRAIN_PATH = "/api/internal/drive-work/drain"
JOB_STAGES = {
    "drive-work-drain-uat": "documents",
    "drive-work-suggestions-uat": "suggestions",
    "drive-work-sharing-uat": "sharing",
}
JOB_SCHEDULES = {
    "drive-work-drain-uat": {"*/2 * * * *", "*/4 * * * *", "* * * * *"},
    # Accept the pre-rollout schedule so an in-flight release can restore its
    # exact baseline, while new setup writes the one-minute cadence.
    "drive-work-suggestions-uat": {"* * * * *", "2-59/4 * * * *"},
    "drive-work-sharing-uat": {"* * * * *"},
}
# The candidate is the configuration written by the current worker rollout.
# JOB_SCHEDULES also retains legacy cadence values so rollback can validate a
# snapshot captured before the one-minute recovery fix.
CANONICAL_JOB_SCHEDULES = {
    "drive-work-drain-uat": "* * * * *",
    "drive-work-suggestions-uat": "* * * * *",
    "drive-work-sharing-uat": "* * * * *",
}
WORKER_ORIGIN = re.compile(
    r"https://consent-protocol-drive-worker-[a-z0-9-]+\.a\.run\.app\Z"
)
DURATION = re.compile(r"[0-9]{1,3}s\Z")


class SchedulerStateError(RuntimeError):
    """A redacted release failure; never include job body or provider response."""


def _safe_origin(uri: str, audience: str, *, worker_origin: str | None) -> None:
    parsed = urlsplit(uri)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if (
        not isinstance(uri, str)
        or parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != DRAIN_PATH
        or parsed.query
        or parsed.fragment
    ):
        raise SchedulerStateError("Drive scheduler target is outside the UAT boundary")
    if origin in {PUBLIC_ORIGIN, RUNTIME_ORIGIN}:
        if audience != origin:
            raise SchedulerStateError(
                "Drive scheduler audience is outside the UAT boundary"
            )
    elif origin == worker_origin and WORKER_ORIGIN.fullmatch(origin):
        if audience != PUBLIC_ORIGIN:
            raise SchedulerStateError("Drive worker scheduler audience is invalid")
    else:
        raise SchedulerStateError("Drive scheduler target is outside the UAT boundary")


def _body(raw: object, *, name: str) -> str:
    if not isinstance(raw, str):
        raise SchedulerStateError("Drive scheduler body is missing")
    try:
        value = base64.b64decode(raw, validate=True).decode("utf-8")
        parsed = json.loads(value)
    except (ValueError, UnicodeError, binascii.Error):
        raise SchedulerStateError("Drive scheduler body is invalid") from None
    stage = JOB_STAGES[name]
    if value == "{}" and stage == "documents":
        return value
    if parsed != {"stage": stage} or value != json.dumps(parsed, separators=(",", ":")):
        raise SchedulerStateError("Drive scheduler stage does not match its fixed job")
    return value


def _duration(value: object, *, limit: int) -> str:
    if (
        not isinstance(value, str)
        or not DURATION.fullmatch(value)
        or int(value[:-1]) > limit
    ):
        raise SchedulerStateError("Drive scheduler deadline is outside reviewed bounds")
    return value


def _normalize(job: dict, *, name: str, worker_origin: str | None) -> dict:
    expected_name = f"projects/{PROJECT}/locations/{LOCATION}/jobs/{name}"
    target = job.get("httpTarget")
    if job.get("name") != expected_name or not isinstance(target, dict):
        raise SchedulerStateError("Drive scheduler identity is invalid")
    oidc = target.get("oidcToken")
    if (
        not isinstance(oidc, dict)
        or oidc.get("serviceAccountEmail") != SCHEDULER_ACCOUNT
    ):
        raise SchedulerStateError("Drive scheduler OIDC identity is invalid")
    uri, audience = target.get("uri"), oidc.get("audience")
    if not isinstance(uri, str) or not isinstance(audience, str):
        raise SchedulerStateError("Drive scheduler target is invalid")
    _safe_origin(uri, audience, worker_origin=worker_origin)
    headers = target.get("headers")
    if (
        target.get("httpMethod") != "POST"
        or not isinstance(headers, dict)
        or headers
        != {
            "Content-Type": "application/json",
            "User-Agent": "Google-Cloud-Scheduler",
        }
    ):
        raise SchedulerStateError("Drive scheduler HTTP contract is invalid")
    schedule, zone, state = job.get("schedule"), job.get("timeZone"), job.get("state")
    if (
        schedule not in JOB_SCHEDULES[name]
        or zone != "Etc/UTC"
        or state not in {"ENABLED", "PAUSED"}
    ):
        raise SchedulerStateError("Drive scheduler cadence or state is invalid")
    body = _body(target.get("body"), name=name)
    attempt = _duration(job.get("attemptDeadline"), limit=240)
    if attempt != ("120s" if body == "{}" else "240s"):
        raise SchedulerStateError("Drive scheduler attempt deadline is invalid")
    retry = job.get("retryConfig")
    if (
        not isinstance(retry, dict)
        or retry.get("retryCount") != 3
        or retry.get("maxDoublings") != 3
    ):
        raise SchedulerStateError("Drive scheduler retry policy is invalid")
    normalized_retry = {
        "retryCount": 3,
        "minBackoffDuration": _duration(retry.get("minBackoffDuration"), limit=120),
        "maxBackoffDuration": _duration(retry.get("maxBackoffDuration"), limit=120),
        "maxDoublings": 3,
        "maxRetryDuration": _duration(retry.get("maxRetryDuration", "0s"), limit=240),
    }
    if normalized_retry != {
        "retryCount": 3,
        "minBackoffDuration": "10s",
        "maxBackoffDuration": "120s",
        "maxDoublings": 3,
        "maxRetryDuration": "0s",
    }:
        raise SchedulerStateError("Drive scheduler retry policy is invalid")
    return {
        "name": name,
        "uri": uri,
        "audience": audience,
        "serviceAccountEmail": SCHEDULER_ACCOUNT,
        "schedule": schedule,
        "timeZone": zone,
        "state": state,
        "httpMethod": "POST",
        "body": body,
        "headers": headers,
        "attemptDeadline": attempt,
        "retryConfig": normalized_retry,
    }


def _candidate_job(name: str, worker_origin: str) -> dict:
    return {
        "name": name,
        "uri": worker_origin + DRAIN_PATH,
        "audience": PUBLIC_ORIGIN,
        "serviceAccountEmail": SCHEDULER_ACCOUNT,
        "schedule": CANONICAL_JOB_SCHEDULES[name],
        "timeZone": "Etc/UTC",
        "state": "ENABLED",
        "httpMethod": "POST",
        "body": json.dumps({"stage": JOB_STAGES[name]}, separators=(",", ":")),
        "headers": {
            "Content-Type": "application/json",
            "User-Agent": "Google-Cloud-Scheduler",
        },
        "attemptDeadline": "240s",
        "retryConfig": {
            "retryCount": 3,
            "minBackoffDuration": "10s",
            "maxBackoffDuration": "120s",
            "maxDoublings": 3,
            "maxRetryDuration": "0s",
        },
    }


def matches_candidate(job: dict, *, name: str, worker_origin: str) -> bool:
    """Reuse an exact enabled worker configuration; drift still requires repair."""
    if not isinstance(job, dict):
        return False
    try:
        return _normalize(
            job, name=name, worker_origin=worker_origin
        ) == _candidate_job(name, worker_origin)
    except (SchedulerStateError, ValueError, KeyError, TypeError):
        return False
