#!/usr/bin/env python3
"""Bounded, read-only UAT load probe for Cloud Run capacity decisions.

The backend probe authenticates through the UAT review lane, then sends only
GET requests to a fixed list of read-only, database-backed routes. Secrets and
response bodies stay in memory; the report contains timing and status codes.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import requests

BACKEND_ORIGIN = "https://api.uat.hushh.ai"
FRONTEND_ORIGIN = "https://hushh-webapp-f2gsa4kfsq-uc.a.run.app"
FIREBASE_EXCHANGE = (
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
)
BACKEND_PATHS = (
    "/api/one/feed/unread-count",
    "/api/consent/center/summary",
    "/api/consent/center/list?limit=20",
)
FRONTEND_PATHS = ("/login", "/", "/privacy")
ALLOWED_BACKEND_HOSTS = {"api.uat.hushh.ai", "consent-protocol-f2gsa4kfsq-uc.a.run.app"}
ALLOWED_FRONTEND_HOSTS = {"uat.one.hushh.ai", "hushh-webapp-f2gsa4kfsq-uc.a.run.app"}
_thread_state = threading.local()


@dataclass(frozen=True)
class Sample:
    path: str
    status: int
    elapsed_ms: float
    schedule_lag_ms: float
    transport_error: bool = False


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = math.ceil(quantile * len(ordered)) - 1
    return round(ordered[max(0, index)], 2)


def _validate_origin(origin: str, *, service: str) -> str:
    parsed = urlparse(origin)
    allowed = ALLOWED_BACKEND_HOSTS if service == "backend" else ALLOWED_FRONTEND_HOSTS
    if (
        parsed.scheme != "https"
        or parsed.hostname not in allowed
        or parsed.path not in {"", "/"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"Refusing non-UAT {service} origin")
    return origin.rstrip("/")


def _secret(name: str, project: str) -> str:
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={name}",
            f"--project={project}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.strip()
    if not value:
        raise RuntimeError(f"Empty required UAT secret: {name}")
    return value


def _reviewer_firebase_token(origin: str, project: str) -> str:
    if project != "hushh-pda-uat":
        raise ValueError("Reviewer authentication is limited to the UAT secret project")
    reviewer_uid = _secret("REVIEWER_UID", project)
    passphrase = _secret("REVIEWER_VAULT_PASSPHRASE", project)
    api_key = _secret("NEXT_PUBLIC_FIREBASE_API_KEY", project)
    response = requests.post(
        f"{origin}/api/app-config/review-mode/session",
        json={"reviewer_uid": reviewer_uid, "smoke_passphrase": passphrase},
        timeout=20,
    )
    if response.status_code != 200:
        raise RuntimeError(f"UAT reviewer session failed: HTTP {response.status_code}")
    custom_token = response.json().get("token")
    if not isinstance(custom_token, str) or not custom_token:
        raise RuntimeError("UAT reviewer session returned no token")
    exchanged = requests.post(
        FIREBASE_EXCHANGE,
        params={"key": api_key},
        json={"token": custom_token, "returnSecureToken": True},
        timeout=20,
    )
    if exchanged.status_code != 200:
        raise RuntimeError(
            f"Firebase token exchange failed: HTTP {exchanged.status_code}"
        )
    token = exchanged.json().get("idToken")
    if not isinstance(token, str) or not token:
        raise RuntimeError("Firebase token exchange returned no ID token")
    return token


def _session() -> requests.Session:
    session = getattr(_thread_state, "session", None)
    if session is None:
        session = requests.Session()
        _thread_state.session = session
    return session


def _request(
    origin: str, path: str, headers: dict[str, str], scheduled: float
) -> Sample:
    started = time.monotonic()
    try:
        response = _session().get(
            f"{origin}{path}", headers=headers, timeout=10, allow_redirects=False
        )
        _ = response.content
        status = response.status_code
        transport_error = False
    except requests.RequestException:
        status = 0
        transport_error = True
    # Include generator queueing in end-to-end latency. If the probe cannot
    # sustain its requested arrival rate, its reported p95 must fail closed.
    elapsed = (time.monotonic() - scheduled) * 1000
    return Sample(
        path,
        status,
        round(elapsed, 2),
        round(max(0, started - scheduled) * 1000, 2),
        transport_error,
    )


def _summarize(
    samples: list[Sample], service: str, rps: float, duration: int
) -> dict[str, object]:
    by_path: dict[str, list[Sample]] = defaultdict(list)
    for sample in samples:
        by_path[sample.path].append(sample)
    routes = {}
    passed = True
    for path, route_samples in sorted(by_path.items()):
        latencies = [
            sample.elapsed_ms for sample in route_samples if 200 <= sample.status < 400
        ]
        statuses = Counter(str(sample.status) for sample in route_samples)
        p95 = percentile(latencies, 0.95)
        p99 = percentile(latencies, 0.99)
        route_passed = (
            bool(latencies)
            and p95 is not None
            and p95 <= 2000
            and p99 is not None
            and p99 <= 5000
        )
        route_passed = route_passed and all(
            200 <= sample.status < 400 for sample in route_samples
        )
        passed = passed and route_passed
        routes[path] = {
            "count": len(route_samples),
            "status_counts": dict(sorted(statuses.items())),
            "p95_ms": p95,
            "p99_ms": p99,
            "passed": route_passed,
        }
    return {
        "service": service,
        "target_rps": rps,
        "duration_seconds": duration,
        "scheduled_requests": math.floor(rps * duration),
        "completed_requests": len(samples),
        "max_schedule_lag_ms": max(
            (sample.schedule_lag_ms for sample in samples), default=0
        ),
        "routes": routes,
        "http_gate_passed": passed and len(samples) == math.floor(rps * duration),
        "note": "Cloud Run CPU, memory, instances, SQL connections, and pool wait require separate Monitoring checks.",
    }


def _run(
    origin: str,
    paths: tuple[str, ...],
    headers: dict[str, str],
    rps: float,
    duration: int,
    workers: int,
) -> list[Sample]:
    # Preflight prevents a long load run against a broken or unauthorized route.
    for path in paths:
        sample = _request(origin, path, headers, time.monotonic())
        if not 200 <= sample.status < 400:
            raise RuntimeError(
                f"Read-only preflight failed for {path}: HTTP {sample.status}"
            )
    total = math.floor(rps * duration)
    start = time.monotonic()
    futures = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for index in range(total):
            scheduled = start + index / rps
            delay = scheduled - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            futures.append(
                executor.submit(
                    _request, origin, paths[index % len(paths)], headers, scheduled
                )
            )
        return [future.result() for future in as_completed(futures)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", choices=("backend", "frontend"), required=True)
    parser.add_argument(
        "--origin",
        help="UAT HTTPS origin; defaults to the canonical backend or direct frontend Cloud Run URL",
    )
    parser.add_argument("--rps", type=float, required=True)
    parser.add_argument("--duration-seconds", type=int, default=600)
    parser.add_argument("--workers", type=int, default=80)
    parser.add_argument("--secret-project", default="hushh-pda-uat")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if (
        not 0 < args.rps <= 46
        or not 1 <= args.duration_seconds <= 600
        or not 1 <= args.workers <= 100
    ):
        parser.error(
            "Use 0 < rps <= 46, 1 <= duration-seconds <= 600, and 1 <= workers <= 100"
        )
    default = BACKEND_ORIGIN if args.service == "backend" else FRONTEND_ORIGIN
    origin = _validate_origin(args.origin or default, service=args.service)
    paths = BACKEND_PATHS if args.service == "backend" else FRONTEND_PATHS
    if args.dry_run:
        print(
            json.dumps(
                {
                    "service": args.service,
                    "origin": origin,
                    "paths": paths,
                    "rps": args.rps,
                    "duration_seconds": args.duration_seconds,
                }
            )
        )
        return 0
    headers = {"Cache-Control": "no-cache", "User-Agent": "hushh-capacity-probe/1"}
    if args.service == "backend":
        headers["Authorization"] = (
            f"Bearer {_reviewer_firebase_token(origin, args.secret_project)}"
        )
    samples = _run(
        origin, paths, headers, args.rps, args.duration_seconds, args.workers
    )
    report = _summarize(samples, args.service, args.rps, args.duration_seconds)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))
    return 0 if report["http_gate_passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"UAT capacity probe aborted: {exc}", file=sys.stderr)
        sys.exit(2)
