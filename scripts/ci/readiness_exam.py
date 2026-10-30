#!/usr/bin/env python3
"""Pre-merge readiness exam: Main's graders, the PR's anchored instruction text as data.

Runs only from Main's .github/workflows/readiness-exam.yml. It never checks out,
installs or imports PR code. It reads the manifest's anchor files at the commit
that would land (the PR's test merge onto Main) through the contents API, writes
only that data into Main's checkout and runs the affected live cases under the
selected Azure account's probe-only identity. Guardrails:
.agents/skills/repo-operations/references/managed-provider-readiness.md
"""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = ROOT / "consent-protocol"
WORKFLOW = ".github/workflows/readiness-exam.yml"
RUNNER = Path(__file__).with_name("readiness_exam_runner.py")
SHA = re.compile(r"[0-9a-f]{40}")
CASE_TIMEOUT_SECONDS = 240
CONCURRENCY = 3
# A measurement repeats one case within one bounded wave; it is never a verdict.
MAX_REPORT_SAMPLES = CONCURRENCY


class ExamRefused(RuntimeError):
    """The event, ref or input is outside this workflow's authority."""


def _module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"{path} is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SELECT = _module(Path(__file__).with_name("readiness_exam_select.py"), "readiness_exam_select")


def github(path: str) -> Any:
    """One read-only GitHub REST call with the job's own read token."""
    request = urllib.request.Request(  # noqa: S310 - fixed https API host
        f"https://api.github.com/{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
        return json.loads(response.read())


def pull_request_target(event: dict, repo: str, main_sha: str, fetch: Callable) -> dict:
    """Grade exactly what would land: the test merge onto Main, or a head containing Main."""
    pr = event["pull_request"]
    head, number = pr["head"]["sha"], int(pr["number"])
    target = {"kind": "pull_request", "number": number, "head": head}
    if pr["head"]["repo"]["full_name"] != repo:
        return {**target, "refused": "fork_pr"}
    live = fetch(f"repos/{repo}/pulls/{number}")
    if live["state"] != "open" or live["head"]["sha"] != head or live["base"]["ref"] != "main":
        return {**target, "refused": "head_moved"}
    merge = live.get("merge_commit_sha") or ""
    parents = [p["sha"] for p in fetch(f"repos/{repo}/commits/{merge}")["parents"]] if merge else []
    if parents == [main_sha, head]:
        return {**target, "graded": merge, "graded_ref": "merge"}
    if fetch(f"repos/{repo}/compare/{main_sha}...{head}")["status"] in {"ahead", "identical"}:
        return {**target, "graded": head, "graded_ref": "head_contains_main"}
    return {**target, "refused": "stale_merge"}


def control_target(inputs: dict, repo: str, main_sha: str, fetch: Callable) -> dict:
    """A maintainer control grades text already on main; it never takes a PR's code."""
    commit = (inputs.get("text_commit") or "").strip()
    if not SHA.fullmatch(commit):
        raise ExamRefused("text_commit must be a full 40-character commit")
    if fetch(f"repos/{repo}/compare/{commit}...{main_sha}")["status"] not in {"ahead", "identical"}:
        raise ExamRefused("text_commit must be reachable from main")
    expect = inputs.get("expect") or "report"
    if expect not in {"report", "must_fail", "must_pass"}:
        raise ExamRefused("expect must be report, must_fail or must_pass")
    cases = [item.strip() for item in (inputs.get("cases") or "").split(",") if item.strip()]
    samples = (inputs.get("reps") or "1").strip()
    if not samples.isdigit() or not 1 <= int(samples) <= MAX_REPORT_SAMPLES:
        raise ExamRefused(f"reps must be 1 to {MAX_REPORT_SAMPLES}")
    if int(samples) > 1 and (expect != "report" or len(cases) != 1):
        raise ExamRefused("Repeated samples measure one case under expect=report only")
    return {
        "kind": "control",
        "graded": commit,
        "graded_ref": "text_commit",
        "cases": cases,
        "expect": expect,
        "expected_reason": (inputs.get("expected_reason") or "").strip(),
        "reps": int(samples),
    }


def blob(repo: str, path: str, sha: str, fetch: Callable) -> str | None:
    """A file's text at one commit, read as data; None when that commit lacks it."""
    try:
        item = fetch(f"repos/{repo}/contents/{path}?ref={sha}")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    if item.get("type") != "file" or item.get("encoding") != "base64":
        raise ExamRefused(f"{path} is not a readable file at {sha}")
    return base64.b64decode(item["content"]).decode("utf-8")


def run_cases(case_ids: list[str], env: dict[str, str]) -> list[dict]:
    """Each case in its own process so every probe keeps its own fixed diagnostics."""

    def one(case_id: str) -> dict:
        started = time.monotonic()
        try:
            result = subprocess.run(  # noqa: S603 - Main's runner, fixed arguments
                [sys.executable, str(RUNNER), "--case", case_id],
                capture_output=True,
                text=True,
                timeout=CASE_TIMEOUT_SECONDS,
                env=env,
                cwd=PROTOCOL,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return _runner_row(case_id, started, "inconclusive", "transport", "runner_timeout")
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        row = next((r["readiness_exam_case"] for r in rows if "readiness_exam_case" in r), None)
        if row is not None:
            return row
        # A runner that dies before its row fails the same way every time.
        last = (result.stderr.strip().splitlines() or [""])[-1]
        error = re.match(r"([A-Za-z_][\w.]*(?:Error|Exception))", last)
        reason = "runner_crashed" + (f":{error.group(1)[-40:]}" if error else "")
        return _runner_row(case_id, started, "failed", "contract", reason)

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        return list(pool.map(one, case_ids))


def _runner_row(case_id: str, started: float, result: str, kind: str, reason: str) -> dict:
    elapsed = round((time.monotonic() - started) * 1000)
    return {
        "case": case_id,
        "result": result,
        "class": kind,
        "reason": reason,
        "elapsed_ms": elapsed,
    }


def verdict(target: dict, selection: list[dict], cases: list[dict], mode: str) -> tuple[dict, int]:
    """One terminal verdict that keeps every reason; advisory mode never blocks a PR."""
    unresolved = [
        {"case": r["case"], "reason": r["reason"]}
        for r in selection
        if r["selected"] and r["reason"] == SELECT.UNRESOLVED
    ]
    failed = unresolved + [
        {"case": c["case"], "reason": c["reason"], "class": c["class"]}
        for c in cases
        if c["result"] == "failed"
    ]
    inconclusive = [
        {"case": c["case"], "reason": c["reason"]} for c in cases if c["result"] == "inconclusive"
    ]
    if failed:
        outcome = "failed"
    elif inconclusive:
        outcome = "inconclusive"
    else:
        outcome = "passed"
    summary: dict[str, Any] = {"verdict": outcome, "failed": failed, "inconclusive": inconclusive}
    if target.get("reps", 1) > 1:
        summary["samples"] = samples(cases)
    if target["kind"] == "control":
        semantic = [c for c in failed if c.get("class") == "semantic"]
        reason = target["expected_reason"]
        if target["expect"] == "must_fail":
            met = bool(semantic) and (not reason or any(c["reason"] == reason for c in semantic))
        else:
            met = outcome == "passed" if target["expect"] == "must_pass" else True
        summary["control_met"] = met
        return summary, 0 if met else 1
    return summary, 0 if mode == "advisory" or outcome == "passed" else 1


def samples(cases: list[dict]) -> dict[str, dict[str, Any]]:
    """k of N per case, with every outcome's reason: a measurement, not a verdict."""
    tally: dict[str, dict[str, Any]] = {}
    for row in cases:
        entry = tally.setdefault(row["case"], {"runs": 0, "passed": 0, "outcomes": {}})
        entry["runs"] += 1
        entry["passed"] += row["result"] == "passed"
        key = "passed" if row["result"] == "passed" else f"{row['result']}:{row['reason']}"
        entry["outcomes"][key] = entry["outcomes"].get(key, 0) + 1
    return tally


def _summary_lines(receipt: dict) -> list[str]:
    lines = [
        f"### Readiness exam: {receipt['verdict']['verdict']} ({receipt['mode']})",
        "",
        "| Case | Selected | Why | Result | Reason | ms |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in receipt["selection"]:
        # One row per run, so repeated samples never hide behind the last one.
        for case in [c for c in receipt["cases"] if c["case"] == row["case"]] or [{}]:
            lines.append(
                f"| {row['case']} | {row['selected']} | {row['reason']} | "
                f"{case.get('result', '-')} | {case.get('reason', '-')} | "
                f"{case.get('elapsed_ms', '-')} |"
            )
    reason = receipt["verdict"].get("reason")
    lines += ["", f"Verdict reason: {reason}." if reason else ""]
    for case, entry in receipt["verdict"].get("samples", {}).items():
        lines.append(
            f"Samples: {case} passed {entry['passed']} of {entry['runs']} {entry['outcomes']}."
        )
    lines.append(
        f"Time to verdict: {receipt['time_to_verdict_ms']} ms in the exam, "
        f"{receipt.get('wall_ms', 'unknown')} ms since the job started."
    )
    return lines


def write_outputs(receipt: dict, path: Path | None) -> None:
    if path is not None:
        path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"readiness_exam_verdict": receipt["verdict"]}, sort_keys=True))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("\n".join(_summary_lines(receipt)) + "\n")
    level = "warning" if receipt["exit_code"] == 0 else "error"
    for item in receipt["verdict"].get("failed", []) + receipt["verdict"].get("inconclusive", []):
        print(f"::{level}::readiness exam {item['case']}: {item['reason']}")
    if receipt["verdict"].get("reason"):
        print(
            f"::{level}::readiness exam {receipt['verdict']['verdict']}: {receipt['verdict']['reason']}"
        )


