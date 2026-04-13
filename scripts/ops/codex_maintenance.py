#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS_ROOT = REPO_ROOT / ".codex/workflows"
ISSUE_TITLE = "Codex Maintenance Radar"
CADENCES = {"daily", "weekly", "monthly", "manual"}
SEVERITY_ORDER = {
    "info": 0,
    "note": 0,
    "warning": 1,
    "low": 1,
    "medium": 2,
    "moderate": 2,
    "high": 3,
    "critical": 4,
    "error": 4,
}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_repo() -> str:
    if os.environ.get("GITHUB_REPOSITORY"):
        return os.environ["GITHUB_REPOSITORY"]
    result = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    remote = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    value = remote.stdout.strip()
    if value.startswith("https://github.com/"):
        return value.removeprefix("https://github.com/").removesuffix(".git")
    if value.startswith("git@github.com:"):
        return value.removeprefix("git@github.com:").removesuffix(".git")
    raise RuntimeError("could not resolve GitHub repository")


def load_workflows() -> list[dict[str, Any]]:
    workflows: list[dict[str, Any]] = []
    for workflow_path in sorted(WORKFLOWS_ROOT.glob("*/workflow.json")):
        workflow = load_json(workflow_path)
        workflow["path"] = str(workflow_path.relative_to(REPO_ROOT))
        workflows.append(workflow)
    return workflows


