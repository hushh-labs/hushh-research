#!/usr/bin/env python3
"""Wait for verified UAT maintenance to free capacity before taking the deploy lock.

This is an admission observer. It never mutates Cloud Run or authorizes revision
deletion. The deployment job independently repeats the budget gate while holding
the lock shared with maintenance.
"""

from __future__ import annotations

import argparse
import ast
from contextvars import ContextVar
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from process_group import command_group


ROOT = Path(__file__).resolve().parents[2]
PROJECT = "hushh-pda-uat"
REGION = "us-central1"
MAX_WAIT_SECONDS = 300
POLL_SECONDS = 60
QUERY_DEADLINE: ContextVar[float | None] = ContextVar("query_deadline", default=None)


class AdmissionError(RuntimeError):
    pass


class CapacityDeferred(AdmissionError):
    """Safe capacity did not become available; only an operator may retry."""


class TransientJobInventoryDrift(AdmissionError):
    """An unprofiled temporary job appeared while all profiled jobs remain."""


def load_script(name: str, filename: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/ci" / filename)
    if spec is None or spec.loader is None:
        raise AdmissionError(f"Cannot load current {filename} admission tooling")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


serving = load_script("uat_capacity_serving", "resolve-cloud-run-serving-state.py")
scope_tool = load_script("uat_capacity_scope", "resolve-deploy-scope.py")


def remaining_query_seconds() -> float:
    deadline = QUERY_DEADLINE.get()
    remaining = 180.0 if deadline is None else deadline - time.monotonic()
    if remaining <= 1:
        raise AdmissionError("UAT capacity not admitted: query deadline exhausted")
    return min(180.0, remaining - 1)


def command(
    args: list[str], *, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    timeout = remaining_query_seconds()
    try:
        with command_group(
            args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        ) as (process, stop):
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                stop()
                try:
                    process.communicate(timeout=0.5)
                except subprocess.TimeoutExpired:
                    stop(force=True)
                    process.communicate(timeout=0.5)
                raise AdmissionError(
                    "UAT admission query timed out; no deployment authorized"
                ) from exc
            return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    except OSError as exc:
        raise AdmissionError(
            f"UAT admission query could not complete: {type(exc).__name__}"
        ) from exc

def require_success(result: subprocess.CompletedProcess[str], operation: str) -> str:
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise AdmissionError(f"{operation} failed: {detail or 'no diagnostic'}")
    return result.stdout


def verify_request(target_sha: str) -> None:
    if os.environ.get("GITHUB_REF_NAME") != "main":
        raise AdmissionError("UAT admission requires a main-branch dispatch")
    if not re.fullmatch(r"[0-9a-f]{40}", target_sha):
        raise AdmissionError("UAT admission requires an exact 40-character SHA")
    actor = os.environ.get("GITHUB_ACTOR", "")
    require_success(
        command([sys.executable, str(ROOT / "scripts/ci/assert-governed-actor.py"),
                 "--surface", "uat", "--actor", actor]),
        "UAT actor governance",
    )
    env = {**os.environ, "REQUIRED_BRANCH": "main", "REQUIRE_CI_SUCCESS": "1",
           "REQUIRED_CHECK_NAME": "Main Post-Merge Smoke Gate"}
    require_success(
        command(["bash", str(ROOT / "scripts/ci/require-deploy-sha-on-main.sh"), target_sha], env=env),
        "exact main SHA and CI validation",
    )


def gcloud_json(*args: str) -> dict[str, Any]:
    output = require_success(command(["gcloud", *args, f"--project={PROJECT}",
                                      f"--region={REGION}", "--format=json"]),
                             f"Cloud Run {args[0]} query")
    try:
        value = json.loads(output)
    except json.JSONDecodeError as exc:
        raise AdmissionError("Cloud Run inventory query returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise AdmissionError("Cloud Run inventory query returned a non-object")
    return value


def deployed_sha(service: str) -> str:
    state = gcloud_json("run", "services", "describe", service)
    try:
        revision_name = serving.resolve_serving_state(state).revision
    except ValueError as exc:
        raise AdmissionError(f"{service} serving revision is ambiguous: {exc}") from exc
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", revision_name):
        raise AdmissionError(f"{service} serving revision name is invalid")
    revision = gcloud_json("run", "revisions", "describe", revision_name)
    labels = (revision.get("metadata") or {}).get("labels") or {}
    if not isinstance(labels, dict):
        raise AdmissionError(f"{service} revision labels are invalid")
    sha = labels.get("deploy-sha") or ""
    if sha and not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise AdmissionError(f"{service} deploy-sha label is invalid")
    return sha


def resolved_scope(target_sha: str, requested_scope: str) -> Any:
    # A bounded process group also covers the resolver's nested Git queries.
    backend_sha = deployed_sha("consent-protocol")
    frontend_sha = deployed_sha("hushh-webapp")
    output = require_success(
        command(
            [
                sys.executable,
                str(ROOT / "scripts/ci/resolve-deploy-scope.py"),
                "--requested-scope",
                requested_scope,
                "--target-sha",
                target_sha,
                "--backend-base-sha",
                backend_sha,
                "--frontend-base-sha",
                frontend_sha,
                "--json",
            ]
        ),
        "UAT scope resolution",
    )
    try:
        return scope_tool.ScopeDecision(**json.loads(output))
    except (ValueError, TypeError) as exc:
        raise AdmissionError("UAT deploy scope cannot be verified") from exc


def capacity_args(mode: str, decision: Any | None) -> list[str]:
    args = [sys.executable, str(ROOT / "scripts/ci/runtime-capacity-budget.py"),
            "--environment", "uat", "--report-only", "--output", "json"]
    if mode == "one-chat":
        return [*args, "--inherit-candidate-service", "consent-protocol"]
    if decision is None:
        raise AdmissionError("full UAT admission lacks a resolved scope")
    if decision.deploy_backend:
        return [*args, "--candidate-service", "consent-protocol",
                "--candidate-service", "consent-protocol-drive-worker"]
    if decision.deploy_frontend:
        return [*args, "--frontend-only"]
    raise AdmissionError("UAT deploy scope has no candidate lane")


def capacity_report(mode: str, decision: Any | None) -> dict[str, Any]:
    result = command(capacity_args(mode, decision))
    # A temporary extra job can disappear while this bounded observer waits.
    # Only this exact inventory shape is retryable. Missing profiled jobs,
    # malformed output and authentication/query failures remain fatal.
    if result.returncode == 2 and not result.stdout.strip():
        match = re.fullmatch(
            r"capacity budget blocked: job inventory drift: unprofiled=(\[[^\r\n]*\]), missing=\[\]",
            result.stderr.strip(),
        )
        if match:
            try:
                extras = ast.literal_eval(match.group(1))
            except (SyntaxError, ValueError):
                extras = None
            if (
                isinstance(extras, list)
                and extras
                and all(
                    isinstance(name, str)
                    and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name)
                    for name in extras
                )
            ):
                raise TransientJobInventoryDrift(
                    f"temporary unprofiled jobs: {', '.join(extras)}"
                )
    output = require_success(result, "UAT capacity inventory/authentication")
    try:
        report = json.loads(output)
    except json.JSONDecodeError as exc:
        raise AdmissionError("UAT capacity report is not JSON") from exc
    if (
        not isinstance(report, dict)
        or report.get("environment") != "uat"
        or report.get("phase") != "pre-deploy"
        or type(report.get("admitted")) is not bool
        or type(report.get("projected_connections")) is not int
        or type(report.get("admission_limit")) is not int
        or report.get("project") != PROJECT
        or report["projected_connections"] < 0
        or report["admission_limit"] <= 0
        or report["admitted"] != (
            report["projected_connections"] <= report["admission_limit"]
        )
    ):
        raise AdmissionError("UAT capacity report has an invalid admission shape")
    frontend_only = (
        mode == "full"
        and decision is not None
        and decision.deploy_frontend
        and not decision.deploy_backend
    )
    if frontend_only:
        revisions = report.get("verified_frontend_revisions")
        if (
            report.get("admission_mode") != "frontend-only-incremental"
            or type(report.get("incremental_connections")) is not int
            or report["incremental_connections"] != 0
            or report["projected_connections"] != 0
            or not report["admitted"]
            or not isinstance(revisions, list)
            or not revisions
            or any(
                not isinstance(name, str)
                or not name.startswith("hushh-webapp-")
                for name in revisions
            )
        ):
            raise AdmissionError("UAT frontend incremental admission was not verified")
    elif report.get("admission_mode") == "frontend-only-incremental":
        raise AdmissionError("UAT backend capacity report used frontend-only admission")
    return report


def _wait_for_capacity(
    target_sha: str,
    requested_scope: str,
    mode: str,
    *,
    max_wait_seconds: int = MAX_WAIT_SECONDS,
    poll_seconds: int = POLL_SECONDS,
) -> str:
    if max_wait_seconds <= 0 or poll_seconds <= 0:
        raise AdmissionError("UAT admission wait and poll intervals must be positive")
    started = time.monotonic()
    verify_request(target_sha)
    last_projection = "not yet measured"
    warned_about_maintenance = False
    while True:
        if time.monotonic() - started >= max_wait_seconds:
            raise CapacityDeferred(
                f"UAT capacity was not admitted ({last_projection}) within "
                f"{max_wait_seconds}s; retry the same exact SHA and requested scope after verified maintenance"
            )
        decision = (
            resolved_scope(target_sha, requested_scope) if mode == "full" else None
        )
        scope_name = decision.scope if decision is not None else "backend"
        frontend_only = (
            mode == "full"
            and decision is not None
            and decision.deploy_frontend
            and not decision.deploy_backend
        )
        try:
            report = capacity_report(mode, decision)
        except TransientJobInventoryDrift as exc:
            report = None
            last_projection = str(exc)
        if report is not None:
            projected, limit = (
                report["projected_connections"],
                report["admission_limit"],
            )
            last_projection = (
                f"{projected} incremental frontend SQL connections"
                if frontend_only
                else f"{projected}/{limit}"
            )
        if report is not None and report["admitted"]:
            # A long wait may outlive the original CI/governance evidence and
            # the service base used for auto scope. Recheck both before handoff.
            verify_request(target_sha)
            final_decision = (
                resolved_scope(target_sha, requested_scope) if mode == "full" else None
            )
            if final_decision is not None and final_decision.scope != scope_name:
                print(
                    "UAT serving base changed while admitting; rechecking capacity.",
                    flush=True,
                )
                continue
            try:
                final_report = capacity_report(mode, final_decision)
            except TransientJobInventoryDrift as exc:
                final_report = None
                last_projection = str(exc)
            if final_report is not None and final_report["admitted"]:
                if time.monotonic() - started >= max_wait_seconds:
                    raise AdmissionError(
                        "UAT capacity not admitted: validation exceeded deadline"
                    )
                if frontend_only:
                    print(
                        "UAT frontend SQL-free runtime verified; 0 incremental "
                        "connections. Deployment will recheck under the mutation lock.",
                        flush=True,
                    )
                else:
                    print(
                        f"UAT capacity admitted {projected}/{limit} for {scope_name}; "
                        "deployment will recheck under the mutation lock.",
                        flush=True,
                    )
                return scope_name
            if final_report is not None:
                projected, limit = (
                    final_report["projected_connections"],
                    final_report["admission_limit"],
                )
                last_projection = (
                    f"{projected} incremental frontend SQL connections"
                    if frontend_only
                    else f"{projected}/{limit}"
                )
        remaining = max_wait_seconds - (time.monotonic() - started)
        if remaining <= 0:
            raise CapacityDeferred(
                f"UAT capacity was not admitted ({last_projection}) within "
                f"{max_wait_seconds}s; retry the same exact SHA and requested scope after verified maintenance"
            )
        if not warned_about_maintenance:
            print(
                "Capacity Maintenance runs hourly or by governed manual request. "
                "This observer never dispatches maintenance or authorizes deletion; "
                "retry the original SHA and scope after verified cleanup.",
                flush=True,
            )
            warned_about_maintenance = True
        delay = min(poll_seconds, remaining)
        print(
            f"UAT capacity {last_projection} for {scope_name}; waiting {delay:.0f}s "
            "for verified revision maintenance.",
            flush=True,
        )
        time.sleep(delay)


def wait_for_capacity(
    target_sha: str,
    requested_scope: str,
    mode: str,
    *,
    max_wait_seconds: int = MAX_WAIT_SECONDS,
    poll_seconds: int = POLL_SECONDS,
) -> str:
    token = QUERY_DEADLINE.set(time.monotonic() + max_wait_seconds)
    try:
        return _wait_for_capacity(
            target_sha,
            requested_scope,
            mode,
            max_wait_seconds=max_wait_seconds,
            poll_seconds=poll_seconds,
        )
    finally:
        QUERY_DEADLINE.reset(token)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--requested-scope", default="auto")
    parser.add_argument("--mode", choices=("full", "one-chat"), required=True)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        scope = wait_for_capacity(args.target_sha, args.requested_scope, args.mode)
    except CapacityDeferred as exc:
        print(f"DEFERRED_CAPACITY: {exc}", file=sys.stderr)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with Path(summary).open("a", encoding="utf-8") as output:
                output.write(
                    f"Capacity deferred for `{args.target_sha}` ({args.requested_scope}). "
                    "No deployment authorized. Retry the original request after verified cleanup.\n"
                )
        return 3
    except AdmissionError as exc:
        print(f"UAT capacity admission stopped: {exc}", file=sys.stderr)
        return 1
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"scope={scope}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