def _context() -> tuple[dict, str, str]:
    repo = os.environ["GITHUB_REPOSITORY"]
    if os.environ.get("GITHUB_WORKFLOW_REF", "") != f"{repo}/{WORKFLOW}@refs/heads/main":
        raise ExamRefused("The readiness exam runs only from Main's workflow")
    event_name = os.environ["GITHUB_EVENT_NAME"]
    if event_name not in {"pull_request_target", "workflow_dispatch"}:
        raise ExamRefused(f"Unsupported event {event_name}")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    return event, event_name, repo


def _policy(root: Path = ROOT) -> tuple[str, list[str]]:
    governance = json.loads((root / "config/ci-governance.json").read_text())
    mode = governance["readiness_exam"]["mode"]
    if mode not in {"advisory", "required"}:
        raise ExamRefused("readiness_exam.mode must be advisory or required")
    return mode, governance["main"]["review_bypass_users"]


def _target(event: dict, event_name: str, repo: str, fetch: Callable, root: Path) -> dict:
    main_sha = os.environ["GITHUB_SHA"]
    if event_name == "pull_request_target":
        return pull_request_target(event, repo, main_sha, fetch)
    _, maintainers = _policy(root)
    if os.environ.get("GITHUB_TRIGGERING_ACTOR") not in maintainers:
        raise ExamRefused("Readiness exam controls require a maintainer")
    if os.environ.get("GITHUB_RUN_ATTEMPT", "1") != "1":
        raise ExamRefused("A control counts only as a fresh dispatch, never a rerun")
    return control_target(event.get("inputs") or {}, repo, main_sha, fetch)