def run_shell(command: str, *, artifacts_dir: Path | None = None, prefix: str = "command") -> OrderedDict[str, Any]:
    start = time.time()
    result = subprocess.run(
        ["/bin/bash", "-lc", command],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    duration = round(time.time() - start, 2)
    stdout = result.stdout
    stderr = result.stderr
    artifact_payload: OrderedDict[str, str] = OrderedDict()
    if artifacts_dir is not None:
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        stdout_path = artifacts_dir / f"{prefix}.stdout.log"
        stderr_path = artifacts_dir / f"{prefix}.stderr.log"
        stdout_path.write_text(stdout, encoding="utf-8")
        stderr_path.write_text(stderr, encoding="utf-8")
        artifact_payload["stdout"] = str(stdout_path.relative_to(REPO_ROOT))
        artifact_payload["stderr"] = str(stderr_path.relative_to(REPO_ROOT))
    return OrderedDict(
        command=command,
        exit_code=result.returncode,
        status="passed" if result.returncode == 0 else "failed",
        duration_seconds=duration,
        stdout_tail=stdout[-4000:],
        stderr_tail=stderr[-4000:],
        artifacts=artifact_payload,
    )


def evaluate_prerequisite(token: str) -> tuple[bool, str]:
    if token == "gh-auth":
        result = subprocess.run(
            ["gh", "auth", "status"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        return result.returncode == 0, "gh auth status failed" if result.returncode != 0 else "ok"
    if token.startswith("command:"):
        name = token.split(":", 1)[1]
        return shutil.which(name) is not None, f"missing command `{name}`"
    if token.startswith("env:"):
        name = token.split(":", 1)[1]
        return bool(os.environ.get(name)), f"missing env `{name}`"
    if token.startswith("path:"):
        candidate = token.split(":", 1)[1]
        return (REPO_ROOT / candidate).exists(), f"missing path `{candidate}`"
    return False, f"unknown prerequisite token `{token}`"


def evaluate_prerequisites(tokens: list[str]) -> tuple[list[str], list[str]]:
    met: list[str] = []
    unmet: list[str] = []
    for token in tokens:
        ok, message = evaluate_prerequisite(token)
        if ok:
            met.append(token)
        else:
            unmet.append(message)
    return met, unmet


def gh_api_json(repo: str, endpoint: str) -> list[dict[str, Any]]:
    result = subprocess.run(
        ["gh", "api", "-H", "Accept: application/vnd.github+json", endpoint],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
        env=os.environ.copy(),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"gh api failed for {endpoint}")
    return json.loads(result.stdout)


def normalize_severity(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    if value in {"warning", "error", "note"}:
        return {"warning": "medium", "error": "high", "note": "low"}[value]
    if value in SEVERITY_ORDER:
        return value
    return "unknown"


def alert_severity(alert: dict[str, Any], kind: str) -> str:
    if kind == "dependabot":
        advisory = alert.get("security_advisory") or {}
        return normalize_severity(advisory.get("severity"))
    rule = alert.get("rule") or {}
    instance = alert.get("most_recent_instance") or {}
    return normalize_severity(
        rule.get("security_severity_level")
        or instance.get("security_severity_level")
        or rule.get("severity")
        or instance.get("severity")
    )


def summarize_alerts(kind: str, alerts: list[dict[str, Any]]) -> OrderedDict[str, Any]:
    counter: Counter[str] = Counter()
    top_items: list[OrderedDict[str, Any]] = []
    for alert in alerts:
        severity = alert_severity(alert, kind)
        counter[severity] += 1
        if len(top_items) >= 8:
            continue
        if kind == "dependabot":
            dependency = (((alert.get("dependency") or {}).get("package") or {}).get("name")) or "<unknown>"
            summary = ((alert.get("security_advisory") or {}).get("summary")) or ""
            top_items.append(
                OrderedDict(
                    number=alert.get("number"),
                    dependency=dependency,
                    severity=severity,
                    summary=summary.strip(),
                )
            )
        else:
            tool = ((alert.get("tool") or {}).get("name")) or "codeql"
            rule = ((alert.get("rule") or {}).get("id")) or "<unknown>"
            location = ((alert.get("most_recent_instance") or {}).get("location") or {}).get("path") or "<unknown>"
            top_items.append(
                OrderedDict(
                    number=alert.get("number"),
                    tool=tool,
                    rule=rule,
                    severity=severity,
                    location=location,
                )
            )
    return OrderedDict(
        total=len(alerts),
        counts=OrderedDict((key, counter.get(key, 0)) for key in ("critical", "high", "medium", "low", "unknown")),
        top_items=top_items,
    )


def exceeds_threshold(summary: dict[str, Any], threshold: str) -> bool:
    if threshold == "none":
        return False
    rank = SEVERITY_ORDER.get(threshold, 99)
    for severity, count in (summary.get("counts") or {}).items():
        if count and SEVERITY_ORDER.get(severity, -1) >= rank:
            return True
    return False


def fetch_alert_snapshot(kind: str, repo: str, *, threshold: str = "none", artifacts_dir: Path | None = None) -> OrderedDict[str, Any]:
    if kind == "dependabot":
        endpoint = f"/repos/{repo}/dependabot/alerts?state=open&per_page=100"
    elif kind == "code-scanning":
        endpoint = f"/repos/{repo}/code-scanning/alerts?state=open&per_page=100"
    else:
        raise ValueError(f"unsupported alert kind: {kind}")
    alerts = gh_api_json(repo, endpoint)
    summary = summarize_alerts(kind, alerts)
    payload = OrderedDict(
        kind=kind,
        threshold=threshold,
        summary=summary,
        status="failed" if exceeds_threshold(summary, threshold) else "passed",
    )
    if artifacts_dir is not None:
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        raw_path = artifacts_dir / f"{kind}-alerts.raw.json"
        summary_path = artifacts_dir / f"{kind}-alerts.summary.json"
        raw_path.write_text(json.dumps(alerts, indent=2), encoding="utf-8")
        summary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        payload["artifacts"] = OrderedDict(
            raw=str(raw_path.relative_to(REPO_ROOT)),
            summary=str(summary_path.relative_to(REPO_ROOT)),
        )
    return payload


def run_workflow_maintenance(workflow: dict[str, Any], artifacts_dir: Path | None = None) -> OrderedDict[str, Any]:
    _, unmet = evaluate_prerequisites(workflow.get("maintenance_prerequisites", []))
    commands = workflow.get("maintenance_runner", [])
    result = OrderedDict(
        id=workflow["id"],
        maintenance_owner=workflow.get("maintenance_owner"),
        cadence=workflow.get("maintenance_cadence"),
        scheduled_safe=workflow.get("scheduled_safe"),
        blockers=workflow.get("maintenance_blockers", []),
        prerequisites=workflow.get("maintenance_prerequisites", []),
    )
    if unmet:
        result["status"] = "skipped"
        result["skip_reason"] = ", ".join(unmet)
        result["commands"] = []
        return result

    command_results: list[OrderedDict[str, Any]] = []
    workflow_artifacts = None
    if artifacts_dir is not None:
        workflow_artifacts = artifacts_dir / workflow["id"]
    status = "passed"
    for index, command in enumerate(commands, start=1):
        command_result = run_shell(
            command,
            artifacts_dir=workflow_artifacts,
            prefix=f"{index:02d}",
        )
        command_results.append(command_result)
        if command_result["status"] != "passed":
            status = "failed"
            break
    result["status"] = status
    result["commands"] = command_results
    return result


def run_codex_audit(artifacts_dir: Path | None = None) -> OrderedDict[str, Any]:
    result = run_shell("./bin/hushh codex audit --json", artifacts_dir=artifacts_dir, prefix="codex-audit")
    payload: OrderedDict[str, Any] = OrderedDict(status=result["status"], command=result)
    if result["status"] == "passed":
        rerun = subprocess.run(
            ["/bin/bash", "-lc", "./bin/hushh codex audit --json"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        audit = json.loads(rerun.stdout)
        payload["audit"] = audit.get("audit", {})
    return payload


def remediation_items(report: dict[str, Any]) -> list[str]:
    items: list[str] = []
    security = report.get("security", {})
    for kind in ("dependabot", "code_scanning"):
        summary = ((security.get(kind) or {}).get("summary")) or {}
        counts = summary.get("counts") or {}
        severe = counts.get("critical", 0) + counts.get("high", 0)
        if severe:
            items.append(f"{kind.replace('_', ' ')} has {severe} high/critical open alerts")
    audit = ((report.get("codex_audit") or {}).get("audit")) or {}
    for finding in (audit.get("findings") or {}).get("high", [])[:5]:
        items.append(f"Codex audit high: {finding}")
    for workflow in report.get("workflow_results", []):
        if workflow.get("status") == "failed":
            items.append(f"{workflow['id']} failed: {(workflow.get('blockers') or ['maintenance runner failed'])[0]}")
    return items[:10]


def build_issue_body(report: dict[str, Any], previous_body: str = "") -> str:
    timestamp = report["generated_at"]
    security = report["security"]
    dependabot = security["dependabot"]["summary"]["counts"]
    code_scanning = security["code_scanning"]["summary"]["counts"]
    audit = ((report.get("codex_audit") or {}).get("audit")) or {}
    scorecard = audit.get("scorecard") or {}

    history_sections: list[str] = []
    if "## History" in previous_body:
        history_sections = previous_body.split("## History", 1)[1].strip().split("\n### ")
        if history_sections and history_sections[0]:
            history_sections[0] = history_sections[0].lstrip("# ").strip()
    new_history_entry = "\n".join(
        [
            f"### {timestamp} ({report['cadence']})",
            f"- status: {report['status']}",
            f"- workflows: {report['summary']['passed_workflows']} passed, {report['summary']['failed_workflows']} failed, {report['summary']['skipped_workflows']} skipped",
            f"- dependabot high/critical: {dependabot.get('high', 0) + dependabot.get('critical', 0)}",
            f"- code scanning high/critical: {code_scanning.get('high', 0) + code_scanning.get('critical', 0)}",
        ]
    )
    prior_entries = [entry for entry in history_sections if entry.strip()]
    history = [new_history_entry] + [f"### {entry}" if not entry.startswith("### ") else entry for entry in prior_entries[:9]]

    workflow_lines = []
    for workflow in report["workflow_results"]:
        line = f"- `{workflow['id']}`: {workflow['status']}"
        if workflow.get("skip_reason"):
            line += f" ({workflow['skip_reason']})"
        workflow_lines.append(line)

    remediation = remediation_items(report)
    remediation_lines = remediation or ["- none"]

    return "\n".join(
        [
            "<!-- codex-maintenance-radar -->",
            "# Codex Maintenance Radar",
            "",
            "## Latest",
            f"- generated_at: `{timestamp}`",
            f"- cadence: `{report['cadence']}`",
            f"- status: `{report['status']}`",
            "",
            "## Security",
            f"- Dependabot: critical={dependabot.get('critical', 0)}, high={dependabot.get('high', 0)}, medium={dependabot.get('medium', 0)}, low={dependabot.get('low', 0)}",
            f"- Code scanning: critical={code_scanning.get('critical', 0)}, high={code_scanning.get('high', 0)}, medium={code_scanning.get('medium', 0)}, low={code_scanning.get('low', 0)}",
            "",
            "## Codex Audit",
            f"- status: `{audit.get('status', 'unknown')}`",
            f"- scorecard: coverage={scorecard.get('coverage', 'n/a')}, routing={scorecard.get('routing_integrity', 'n/a')}, verification={scorecard.get('verification_integrity', 'n/a')}, onboarding={scorecard.get('onboarding_readiness', 'n/a')}",
            "",
            "## Workflow Results",
            *workflow_lines,
            "",
            "## Top Remediation Items",
            *remediation_lines,
            "",
            "## History",
            *history,
        ]
    )


def upsert_issue(repo: str, report: dict[str, Any]) -> OrderedDict[str, Any]:
    issue_list = subprocess.run(
        [
            "gh",
            "issue",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--search",
            f'"{ISSUE_TITLE}" in:title',
            "--json",
            "number,title,body,url",
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if issue_list.returncode != 0:
        raise RuntimeError(issue_list.stderr.strip() or "failed to list maintenance issues")
    existing = json.loads(issue_list.stdout)
    previous_body = existing[0]["body"] if existing else ""
    body = build_issue_body(report, previous_body=previous_body)
    if existing:
        number = str(existing[0]["number"])
        edit = subprocess.run(
            ["gh", "issue", "edit", number, "--repo", repo, "--body-file", "-"],
            cwd=REPO_ROOT,
            text=True,
            input=body,
            capture_output=True,
            check=False,
        )
        if edit.returncode != 0:
            raise RuntimeError(edit.stderr.strip() or "failed to update maintenance issue")
        return OrderedDict(action="updated", number=existing[0]["number"], url=existing[0]["url"])
    create = subprocess.run(
        ["gh", "issue", "create", "--repo", repo, "--title", ISSUE_TITLE, "--body-file", "-"],
        cwd=REPO_ROOT,
        text=True,
        input=body,
        capture_output=True,
        check=False,
    )
    if create.returncode != 0:
        raise RuntimeError(create.stderr.strip() or "failed to create maintenance issue")
    return OrderedDict(action="created", number=None, url=create.stdout.strip())


def run_maintenance(cadence: str, *, artifacts_dir: Path | None = None, update_issue_enabled: bool = True) -> OrderedDict[str, Any]:
    repo = resolve_repo()
    workflows = [
        workflow
        for workflow in load_workflows()
        if workflow.get("scheduled_safe") is True and workflow.get("maintenance_cadence") == cadence
    ]
    workflow_results = [run_workflow_maintenance(workflow, artifacts_dir=artifacts_dir) for workflow in workflows]
    security_dir = artifacts_dir / "security" if artifacts_dir is not None else None
    security = OrderedDict(
        dependabot=fetch_alert_snapshot(
            "dependabot",
            repo,
            threshold="high" if cadence == "daily" else "none",
            artifacts_dir=security_dir,
        ),
        code_scanning=fetch_alert_snapshot(
            "code-scanning",
            repo,
            threshold="high" if cadence == "daily" else "none",
            artifacts_dir=security_dir,
        ),
    )
    audit_dir = artifacts_dir / "codex-audit" if artifacts_dir is not None else None
    codex_audit = run_codex_audit(artifacts_dir=audit_dir)

    failed_workflows = sum(1 for item in workflow_results if item["status"] == "failed")
    skipped_workflows = sum(1 for item in workflow_results if item["status"] == "skipped")
    passed_workflows = sum(1 for item in workflow_results if item["status"] == "passed")

    status = "ok"
    if failed_workflows:
        status = "failed"
    if cadence == "daily" and (
        security["dependabot"]["status"] == "failed" or security["code_scanning"]["status"] == "failed"
    ):
        status = "failed"
    if cadence in {"daily", "weekly"}:
        audit_payload = (codex_audit.get("audit") or {})
        if (audit_payload.get("findings") or {}).get("high"):
            status = "failed"

    report = OrderedDict(
        version=1,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"),
        repository=repo,
        cadence=cadence,
        status=status,
        workflow_results=workflow_results,
        security=OrderedDict(
            dependabot=security["dependabot"],
            code_scanning=security["code_scanning"],
        ),
        codex_audit=codex_audit,
        summary=OrderedDict(
            selected_workflows=[workflow["id"] for workflow in workflows],
            passed_workflows=passed_workflows,
            failed_workflows=failed_workflows,
            skipped_workflows=skipped_workflows,
        ),
    )

    if update_issue_enabled:
        report["maintenance_issue"] = upsert_issue(repo, report)

    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Codex maintenance workflows and security posture snapshots.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="run a maintenance cadence")
    run_parser.add_argument("--cadence", choices=sorted(CADENCES - {"manual"}), required=True)
    run_parser.add_argument("--report-file", help="write the JSON report to this path")
    run_parser.add_argument("--artifacts-dir", help="write logs and snapshots into this directory")
    run_parser.add_argument("--no-issue-update", action="store_true", help="skip the rolling issue update")
    run_parser.add_argument("--json", action="store_true", help="emit JSON")
    run_parser.add_argument("--text", action="store_true", help="emit concise text")

    snapshot_parser = subparsers.add_parser("snapshot-alerts", help="snapshot GitHub alert surfaces")
    snapshot_parser.add_argument("--kind", choices=["dependabot", "code-scanning"], required=True)
    snapshot_parser.add_argument("--severity-threshold", choices=["none", "high", "critical"], default="none")
    snapshot_parser.add_argument("--output", help="write JSON output to this path")
    snapshot_parser.add_argument("--json", action="store_true", help="emit JSON")
    snapshot_parser.add_argument("--text", action="store_true", help="emit concise text")

    return parser.parse_args()


def render_text(report: dict[str, Any]) -> str:
    if report.get("kind"):
        counts = report["summary"]["counts"]
        return (
            f"{report['kind']} alerts: total={report['summary']['total']}, "
            f"critical={counts.get('critical', 0)}, high={counts.get('high', 0)}, "
            f"medium={counts.get('medium', 0)}, low={counts.get('low', 0)}"
        )
    lines = [
        f"Codex maintenance ({report['cadence']}): {report['status']}",
        f"Workflows: passed={report['summary']['passed_workflows']}, failed={report['summary']['failed_workflows']}, skipped={report['summary']['skipped_workflows']}",
    ]
    for workflow in report["workflow_results"]:
        line = f"- {workflow['id']}: {workflow['status']}"
        if workflow.get("skip_reason"):
            line += f" ({workflow['skip_reason']})"
        lines.append(line)
    dependabot = report["security"]["dependabot"]["summary"]["counts"]
    code_scanning = report["security"]["code_scanning"]["summary"]["counts"]
    lines.append(
        "Security: "
        f"dependabot high/critical={dependabot.get('high', 0) + dependabot.get('critical', 0)}, "
        f"code-scanning high/critical={code_scanning.get('high', 0) + code_scanning.get('critical', 0)}"
    )
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    if args.command == "snapshot-alerts":
        payload = fetch_alert_snapshot(
            args.kind,
            resolve_repo(),
            threshold=args.severity_threshold,
        )
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        if args.text:
            print(render_text(payload))
        else:
            print(json.dumps(payload, indent=2))
        return 1 if payload["status"] == "failed" else 0

    artifacts_dir = Path(args.artifacts_dir) if args.artifacts_dir else None
    report = run_maintenance(
        args.cadence,
        artifacts_dir=artifacts_dir,
        update_issue_enabled=not args.no_issue_update,
    )
    if args.report_file:
        report_path = Path(args.report_file)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.text:
        print(render_text(report))
    else:
        print(json.dumps(report, indent=2))
    return 1 if report["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
