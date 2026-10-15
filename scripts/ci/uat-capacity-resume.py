#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bind a deferred UAT request to its target and safely resume it once.

Only the completed maintenance workflow can wake this controller. It never
deletes a Cloud Run revision or dispatches a new deployment. The ordinary
wait-capacity and deploy jobs still repeat their own admission under the
existing UAT mutation lock.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "hushh-labs/hushh-research"
DEPLOY_WORKFLOW = ".github/workflows/deploy-uat.yml"
MAINTENANCE_WORKFLOW = ".github/workflows/capacity-maintenance.yml"
TARGET_ARTIFACT = "uat-capacity-target-a1"
DEFERRED_ARTIFACT = "uat-capacity-deferred-a1"
CHECKPOINT_ARTIFACT = "uat-retention-state"
SHA = re.compile(r"[0-9a-f]{40}\Z")
SCOPES = frozenset({"auto", "all", "backend", "frontend"})
RESOLVED_SCOPES = SCOPES - {"auto"}


class UnsafeResume(RuntimeError):
    """No privileged retry may be made without complete authority proof."""


class CapacityUnavailable(UnsafeResume):
    """Maintenance completed, but the next candidate still does not fit."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise UnsafeResume(message)


def positive_int(value: Any) -> bool:
    return type(value) is int and value > 0


def valid_sha(value: Any) -> bool:
    return isinstance(value, str) and SHA.fullmatch(value) is not None


def command(*args: str, binary: bool = False) -> str | bytes:
    result = subprocess.run(
        args, capture_output=True, text=not binary, timeout=90, check=False
    )
    if result.returncode:
        raise UnsafeResume(f"authority command failed: {args[0]} {args[1]}")
    return result.stdout


def api(endpoint: str) -> dict[str, Any]:
    output = command("gh", "api", f"repos/{REPOSITORY}/actions/{endpoint}")
    try:
        value = json.loads(output)
    except (TypeError, json.JSONDecodeError) as exc:
        raise UnsafeResume("GitHub authority response was not JSON") from exc
    require(isinstance(value, dict), "GitHub authority response was not an object")
    return value


def path_of(run: dict[str, Any]) -> str:
    path = run.get("path")
    return path.split("@", 1)[0] if isinstance(path, str) else ""


def timestamp(value: Any) -> datetime:
    require(isinstance(value, str), "GitHub timestamp is absent")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise UnsafeResume("GitHub timestamp is invalid") from exc
    require(result.tzinfo is not None, "GitHub timestamp lacks a timezone")
    return result


def event_inputs() -> tuple[str, str]:
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    require(bool(event_path), "dispatch event path is unavailable")
    try:
        event = json.loads(Path(event_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UnsafeResume("dispatch event is unreadable") from exc
    inputs = event.get("inputs") if isinstance(event, dict) else None
    require(isinstance(inputs, dict), "dispatch inputs are unavailable")
    requested_sha, requested_scope = inputs.get("sha", ""), inputs.get("scope")
    require(requested_sha == "" or valid_sha(requested_sha), "dispatch SHA is invalid")
    require(requested_scope in SCOPES, "dispatch scope is invalid")
    return requested_sha, requested_scope


def run_identity() -> dict[str, Any]:
    repository = os.environ.get("GITHUB_REPOSITORY")
    workflow_ref = os.environ.get("GITHUB_WORKFLOW_REF", "")
    require(repository == REPOSITORY, "dispatch repository differs from policy")
    require(
        workflow_ref == f"{REPOSITORY}/{DEPLOY_WORKFLOW}@refs/heads/main",
        "dispatch did not use the main UAT workflow",
    )
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "not a dispatch")
    require(os.environ.get("GITHUB_REF_NAME") == "main", "dispatch was not on main")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(run_id.isdecimal() and int(run_id) > 0, "run ID is invalid")
    require(attempt.isdecimal() and int(attempt) > 0, "run attempt is invalid")
    actor = os.environ.get("GITHUB_ACTOR", "")
    dispatch_sha = os.environ.get("GITHUB_SHA", "")
    require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", actor)), "actor is invalid")
    require(valid_sha(dispatch_sha), "workflow SHA is invalid")
    return {
        "repository": repository,
        "workflow": DEPLOY_WORKFLOW,
        "run_id": int(run_id),
        "run_attempt": int(attempt),
        "actor": actor,
        "dispatch_sha": dispatch_sha,
    }


def write_receipt(
    kind: str, selected_sha: str, requested_scope: str, output: Path,
    *, resolved_scope: str | None = None,
    projected_connections: int | None = None,
    admission_limit: int | None = None,
    next_eligible_drain_time: str | None = None,
) -> None:
    require(kind in {"target", "deferred"}, "receipt type is invalid")
    require(valid_sha(selected_sha), "selected SHA is invalid")
    request_sha, event_scope = event_inputs()
    require(requested_scope == event_scope, "requested scope changed")
    require(not request_sha or selected_sha == request_sha, "selected SHA differs from explicit request")
    if kind == "deferred":
        require(resolved_scope in RESOLVED_SCOPES, "deferred scope was not resolved")
        require(
            (projected_connections is None and admission_limit is None)
            or (
                type(projected_connections) is int and projected_connections >= 0
                and type(admission_limit) is int and admission_limit > 0
            ),
            "deferred projection is invalid",
        )
        if next_eligible_drain_time is not None:
            timestamp(next_eligible_drain_time)
    else:
        require(
            resolved_scope is None and projected_connections is None
            and admission_limit is None and next_eligible_drain_time is None,
            "target receipt cannot claim capacity evidence",
        )
    receipt = {
        "version": 1,
        "kind": kind,
        **run_identity(),
        "request_sha": request_sha,
        "selected_sha": selected_sha,
        "requested_scope": requested_scope,
    }
    if kind == "deferred":
        receipt.update(
            resolved_scope=resolved_scope,
            outcome="DEFERRED_CAPACITY",
            budget_kind="projected_worst_case_not_live_sessions",
            projected_connections=projected_connections,
            admission_limit=admission_limit,
            observed_sql_sessions=None,
            next_eligible_drain_time=next_eligible_drain_time,
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=output.parent, prefix=".uat-capacity-", delete=False
    ) as temporary:
        json.dump(receipt, temporary, sort_keys=True, separators=(",", ":"))
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    temporary_path.replace(output)


def validate_run(run: dict[str, Any], workflow: str) -> None:
    require(positive_int(run.get("id")), "workflow run ID is invalid")
    require(path_of(run) == workflow, "workflow path differs from authority")
    require(run.get("head_branch") == "main", "workflow was not dispatched on main")
    require(valid_sha(run.get("head_sha")), "workflow SHA is invalid")
    require(
        (run.get("repository") or {}).get("full_name") == REPOSITORY
        and (run.get("head_repository") or {}).get("full_name") == REPOSITORY,
        "workflow repository differs from authority",
    )
    require(run.get("event") in {"workflow_dispatch", "schedule", "workflow_run"}, "unsupported event")
    require(positive_int(run.get("run_attempt")), "workflow attempt is invalid")


def jobs_for(run: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = api(f"runs/{run['id']}/jobs?filter=latest&per_page=100")
    jobs = result.get("jobs")
    require(
        isinstance(jobs, list) and len(jobs) <= 100
        and result.get("total_count") == len(jobs),
        "workflow jobs are incomplete",
    )
    by_name: dict[str, dict[str, Any]] = {}
    for job in jobs:
        require(isinstance(job, dict), "workflow job is invalid")
        name = job.get("name")
        require(isinstance(name, str) and name not in by_name, "workflow job names are ambiguous")
        require(job.get("run_attempt") == run["run_attempt"], "workflow jobs span attempts")
        by_name[name] = job
    return by_name


def step_success(job: dict[str, Any], name: str) -> bool:
    steps = job.get("steps")
    return (
        isinstance(steps, list)
        and len([step for step in steps if step.get("name") == name]) == 1
        and next(step for step in steps if step.get("name") == name).get("conclusion") == "success"
    )


def artifact(run_id: int, name: str) -> dict[str, Any] | None:
    result = api(f"runs/{run_id}/artifacts?per_page=100")
    artifacts = result.get("artifacts")
    require(
        isinstance(artifacts, list) and len(artifacts) <= 100
        and result.get("total_count") == len(artifacts),
        "workflow artifacts are incomplete",
    )
    found = [item for item in artifacts if item.get("name") == name]
    require(len(found) <= 1, f"{name} is ambiguous")
    if not found:
        return None
    item = found[0]
    max_size = 10 * 1024 * 1024 if name == CHECKPOINT_ARTIFACT else 64 * 1024
    require(
        (item.get("workflow_run") or {}).get("id") == run_id
        and positive_int(item.get("id"))
        and type(item.get("size_in_bytes")) is int
        and 0 < item["size_in_bytes"] <= max_size
        and bool(re.fullmatch(r"sha256:[0-9a-f]{64}", str(item.get("digest", ""))))
        and item.get("expired") is False,
        f"{name} artifact envelope is invalid",
    )
    return item


def read_receipt(run_id: int, name: str, filename: str) -> dict[str, Any] | None:
    item = artifact(run_id, name)
    if item is None:
        return None
    archive = command(
        "gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{item['id']}/zip", binary=True
    )
    require(isinstance(archive, bytes), "artifact download was not binary")
    require(
        len(archive) == item["size_in_bytes"]
        and hashlib.sha256(archive).hexdigest() == item["digest"].removeprefix("sha256:"),
        "artifact digest changed",
    )
    try:
        with ZipFile(BytesIO(archive)) as bundle:
            entries = bundle.infolist()
            require(
                len(entries) == 1 and entries[0].filename == filename
                and not entries[0].is_dir() and entries[0].file_size <= 8192,
                "receipt archive has an unexpected file",
            )
            content = bundle.read(entries[0])
        value = json.loads(content)
    except (OSError, ValueError, UnicodeError, BadZipFile) as exc:
        raise UnsafeResume("receipt archive could not be decoded") from exc
    require(isinstance(value, dict), "receipt is not an object")
    return value


def receipt_for(run: dict[str, Any], kind: str) -> dict[str, Any] | None:
    name, filename = (
        (TARGET_ARTIFACT, "uat-capacity-target.json") if kind == "target"
        else (DEFERRED_ARTIFACT, "uat-capacity-deferred.json")
    )
    receipt = read_receipt(run["id"], name, filename)
    if receipt is None:
        return None
    expected = {
        "version": 1,
        "kind": kind,
        "repository": REPOSITORY,
        "workflow": DEPLOY_WORKFLOW,
        "run_id": run["id"],
        "run_attempt": 1,
        "actor": (run.get("actor") or {}).get("login"),
        "dispatch_sha": run["head_sha"],
    }
    for field, value in expected.items():
        require(receipt.get(field) == value, f"{kind} receipt {field} differs from workflow")
    require(valid_sha(receipt.get("selected_sha")), "receipt selected SHA is invalid")
    require(receipt.get("request_sha") == "" or valid_sha(receipt.get("request_sha")), "request SHA is invalid")
    require(
        not receipt["request_sha"] or receipt["request_sha"] == receipt["selected_sha"],
        "explicit request differs from selected SHA",
    )
    require(receipt.get("requested_scope") in SCOPES, "receipt requested scope is invalid")
    if kind == "deferred":
        require(receipt.get("outcome") == "DEFERRED_CAPACITY", "not a capacity deferral")
        require(receipt.get("resolved_scope") in RESOLVED_SCOPES, "deferral scope is invalid")
        require(
            receipt.get("budget_kind") == "projected_worst_case_not_live_sessions"
            and receipt.get("observed_sql_sessions") is None,
            "deferral mislabels the budget as live sessions",
        )
        projected, limit = receipt.get("projected_connections"), receipt.get("admission_limit")
        require(
            (projected is None and limit is None)
            or (type(projected) is int and projected >= 0 and type(limit) is int and limit > 0),
            "deferral projection is invalid",
        )
        if receipt.get("next_eligible_drain_time") is not None:
            timestamp(receipt["next_eligible_drain_time"])
    return receipt


def matching_receipts(run: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    target = receipt_for(run, "target")
    deferred = receipt_for(run, "deferred")
    if target is None or deferred is None:
        return None
    for field in ("request_sha", "selected_sha", "requested_scope", "actor", "dispatch_sha"):
        require(target[field] == deferred[field], f"target and deferral disagree on {field}")
    return target, deferred


def recent_runs(workflow: str, *, newest_since: datetime) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    for page in range(1, 6):
        result = api(
            f"workflows/{workflow.rsplit('/', 1)[-1]}/runs"
            f"?event=workflow_dispatch&branch=main&per_page=100&page={page}"
        )
        batch = result.get("workflow_runs")
        require(isinstance(batch, list) and len(batch) <= 100, "workflow run history is invalid")
        for run in batch:
            require(isinstance(run, dict), "workflow run history contains a non-object")
            validate_run(run, workflow)
            if timestamp(run.get("created_at")) >= newest_since:
                collected.append(run)
        if len(batch) < 100 or all(timestamp(run["created_at"]) < newest_since for run in batch):
            return sorted(collected, key=lambda run: (timestamp(run["created_at"]), run["id"]), reverse=True)
    raise UnsafeResume("recent UAT workflow history exceeds bounded inspection")


def ancestor(old: str, new: str) -> bool:
    require(valid_sha(old) and valid_sha(new), "supersession SHA is invalid")
    result = subprocess.run(
        ("git", "merge-base", "--is-ancestor", old, new),
        cwd=ROOT, capture_output=True, text=True, timeout=20, check=False,
    )
    require(result.returncode in {0, 1}, "Git ancestry could not be established")
    return result.returncode == 0


def no_superseding_run(run: dict[str, Any], selected_sha: str) -> None:
    since = timestamp(run["created_at"])
    newer = [
        other for workflow in (DEPLOY_WORKFLOW, ".github/workflows/deploy-uat-one-chat.yml")
        for other in recent_runs(workflow, newest_since=since)
        if other["id"] != run["id"]
        and (timestamp(other["created_at"]), other["id"]) > (since, run["id"])
    ]
    for other in newer:
        # One-chat does not yet publish a selected-target receipt. It may be
        # deploying a newer backend, so any newer one-chat request wins.
        if path_of(other) != DEPLOY_WORKFLOW:
            raise UnsafeResume("newer One chat UAT request supersedes capacity retry")
        target = receipt_for(other, "target")
        require(target is not None, "newer UAT selected target is unknown")
        other_sha = target["selected_sha"]
        if ancestor(selected_sha, other_sha):
            raise UnsafeResume("newer UAT selected target supersedes capacity retry")
        require(ancestor(other_sha, selected_sha), "UAT targets lack a main ancestry order")


def verify_deferred_failure(run: dict[str, Any]) -> dict[str, Any]:
    validate_run(run, DEPLOY_WORKFLOW)
    require(run["event"] == "workflow_dispatch", "UAT request was not manual")
    require(
        run["run_attempt"] == 1 and run.get("status") == "completed"
        and run.get("conclusion") == "failure",
        "UAT request is not a first-attempt failure",
    )
    jobs = jobs_for(run)
    require(
        set(jobs) == {
            "Select UAT target", "Wait for UAT capacity outside the mutation lock", "Deploy UAT Scope"
        },
        "UAT failure jobs differ from the capacity-only graph",
    )
    selected, waiting, deploying = (
        jobs["Select UAT target"],
        jobs["Wait for UAT capacity outside the mutation lock"],
        jobs["Deploy UAT Scope"],
    )
    require(
        selected.get("conclusion") == "success"
        and waiting.get("conclusion") == "failure"
        and deploying.get("conclusion") == "skipped"
        and step_success(selected, "Save selected UAT target")
        and step_success(waiting, "Save exact capacity deferral evidence"),
        "UAT run did not fail solely in the capacity wait",
    )
    steps = waiting.get("steps")
    require(isinstance(steps, list), "capacity wait steps are unavailable")
    failures = [step.get("name") for step in steps if step.get("conclusion") == "failure"]
    require(failures == ["Wait for scope-aware UAT capacity"], "capacity wait had another failure")
    pair = matching_receipts(run)
    require(pair is not None, "capacity deferral receipts are missing")
    return pair[1]


def verify_maintenance(run_id: int) -> bool:
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    require(bool(event_path), "maintenance event path is missing")
    try:
        event = json.loads(Path(event_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UnsafeResume("maintenance event is unreadable") from exc
    payload = event.get("workflow_run") if isinstance(event, dict) else None
    require(isinstance(payload, dict) and payload.get("id") == run_id, "maintenance event ID changed")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "maintenance repository changed")
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_run", "maintenance event type changed")
    source = api(f"runs/{run_id}")
    validate_run(source, MAINTENANCE_WORKFLOW)
    require(
        source.get("status") == "completed" and source.get("conclusion") == "success"
        and source.get("run_attempt") == payload.get("run_attempt")
        and source.get("head_sha") == payload.get("head_sha")
        and path_of(payload) == MAINTENANCE_WORKFLOW,
        "maintenance completion is not authenticated",
    )
    jobs = jobs_for(source)
    selected = jobs.get("Verify due cleanup without cloud credentials")
    cleanup = jobs.get("UAT bounded revision cleanup")
    require(
        selected is not None and selected.get("conclusion") == "success",
        "maintenance source validation did not succeed",
    )
    if cleanup is not None and cleanup.get("conclusion") == "skipped":
        return False
    require(
        cleanup is not None and cleanup.get("conclusion") == "success"
        and step_success(cleanup, "Recheck due source under the deployment lock")
        and step_success(cleanup, "Prepare or finish eligible uat revision cleanup")
        and step_success(cleanup, "Save uat cleanup checkpoint")
        and step_success(cleanup, "Report cleanup independently of release health"),
        "maintenance did not complete an authenticated UAT cleanup",
    )
    require(artifact(run_id, CHECKPOINT_ARTIFACT) is not None, "maintenance checkpoint is missing")
    return True


def check_live_capacity(receipt: dict[str, Any]) -> None:
    target, scope = receipt["selected_sha"], receipt["requested_scope"]
    actor = receipt["actor"]
    command(sys.executable, str(ROOT / "scripts/ci/assert-governed-actor.py"),
            "--surface", "uat", "--actor", actor)
    env = {**os.environ, "REQUIRED_BRANCH": "main", "REQUIRE_CI_SUCCESS": "1",
           "REQUIRED_CHECK_NAME": "Main Post-Merge Smoke Gate"}
    validated = subprocess.run(
        ("bash", str(ROOT / "scripts/ci/require-deploy-sha-on-main.sh"), target),
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=90, check=False,
    )
    require(validated.returncode == 0, "selected target is no longer green on main")
    spec = importlib.util.spec_from_file_location(
        "uat_capacity_wait_for_resume", ROOT / "scripts/ci/wait-uat-capacity.py"
    )
    require(spec is not None and spec.loader is not None, "capacity admission tool is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for _ in range(2):
        decision = module.resolved_scope(target, scope)
        require(decision.scope == receipt["resolved_scope"], "UAT scope changed after deferral")
        report = module.capacity_report("full", decision)
        if report["admitted"] is not True:
            raise CapacityUnavailable("UAT capacity is still deferred")


def verify_original_on_rerun(selected_sha: str, requested_scope: str, check_supersession: bool) -> None:
    identity = run_identity()
    require(identity["run_attempt"] > 1, "rerun guard used for an initial attempt")
    run = api(f"runs/{identity['run_id']}")
    validate_run(run, DEPLOY_WORKFLOW)
    require(run["run_attempt"] == identity["run_attempt"], "rerun attempt changed")
    pair = matching_receipts({**run, "run_attempt": 1})
    require(pair is not None, "original capacity deferral proof is absent")
    receipt = pair[1]
    require(
        receipt["selected_sha"] == selected_sha
        and receipt["requested_scope"] == requested_scope
        and receipt["actor"] == identity["actor"]
        and receipt["dispatch_sha"] == identity["dispatch_sha"],
        "rerun changed the original target, scope, actor, or workflow SHA",
    )
    if check_supersession:
        no_superseding_run(run, selected_sha)


def resume_after_maintenance(run_id: int, *, apply: bool) -> str:
    if not verify_maintenance(run_id):
        return "NO_OP: maintenance found no due UAT cleanup"
    since = datetime.now(timezone.utc) - timedelta(days=7)
    runs = recent_runs(DEPLOY_WORKFLOW, newest_since=since)
    for original in runs:
        if original.get("run_attempt") != 1 or original.get("conclusion") != "failure":
            continue
        if artifact(original["id"], DEFERRED_ARTIFACT) is None:
            continue
        receipt = verify_deferred_failure(original)
        no_superseding_run(original, receipt["selected_sha"])
        try:
            check_live_capacity(receipt)
        except CapacityUnavailable:
            return f"NO_OP: run {original['id']} is still over the UAT connection budget"
        # Race check at the write boundary. A newly queued request, a manual
        # rerun, or a replaced maintenance attempt invalidates the decision.
        current = api(f"runs/{original['id']}")
        verify_deferred_failure(current)
        no_superseding_run(current, receipt["selected_sha"])
        if not apply:
            return f"READY: run {original['id']} job is eligible for one exact-target rerun"
        wait_job = jobs_for(current)["Wait for UAT capacity outside the mutation lock"]
        require(positive_int(wait_job.get("id")), "capacity wait job ID is invalid")
        command("gh", "api", "-X", "POST",
                f"repos/{REPOSITORY}/actions/jobs/{wait_job['id']}/rerun")
        return f"RESUMED: run {original['id']} wait-capacity job {wait_job['id']}"
    return "NO_OP: no first-attempt capacity deferral with a verified receipt"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("emit-target", "emit-deferred"):
        item = sub.add_parser(name)
        item.add_argument("--selected-sha", required=True)
        item.add_argument("--requested-scope", required=True)
        item.add_argument("--output", type=Path, required=True)
        if name == "emit-deferred":
            item.add_argument("--resolved-scope", required=True)
            item.add_argument("--projected-connections", type=int)
            item.add_argument("--admission-limit", type=int)
            item.add_argument("--next-eligible-drain-time")
    verify = sub.add_parser("verify-rerun")
    verify.add_argument("--selected-sha", required=True)
    verify.add_argument("--requested-scope", required=True)
    verify.add_argument("--check-supersession", action="store_true")
    resume = sub.add_parser("resume-after-maintenance")
    resume.add_argument("--maintenance-run-id", type=int, required=True)
    resume.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "emit-target":
            write_receipt("target", args.selected_sha, args.requested_scope, args.output)
        elif args.command == "emit-deferred":
            write_receipt(
                "deferred", args.selected_sha, args.requested_scope, args.output,
                resolved_scope=args.resolved_scope,
                projected_connections=args.projected_connections,
                admission_limit=args.admission_limit,
                next_eligible_drain_time=args.next_eligible_drain_time,
            )
        elif args.command == "verify-rerun":
            verify_original_on_rerun(
                args.selected_sha, args.requested_scope, args.check_supersession
            )
        else:
            require(args.maintenance_run_id > 0, "maintenance ID is invalid")
            print(resume_after_maintenance(args.maintenance_run_id, apply=args.apply))
    except (UnsafeResume, subprocess.TimeoutExpired) as exc:
        print(f"UAT capacity resume refused: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