def _runner_env(account: dict) -> dict[str, str]:
    keep = {"PATH", "HOME", "LANG", "TMPDIR", "RUNNER_TEMP"}
    env = {key: value for key, value in os.environ.items() if key in keep}
    env.update(
        ENVIRONMENT="uat",
        HUSHH_UAT_MANAGED_AI_PROVIDER="azure_openai",
        HUSHH_UAT_MANAGED_TEXT_PROVIDER="azure_openai",
        ACTIONS_ID_TOKEN_REQUEST_URL=os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", ""),
        ACTIONS_ID_TOKEN_REQUEST_TOKEN=os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", ""),
        READINESS_EXAM_ACCOUNT=str(account["name"]),
    )
    return env


def _receipt(event_name: str, mode: str, target: dict) -> dict[str, Any]:
    return {
        "schema": "readiness_exam.premerge.v1",
        "event": event_name,
        "run": {
            "id": os.environ.get("GITHUB_RUN_ID"),
            "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        },
        "workflow_sha": os.environ.get("GITHUB_SHA"),
        "mode": mode,
        "target": {k: v for k, v in target.items() if k != "refused"},
        "selection": [],
        "cases": [],
    }


def examine(
    event: dict,
    event_name: str,
    repo: str,
    fetch: Callable,
    mode: str,
    *,
    root: Path = ROOT,
    load_account: Callable[[], dict] | None = None,
) -> dict:
    started = time.monotonic()
    tools = _module(root / "consent-protocol/scripts/readiness_exam_manifest.py", "exam_manifest")
    if load_account is None:
        contract = _module(root / "consent-protocol/hushh_mcp/managed_ai_config.py", "exam_ai")
        load_account = contract.load_managed_azure_account
    target = _target(event, event_name, repo, fetch, root)
    receipt = _receipt(event_name, mode, target)
    if target.get("refused"):
        receipt["verdict"] = {"verdict": "not_run", "reason": target["refused"]}
        return _finish(receipt, started)
    manifest = tools.load_manifest(root / "consent-protocol/config/readiness-exam-manifest.v1.json")
    live = {c["id"] for c in manifest["cases"] if c["pre_merge"] == "live"}
    requested = target.get("cases") if target["kind"] == "control" else None
    if requested and not set(requested) <= live:
        raise ExamRefused(f"Controls may request only live cases: {sorted(live)}")
    main_file = lambda path: (root / path).read_text(encoding="utf-8")  # noqa: E731
    cache: dict[str, str | None] = {}

    def graded_file(path: str) -> str | None:
        if path not in cache:
            cache[path] = blob(repo, path, target["graded"], fetch)
        return cache[path]

    selection = SELECT.select_cases(manifest, tools.anchor_text, main_file, graded_file, requested)
    receipt["selection"] = SELECT.public_rows(selection)
    chosen = [r["case"] for r in selection if r["selected"] and r["reason"] != SELECT.UNRESOLVED]
    account = load_account()
    receipt["identity"] = {
        "account": account["name"],
        "configured": bool(account["readiness_exam_client_id"]),
    }
    if chosen and not account["readiness_exam_client_id"]:
        receipt["verdict"] = {"verdict": "not_run", "reason": "identity_not_configured"}
        return _finish(receipt, started)
    for path, text in SELECT.overlay_texts(selection, main_file, tools.anchor_text).items():
        (root / path).write_text(text, encoding="utf-8")
    repeated = [case for case in chosen for _ in range(target.get("reps", 1))]
    receipt["cases"] = run_cases(repeated, _runner_env(account)) if chosen else []
    receipt["verdict"], receipt["exit_code"] = verdict(target, selection, receipt["cases"], mode)
    return _finish(receipt, started)


def _finish(receipt: dict, started: float) -> dict:
    receipt["time_to_verdict_ms"] = round((time.monotonic() - started) * 1000)
    job_started = os.environ.get("EXAM_JOB_STARTED_MS", "")
    if job_started.isdigit():
        receipt["wall_ms"] = round(time.time() * 1000) - int(job_started)
    # A superseded head is re-examined by its newer run; a control must always conclude.
    reason = receipt["verdict"].get("reason")
    advisory = receipt["mode"] == "advisory" and receipt["target"].get("kind") != "control"
    receipt.setdefault("exit_code", 0 if advisory or reason == "head_moved" else 1)
    return receipt


def _error_receipt(event_name: str, mode: str, error: BaseException) -> dict:
    """Any exam fault becomes a typed receipt; advisory PR runs still conclude success."""
    transport = isinstance(error, (urllib.error.URLError, TimeoutError, ConnectionError))
    if isinstance(error, urllib.error.HTTPError):
        reason = f"github_api_{error.code}"
    elif transport:
        reason = "github_api_unavailable"
    elif isinstance(error, (ExamRefused, SELECT.SpliceRefused)):
        reason = "refused:" + re.sub(r"[^a-z0-9_]+", "_", str(error).lower())[:48]
    else:
        reason = "exam_error:" + type(error).__name__[:40]
    kind = "pull_request" if event_name == "pull_request_target" else "control"
    receipt = _receipt(event_name, mode, {"kind": kind})
    receipt["verdict"] = {"verdict": "inconclusive" if transport else "not_run", "reason": reason}
    return _finish(receipt, time.monotonic())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--receipt", type=Path, default=None)
    args = parser.parse_args(argv)
    event_name, mode = os.environ.get("GITHUB_EVENT_NAME", ""), "required"
    try:
        mode, _ = _policy()
        event, event_name, repo = _context()
        receipt = examine(event, event_name, repo, github, mode)
    except Exception as error:  # noqa: BLE001 - every fault concludes with a reason
        receipt = _error_receipt(event_name, mode, error)
    write_outputs(receipt, args.receipt)
    return int(receipt["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
