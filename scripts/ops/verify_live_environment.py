#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh Research

"""End-to-end reachability and posture check for a deployed environment.

Answers "is it actually alive, and is it configured the way we say it is" without
a human clicking through surfaces. Every probe is read-only and unauthenticated:
it asserts the *shape* of each response, never a successful data read.

    python3 scripts/ops/verify_live_environment.py --env production
    python3 scripts/ops/verify_live_environment.py --env uat --json

Exit code is 0 only when every required probe matches its expected posture, so
this is safe to gate a release on.

The remote MCP surface is deliberately posture-checked rather than
availability-checked: `docs/reference/operations/env-and-secrets.md` records
"keep false in production" for `DEVELOPER_API_ENABLED`, and `remote_mcp_enabled()`
requires it. A production run therefore expects MCP to answer
`404 REMOTE_MCP_DISABLED`, and a run that finds it *open* fails loudly. Flip
`--expect-mcp enabled` only alongside a deliberate, documented policy change.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

ENVIRONMENTS: dict[str, dict[str, str]] = {
    "production": {
        "api": "https://api.hushh.ai",
        "app": "https://one.hushh.ai",
    },
    "uat": {
        "api": "https://api.uat.hushh.ai",
        "app": "https://uat.one.hushh.ai",
    },
}

# Posture the repo documents for each environment's developer/MCP surface.
DEFAULT_MCP_POSTURE = {"production": "disabled", "uat": "enabled"}

TIMEOUT_SECONDS = 25


def _request(url: str, *, method: str = "GET", body: str | None = None,
             headers: dict[str, str] | None = None) -> tuple[int, str]:
    """Probe over curl, which uses the system trust store.

    Python's urllib depends on the interpreter's CA bundle, and a python.org
    macOS install ships without one -- every probe then fails identically to a
    real outage. curl is present on every developer machine and CI image this
    repo targets, so it is the transport that tells the truth.
    """
    args = ["curl", "-sS", "--max-time", str(TIMEOUT_SECONDS), "-o", "-", "-w", "\n%{http_code}", "-X", method]
    for key, value in (headers or {}).items():
        args += ["-H", f"{key}: {value}"]
    if body is not None:
        args += ["--data-binary", body]
    args.append(url)
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=TIMEOUT_SECONDS + 10)
    except subprocess.TimeoutExpired:
        return 0, "transport: timeout"
    if proc.returncode != 0:
        return 0, f"transport: curl exit {proc.returncode}: {proc.stderr.strip()[:180]}"
    out = proc.stdout
    payload, _, status_text = out.rpartition("\n")
    try:
        return int(status_text.strip()), payload[:2048]
    except ValueError:
        return 0, f"transport: unparseable status {status_text!r}"


def _error_code(body: str) -> str:
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return ""
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, dict):
            return str(detail.get("error_code") or "")
        return str(payload.get("error_code") or "")
    return ""


def probe_mcp(api: str, expected: str) -> dict:
    """Drive a real MCP initialize handshake and classify the response."""
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "verify_live_environment", "version": "1"},
            },
        }
    ).encode()
    status, text = _request(
        f"{api}/mcp/",
        method="POST",
        body=body,
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
    )
    code = _error_code(text)

    if status == 0:
        return {
            "name": "remote-mcp",
            "url": f"{api}/mcp/",
            "status": 0,
            "error_code": "",
            "expected": expected,
            "observed": "unreachable",
            "ok": False,
            "note": text,
        }

    if status == 404 and code == "REMOTE_MCP_DISABLED":
        observed = "disabled"
        note = "remote MCP is off for this environment"
    elif status == 401 and code == "DEVELOPER_TOKEN_REQUIRED":
        observed = "enabled"
        note = "remote MCP is mounted and correctly demanding a developer token"
    elif status == 200:
        observed = "open"
        note = "remote MCP answered an unauthenticated initialize -- auth gate missing"
    else:
        observed = "unknown"
        note = f"unexpected status {status} code {code or '(none)'}"

    ok = observed == expected and observed != "open"
    return {
        "name": "remote-mcp",
        "url": f"{api}/mcp/",
        "status": status,
        "error_code": code,
        "expected": expected,
        "observed": observed,
        "ok": ok,
        "note": note,
    }


def run(env: str, expect_mcp: str) -> dict:
    hosts = ENVIRONMENTS[env]
    api, app = hosts["api"], hosts["app"]
    results: list[dict] = []

    for name, url in (("api-health", f"{api}/health"), ("api-root", f"{api}/"), ("app-root", f"{app}/")):
        status, _ = _request(url)
        results.append(
            {"name": name, "url": url, "status": status, "expected": 200, "ok": status == 200}
        )

    # A user-scoped developer read must never succeed without a principal.
    # Deliberately NOT /api/v1/list-scopes: that endpoint has no principal
    # dependency by design (a static scope catalog a developer must be able to
    # discover before requesting consent), so a 200 there is correct and
    # asserting otherwise would cry wolf on every UAT run.
    probe_path = "/api/v1/user-scopes/probe-unauthenticated"
    status, text = _request(f"{api}{probe_path}")
    code = _error_code(text)
    results.append(
        {
            "name": "developer-api-unauthenticated",
            "url": f"{api}{probe_path}",
            "status": status,
            "error_code": code,
            "expected": "not 2xx",
            # `status == 0` is a transport failure, not a closed surface.
            "ok": status != 0 and not (200 <= status < 300),
            "note": "a user-scoped developer read must never succeed without auth",
        }
    )

    results.append(probe_mcp(api, expect_mcp))

    failed = [r for r in results if not r["ok"]]
    return {
        "environment": env,
        "api": api,
        "app": app,
        "expected_mcp_posture": expect_mcp,
        "status": "ok" if not failed else "error",
        "probes": results,
        "failed": [r["name"] for r in failed],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=sorted(ENVIRONMENTS), default="production")
    parser.add_argument(
        "--expect-mcp",
        choices=["enabled", "disabled"],
        default=None,
        help="Override the documented MCP posture for this environment.",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    expected = args.expect_mcp or DEFAULT_MCP_POSTURE[args.env]
    report = run(args.env, expected)

    if args.json:
        print(json.dumps(report, indent=2))
        return 0 if report["status"] == "ok" else 1

    print(f"Live environment check: {report['environment']}")
    print(f"  api {report['api']}")
    print(f"  app {report['app']}")
    print("")
    for probe in report["probes"]:
        mark = "ok  " if probe["ok"] else "FAIL"
        detail = probe.get("note") or f"expected {probe['expected']}"
        print(f"  [{mark}] {probe['name']:<32} {probe['status']:>3}  {detail}")
    print("")
    if report["status"] == "ok":
        print("All probes match the documented posture.")
        return 0
    print(f"Failed probes: {', '.join(report['failed'])}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
