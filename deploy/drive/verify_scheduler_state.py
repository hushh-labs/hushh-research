#!/usr/bin/env python3
"""Capture and verify the exact UAT Drive scheduler target around worker rollout."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

JOB_SERVICE_ACCOUNT = "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
DRAIN_PATH = "/api/internal/drive-work/drain"
PUBLIC_ORIGIN = "https://api.uat.hushh.ai"
RUNTIME_ORIGIN = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
WORKER_HOST = re.compile(r"consent-protocol-drive-worker-[a-z0-9-]+\.a\.run\.app\Z")
JOB_PREFIX = "projects/hushh-pda-uat/locations/us-central1/jobs/"
STAGE_JOBS = {
    "drive-work-drain-uat": ("documents", {"*/2 * * * *", "*/4 * * * *"}),
    "drive-work-suggestions-uat": ("suggestions", {"2-59/4 * * * *"}),
    "drive-work-sharing-uat": ("sharing", {"* * * * *"}),
}
RETRY_POLICY = {
    "maxBackoffDuration": "120s",
    "maxDoublings": 3,
    "maxRetryDuration": "0s",
    "minBackoffDuration": "10s",
    "retryCount": 3,
}
REVIEWED_HEADERS = {"Content-Type": "application/json", "User-Agent": "Google-Cloud-Scheduler"}


def _https_url(value: object, *, drain_target: bool) -> str:
    if not isinstance(value, str) or any(char in value for char in "\x00\r\n\t"):
        raise ValueError("Drive scheduler URL is missing or malformed")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
        or (parsed.path != DRAIN_PATH if drain_target else parsed.path not in ("", "/"))
        or (
            parsed.hostname != "api.uat.hushh.ai"
            and parsed.hostname != "consent-protocol-f2gsa4kfsq-uc.a.run.app"
            and not WORKER_HOST.fullmatch(parsed.hostname)
        )
    ):
        raise ValueError("Drive scheduler URL is outside the reviewed UAT boundary")
    return value


def _scheduler_state(snapshot: Path) -> tuple[str, str]:
    data = json.loads(snapshot.read_text(encoding="utf-8"))
    target = data.get("httpTarget") or {}
    oidc = target.get("oidcToken") or {}
    if oidc.get("serviceAccountEmail") != JOB_SERVICE_ACCOUNT:
        raise ValueError(
            "Drive scheduler OIDC identity is not the reviewed UAT account"
        )
    return (
        _https_url(target.get("uri"), drain_target=True),
        _https_url(oidc.get("audience"), drain_target=False),
    )


def _scheduler_set(snapshot: Path, *, worker_origin: str) -> dict[str, dict[str, object]]:
    """Keep only reviewed, stable job configuration, including absence."""
    jobs = json.loads(snapshot.read_text(encoding="utf-8"))
    if not isinstance(jobs, list):
        raise ValueError("Drive scheduler listing must be an array")
    found: dict[str, dict[str, object]] = {}
    for job in jobs:
        if not isinstance(job, dict):
            raise ValueError("Drive scheduler listing is malformed")
        name = job.get("name")
        if not isinstance(name, str) or not name.startswith(JOB_PREFIX):
            continue
        short_name = name.removeprefix(JOB_PREFIX)
        if short_name not in STAGE_JOBS:
            continue
        if short_name in found:
            raise ValueError("Duplicate Drive scheduler job")
        stage, allowed_schedules = STAGE_JOBS[short_name]
        target = job.get("httpTarget") or {}
        if not isinstance(target, dict):
            raise ValueError("Drive scheduler HTTP target is malformed")
        oidc = target.get("oidcToken") or {}
        headers = target.get("headers") or {}
        if not isinstance(oidc, dict) or not isinstance(headers, dict):
            raise ValueError("Drive scheduler HTTP target is malformed")
        try:
            body = base64.b64decode(target.get("body"), validate=True)
        except (TypeError, ValueError, binascii.Error) as exc:
            raise ValueError("Drive scheduler body is malformed") from exc
        expected = json.dumps({"stage": stage}, separators=(",", ":")).encode()
        if (
            (body != expected and not (stage == "documents" and body == b"{}"))
            or job.get("schedule") not in allowed_schedules
            or job.get("state") != "ENABLED"
            or job.get("timeZone") != "Etc/UTC"
            or target.get("httpMethod") != "POST"
            or headers != REVIEWED_HEADERS
            or oidc.get("serviceAccountEmail") != JOB_SERVICE_ACCOUNT
            or job.get("retryConfig") != RETRY_POLICY
            or job.get("attemptDeadline") != ("120s" if body == b"{}" else "240s")
        ):
            raise ValueError("Drive scheduler config is outside the reviewed UAT boundary")
        uri = _https_url(target.get("uri"), drain_target=True)
        audience = _https_url(oidc.get("audience"), drain_target=False)
        origin = uri.removesuffix(DRAIN_PATH)
        expected_audience = origin if origin in {PUBLIC_ORIGIN, RUNTIME_ORIGIN} else PUBLIC_ORIGIN
        if audience != expected_audience:
            raise ValueError("Drive scheduler audience does not match the reviewed UAT boundary")
        if origin not in {PUBLIC_ORIGIN, RUNTIME_ORIGIN, worker_origin}:
            raise ValueError("Drive scheduler target is not the verified UAT worker origin")
        config = {
            "uri": uri,
            "audience": audience,
            "body": target["body"],
            "schedule": job["schedule"],
            "timeZone": job["timeZone"],
            "state": job["state"],
            "attemptDeadline": job.get("attemptDeadline"),
            "retryConfig": job.get("retryConfig"),
            "headers": headers,
        }
        found[short_name] = config
    if "drive-work-drain-uat" not in found:
        raise ValueError("Existing Drive document scheduler is missing")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("capture", "verify", "capture-set", "verify-set"))
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    parser.add_argument("--canonical", type=Path)
    parser.add_argument("--worker-origin", default="")
    parser.add_argument("--expected-uri")
    parser.add_argument("--expected-audience")
    args = parser.parse_args()

    if args.mode in {"capture-set", "verify-set"}:
        if args.canonical is None:
            raise SystemExit("A canonical scheduler baseline is required")
        worker_origin = args.worker_origin
        if worker_origin:
            _https_url(worker_origin, drain_target=False)
            if not WORKER_HOST.fullmatch(urlsplit(worker_origin).hostname or ""):
                raise SystemExit("Expected Drive worker origin is outside the reviewed service")
        current = _scheduler_set(args.snapshot, worker_origin=worker_origin)
        if args.mode == "capture-set":
            args.canonical.write_text(json.dumps(current, sort_keys=True), encoding="utf-8")
            document = current["drive-work-drain-uat"]
            output = f"uri={document['uri']}\naudience={document['audience']}\n"
        else:
            expected = json.loads(args.canonical.read_text(encoding="utf-8"))
            if current != expected:
                raise SystemExit("Drive scheduler set did not return to pre-worker state")
            output = "restored=true\n"
        with args.github_output.open("a", encoding="utf-8") as stream:
            stream.write(output)
        return 0

    uri, audience = _scheduler_state(args.snapshot)
    if args.mode == "verify":
        expected_uri = _https_url(args.expected_uri, drain_target=True)
        expected_audience = _https_url(args.expected_audience, drain_target=False)
        if (uri, audience) != (expected_uri, expected_audience):
            raise SystemExit(
                "Drive scheduler target or audience did not return to pre-worker state"
            )
        output = "restored=true\n"
    else:
        output = f"uri={uri}\naudience={audience}\n"

    with args.github_output.open("a", encoding="utf-8") as stream:
        stream.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
